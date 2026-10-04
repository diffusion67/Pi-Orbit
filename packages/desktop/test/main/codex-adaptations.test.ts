import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DesktopAppService } from "../../src/main/app-service.ts";
import type { WorkerTransport } from "../../src/main/worker-manager.ts";
import type { DesktopSession, DesktopSessionQueue } from "../../src/shared/desktop-types.ts";

const execFileAsync = promisify(execFile);
type Request = { id: string; type: string; payload: Record<string, unknown> };

class Worker implements WorkerTransport {
	private receive: (message: unknown) => void = () => {};
	private exited: (code: number) => void = () => {};
	private sessionId: string = randomUUID();
	readonly requests: Request[] = [];
	confirmToolCalls = true;
	mode: "build" | "plan" = "build";
	queue: DesktopSessionQueue = { steering: ["next"], followUp: ["later"], pendingCount: 2 };
	holdInit = false;
	holdPrompt = false;
	failPolicy = false;
	emitStateOnShutdown = false;
	settleOnPrompt = false;
	initRequest?: Request;
	onMessage(listener: (message: unknown) => void): void {
		this.receive = listener;
	}
	onExit(listener: (code: number) => void): void {
		this.exited = listener;
	}
	kill(): void {
		this.exited(0);
	}
	emit(event: unknown): void {
		this.receive({ type: "event", event });
	}
	postMessage(value: unknown): void {
		const request = value as Request;
		this.requests.push(request);
		const { id, type, payload } = request;
		if (type === "init") {
			this.initRequest = request;
			if (this.holdInit) return;
			if (typeof payload.sessionId === "string") this.sessionId = payload.sessionId;
			this.confirmToolCalls = payload.confirmToolCalls !== false;
			this.mode = payload.toolMode === "plan" ? "plan" : "build";
		}
		if (type === "tool.policy.set") {
			if (this.failPolicy) {
				this.failPolicy = false;
				this.receive({ id, ok: false, error: { code: "POLICY_FAILED", message: "policy failed" } });
				return;
			}
			if (typeof payload.confirmToolCalls === "boolean") this.confirmToolCalls = payload.confirmToolCalls;
			if (payload.mode === "plan" || payload.mode === "build") this.mode = payload.mode;
		}
		let data: unknown = {};
		if (type === "init" || type === "history")
			data = {
				sessionId: this.sessionId,
				sessionFile: join(tmpdir(), `adaptation-${this.sessionId}.jsonl`),
				model: null,
				messages: [],
				toolPolicy: { confirmToolCalls: this.confirmToolCalls, mode: this.mode },
			};
		if (type === "model.list") data = [];
		if (type === "resources.list") data = { skills: [], templates: [], commands: [], extensions: [] };
		if (type === "stats.get") data = { sessionId: this.sessionId };
		if (type.startsWith("tool.policy.")) data = { confirmToolCalls: this.confirmToolCalls, mode: this.mode };
		if (type === "queue.get") data = this.queue;
		if (type === "queue.clear") {
			data = { ...this.queue, pendingCount: 0 };
			this.queue = { steering: [], followUp: [], pendingCount: 0 };
			this.emit({ type: "queue.update", ...this.queue });
		}
		if (type === "prompt") {
			if (this.holdPrompt) return;
			if (this.settleOnPrompt) this.emit({ type: "state", state: "idle", runId: payload.runId });
			data = { accepted: true };
		}
		if (type === "message") data = { accepted: true, delivery: payload.deliverAs, disposition: "queued" };
		if (type === "tree.navigate") {
			this.mode = "build";
			data = { cancelled: false };
		}
		if (type === "shutdown" && this.emitStateOnShutdown) {
			this.emit({ type: "state", state: "streaming" });
			this.emit({ type: "queue.update", ...this.queue });
		}
		this.receive({ id, ok: true, data });
	}
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-orbit-adaptations-"));
	const projectPath = join(root, "project");
	await mkdir(projectPath);
	await execFileAsync("git", ["-C", projectPath, "init", "-b", "main"]);
	await execFileAsync("git", ["-C", projectPath, "config", "user.name", "Orbit test"]);
	await execFileAsync("git", ["-C", projectPath, "config", "user.email", "test@example.invalid"]);
	await execFileAsync("git", ["-C", projectPath, "config", "core.autocrlf", "false"]);
	await writeFile(join(projectPath, "file.txt"), "before\n");
	await execFileAsync("git", ["-C", projectPath, "add", "--", "file.txt"]);
	await execFileAsync("git", ["-C", projectPath, "commit", "-m", "fixture"]);
	const workers: Worker[] = [];
	let nextWorker: ((worker: Worker) => void) | undefined;
	const service = await DesktopAppService.open({
		dataDirectory: join(root, "data"),
		agentDirectory: join(root, "agent"),
		createWorkerTransport: () => {
			const worker = new Worker();
			nextWorker?.(worker);
			nextWorker = undefined;
			workers.push(worker);
			return worker;
		},
	});
	const opened = await service.invoke("project.open", { path: projectPath });
	assert.ok(opened.ok);
	const projectId = (opened.data as { id: string }).id;
	return {
		root,
		service,
		workers,
		projectId,
		projectPath,
		configureNext: (configure: (worker: Worker) => void) => {
			nextWorker = configure;
		},
		cleanup: async () => {
			await service.close();
			await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
		},
	};
}

async function newSession(service: DesktopAppService, projectId: string): Promise<DesktopSession> {
	const created = await service.invoke("session.create", { projectId });
	assert.ok(created.ok);
	return created.data as DesktopSession;
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("State did not settle");
}

test("archives and restores a session without deleting or selecting it", async () => {
	const f = await fixture();
	try {
		const session = await newSession(f.service, f.projectId);
		assert.ok((await f.service.invoke("session.policy.get", { sessionId: session.id })).ok);
		f.workers.at(-1)!.emitStateOnShutdown = true;
		assert.deepEqual(await f.service.invoke("session.archive", { sessionId: session.id }), {
			ok: true,
			data: { archived: true },
		});
		const snapshot = await f.service.snapshot();
		assert.equal(snapshot.activeSessionId, undefined);
		assert.equal(snapshot.sessions[0]?.archived, true);
		assert.equal(snapshot.sessions[0]?.status, "idle");
		assert.equal(snapshot.sessionQueues?.[session.id], undefined);
		const select = await f.service.invoke("session.select", { sessionId: session.id });
		assert.ok(!select.ok && select.code === "SESSION_ARCHIVED");
		assert.deepEqual(await f.service.invoke("session.restore", { sessionId: session.id }), {
			ok: true,
			data: { archived: false },
		});
		assert.equal((await f.service.snapshot()).activeSessionId, undefined);
		assert.ok((await f.service.invoke("session.select", { sessionId: session.id })).ok);
	} finally {
		await f.cleanup();
	}
});

test("fences stale settlement and retains an immediate settlement before prompt acknowledgement", async () => {
	const f = await fixture();
	try {
		const session = await newSession(f.service, f.projectId);
		f.configureNext((worker) => {
			worker.settleOnPrompt = true;
		});
		assert.ok((await f.service.invoke("session.prompt", { sessionId: session.id, text: "first" })).ok);
		await eventually(async () => (await f.service.snapshot()).sessions[0]?.status === "idle");
		const worker = f.workers.at(-1)!;
		const previousRunId = worker.requests.findLast((request) => request.type === "prompt")?.payload.runId;
		worker.settleOnPrompt = false;
		assert.ok((await f.service.invoke("session.prompt", { sessionId: session.id, text: "second" })).ok);
		worker.emit({ type: "state", state: "idle", runId: previousRunId });
		await f.service.invoke("app.snapshot", undefined);
		assert.equal((await f.service.snapshot()).sessions[0]?.status, "running");
		assert.ok(
			(await f.service.invoke("session.message", { sessionId: session.id, text: "adjust", deliverAs: "steer" })).ok,
		);
		assert.equal(
			worker.requests.at(-1)?.payload.expectedRunId,
			worker.requests.findLast((request) => request.type === "prompt")?.payload.runId,
		);
		const archived = await f.service.invoke("session.archive", { sessionId: session.id });
		assert.ok(!archived.ok && archived.code === "SESSION_BUSY");
	} finally {
		await f.cleanup();
	}
});

test("coalesces concurrent first-use worker initialization", async () => {
	const f = await fixture();
	try {
		const session = await newSession(f.service, f.projectId);
		f.configureNext((worker) => {
			worker.holdInit = true;
		});
		const first = f.service.invoke("session.stats", { sessionId: session.id });
		const second = f.service.invoke("session.stats", { sessionId: session.id });
		await eventually(async () => f.workers.length === 2 && Boolean(f.workers.at(-1)?.initRequest));
		const worker = f.workers.at(-1)!;
		worker.holdInit = false;
		worker.postMessage(worker.initRequest);
		assert.ok((await first).ok);
		assert.ok((await second).ok);
		assert.equal(f.workers.length, 2);
	} finally {
		await f.cleanup();
	}
});

test("applies confirmation immediately and restores an empty session's selected mode", async () => {
	const f = await fixture();
	try {
		const session = await newSession(f.service, f.projectId);
		assert.ok((await f.service.invoke("session.policy.set", { sessionId: session.id, mode: "plan" })).ok);
		const worker = f.workers.at(-1)!;
		assert.ok(
			(
				await f.service.invoke("settings.save", {
					...(
						await f.service.snapshot()
					).settings,
					confirmToolCalls: false,
				})
			).ok,
		);
		assert.equal(worker.confirmToolCalls, false);
		assert.ok((await f.service.invoke("session.archive", { sessionId: session.id })).ok);
		assert.ok((await f.service.invoke("session.restore", { sessionId: session.id })).ok);
		assert.deepEqual(await f.service.invoke("session.policy.get", { sessionId: session.id }), {
			ok: true,
			data: { confirmToolCalls: false, mode: "plan" },
		});
	} finally {
		await f.cleanup();
	}
});

test("shows queues and returns cleared text while publishing an empty queue", async () => {
	const f = await fixture();
	try {
		const session = await newSession(f.service, f.projectId);
		assert.ok((await f.service.invoke("session.queue.get", { sessionId: session.id })).ok);
		assert.equal((await f.service.snapshot()).sessionQueues?.[session.id]?.pendingCount, 2);
		const cleared = await f.service.invoke("session.queue.clear", { sessionId: session.id });
		assert.deepEqual(cleared, { ok: true, data: { steering: ["next"], followUp: ["later"], pendingCount: 0 } });
		await eventually(async () => (await f.service.snapshot()).sessionQueues?.[session.id]?.pendingCount === 0);
	} finally {
		await f.cleanup();
	}
});

test("preserves the navigated branch policy through worker restart", async () => {
	const f = await fixture();
	try {
		const session = await newSession(f.service, f.projectId);
		assert.ok((await f.service.invoke("session.policy.set", { sessionId: session.id, mode: "plan" })).ok);
		assert.ok((await f.service.invoke("session.navigate", { sessionId: session.id, entryId: "build-branch" })).ok);
		assert.ok((await f.service.invoke("session.archive", { sessionId: session.id })).ok);
		assert.ok((await f.service.invoke("session.restore", { sessionId: session.id })).ok);
		assert.deepEqual(await f.service.invoke("session.policy.get", { sessionId: session.id }), {
			ok: true,
			data: { confirmToolCalls: true, mode: "build" },
		});
	} finally {
		await f.cleanup();
	}
});

test("rolls back confirmation settings when a worker rejects the update", async () => {
	const f = await fixture();
	try {
		const session = await newSession(f.service, f.projectId);
		assert.ok((await f.service.invoke("session.policy.get", { sessionId: session.id })).ok);
		f.workers.at(-1)!.failPolicy = true;
		const saved = await f.service.invoke("settings.save", {
			...(await f.service.snapshot()).settings,
			confirmToolCalls: false,
		});
		assert.ok(!saved.ok && saved.code === "POLICY_FAILED");
		assert.equal((await f.service.snapshot()).settings.confirmToolCalls, true);
		assert.equal(f.workers.at(-1)?.confirmToolCalls, true);
	} finally {
		await f.cleanup();
	}
});

test("does not stop a prompt admitted while a subagent toggle is waiting", async () => {
	const f = await fixture();
	try {
		const session = await newSession(f.service, f.projectId);
		f.configureNext((worker) => {
			worker.holdPrompt = true;
		});
		const sending = f.service.invoke("session.prompt", { sessionId: session.id, text: "work" });
		await eventually(
			async () => f.workers.length === 2 && f.workers.at(-1)!.requests.some((request) => request.type === "prompt"),
		);
		const worker = f.workers.at(-1)!;
		const saving = f.service.invoke("settings.save", {
			...(await f.service.snapshot()).settings,
			subagentsEnabled: true,
		});
		worker.holdPrompt = false;
		worker.postMessage(worker.requests.findLast((request) => request.type === "prompt"));
		assert.ok((await sending).ok);
		const saved = await saving;
		assert.ok(!saved.ok && saved.code === "SESSION_BUSY");
		assert.equal(
			worker.requests.some((request) => request.type === "shutdown"),
			false,
		);
		assert.equal((await f.service.snapshot()).sessions[0]?.status, "running");
	} finally {
		await f.cleanup();
	}
});

test("cancels a task waiting for initialization and captures its partial changes", async () => {
	const f = await fixture();
	try {
		assert.ok(
			(await f.service.invoke("settings.save", { ...(await f.service.snapshot()).settings, subagentsEnabled: true }))
				.ok,
		);
		assert.ok(
			(
				await f.service.invoke("role.save", {
					id: "user:coder",
					name: "Coder",
					description: "",
					systemPrompt: "Work",
					model: "",
					tools: [],
					scope: "user",
				})
			).ok,
		);
		f.configureNext((worker) => {
			worker.holdInit = true;
		});
		const starting = f.service.invoke("task.create", {
			projectId: f.projectId,
			roleId: "user:coder",
			prompt: "work",
			dependsOn: [],
		});
		await eventually(async () => Boolean(f.workers.at(-1)?.initRequest));
		const task = (await f.service.snapshot()).tasks[0]!;
		assert.ok(task.worktreePath);
		await writeFile(join(task.worktreePath, "file.txt"), "partial\n");
		const cancellation = await Promise.race([
			f.service.invoke("task.cancel", { taskId: task.id }),
			new Promise<never>((_, reject) => {
				const timer = setTimeout(() => reject(new Error("Cancel remained blocked by init")), 3000);
				timer.unref();
			}),
		]);
		assert.ok(cancellation.ok);
		assert.ok((await starting).ok);
		const cancelled = (await f.service.snapshot()).tasks[0]!;
		assert.equal(cancelled.status, "cancelled");
		assert.equal(cancelled.changes[0]?.path, "file.txt");
		assert.match(cancelled.changes[0]?.diff ?? "", /partial/);
	} finally {
		await f.cleanup();
	}
});

test("reads project working tree differences through the desktop command", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.projectPath, "file.txt"), "after\n");
		const result = await f.service.invoke("project.changes", { projectId: f.projectId });
		assert.ok(result.ok);
		assert.match((result.data as { changes: { diff: string }[] }).changes[0]?.diff ?? "", /after/);
	} finally {
		await f.cleanup();
	}
});
