import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DesktopAppService } from "../../src/main/app-service.ts";
import type { WorkerTransport } from "../../src/main/worker-manager.ts";
import type { DesktopEvent } from "../../src/shared/desktop-types.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

class FakeWorker implements WorkerTransport {
	private messageListener?: (message: unknown) => void;
	private exitListener?: (code: number) => void;
	readonly id = randomUUID();
	readonly requests: Array<{ type: string; payload: unknown }> = [];
	historyMessages: unknown[] = [];
	mcpServers: unknown[] = [];
	failNextMcpAction?: { readonly type: string; readonly message: string };
	forkedFrom?: string;
	failNextPrompt = false;
	ignoreKill = false;
	private sessionId: string = this.id;

	onMessage(listener: (message: unknown) => void): void {
		this.messageListener = listener;
	}
	onExit(listener: (code: number) => void): void {
		this.exitListener = listener;
	}
	postMessage(message: unknown): void {
		if (!message || typeof message !== "object" || !("id" in message) || !("type" in message)) return;
		const id = String(message.id);
		const type = String(message.type);
		const payload =
			"payload" in message && message.payload && typeof message.payload === "object" ? message.payload : undefined;
		this.requests.push({ type, payload });
		if (type === "prompt" && this.failNextPrompt) {
			this.failNextPrompt = false;
			this.messageListener?.({ id, ok: false, error: { code: "PROMPT_FAILED", message: "prompt failed" } });
			return;
		}
		if (type.startsWith("mcp.")) {
			if (this.failNextMcpAction?.type === type) {
				const failure = this.failNextMcpAction;
				this.failNextMcpAction = undefined;
				this.messageListener?.({ id, ok: false, error: { code: "OPERATION_FAILED", message: failure.message } });
				return;
			}
			const data = type === "mcp.list" ? this.mcpServers : type === "mcp.reload" ? { reloaded: true } : { ok: true };
			this.messageListener?.({ id, ok: true, data });
			return;
		}
		const sessionFile =
			payload && "sessionFile" in payload && typeof payload.sessionFile === "string"
				? payload.sessionFile
				: undefined;
		if (type === "init" && sessionFile) {
			const match = /pi-orbit-([a-f0-9-]+)\.jsonl$/i.exec(sessionFile);
			if (match) this.sessionId = match[1];
		}
		if (type === "init" && payload && "sessionId" in payload && typeof payload.sessionId === "string") {
			this.sessionId = payload.sessionId;
		}
		const session = {
			sessionId: this.sessionId,
			sessionFile: join(tmpdir(), `pi-orbit-${this.sessionId}.jsonl`),
			model: null,
			messages: this.historyMessages,
		};
		if (type === "fork" && payload && "entryId" in payload && typeof payload.entryId === "string")
			this.forkedFrom = payload.entryId;
		const forkedSessionId = randomUUID();
		const data =
			type === "init" || type === "history"
				? session
				: type === "fork"
					? {
							cancelled: false,
							sessionId: forkedSessionId,
							sessionFile: join(tmpdir(), `pi-orbit-${forkedSessionId}.jsonl`),
							model: null,
						}
					: type === "model.list"
						? []
						: type === "resources.list"
							? { skills: [], templates: [], commands: [], extensions: [] }
							: type === "prompt" || type === "message"
								? { accepted: true }
								: { closing: true };
		this.messageListener?.({ id, ok: true, data });
	}
	kill(): void {
		if (!this.ignoreKill) this.exitListener?.(0);
	}
	exit(code = 1): void {
		this.exitListener?.(code);
	}
	emit(event: unknown): void {
		this.messageListener?.({ type: "event", event });
	}
}

async function repository(): Promise<{
	root: string;
	projectPath: string;
	agentDirectory: string;
	dataDirectory: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-orbit-service-test-"));
	temporaryRoots.push(root);
	const projectPath = join(root, "project");
	const agentDirectory = join(root, "pi");
	const dataDirectory = join(root, "data");
	await mkdir(projectPath);
	await execFileAsync("git", ["-C", projectPath, "init", "-b", "main"]);
	await execFileAsync("git", ["-C", projectPath, "config", "user.name", "Pi Orbit Test"]);
	await execFileAsync("git", ["-C", projectPath, "config", "user.email", "pi-orbit@example.invalid"]);
	await execFileAsync("git", ["-C", projectPath, "config", "core.autocrlf", "false"]);
	await writeFile(join(projectPath, "file.txt"), "before\n");
	await execFileAsync("git", ["-C", projectPath, "add", "--", "file.txt"]);
	await execFileAsync("git", ["-C", projectPath, "commit", "-m", "initial"]);
	return { root, projectPath, agentDirectory, dataDirectory };
}

async function settled<T>(load: () => Promise<T>, check: (value: T) => boolean, attempts = 100): Promise<T> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const result = await load();
		if (check(result)) return result;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for a worker event");
}

afterEach(async () => {
	for (const root of temporaryRoots.splice(0))
		await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});

describe("desktop app service", () => {
	it("validates session names and restores renames after restart", async () => {
		const paths = await repository();
		const options = {
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => new FakeWorker(),
		};
		let service = await DesktopAppService.open(options);
		try {
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const created = await service.invoke("session.create", { projectId: (opened.data as { id: string }).id });
			assert.equal(created.ok, true);
			if (!created.ok) return;
			const sessionId = (created.data as { id: string }).id;
			for (const title of ["", "   ", "x".repeat(201), "bad\nname", "bad\u0000name"]) {
				const result = await service.invoke("session.rename", { sessionId, title });
				assert.equal(result.ok, false);
				if (!result.ok) assert.equal(result.code, "INVALID_ARGUMENT");
			}
			assert.equal((await service.invoke("session.rename", { sessionId, title: "  发布计划  " })).ok, true);
			await service.close();
			service = await DesktopAppService.open(options);
			assert.equal(
				(await service.snapshot()).sessions.find((session) => session.id === sessionId)?.title,
				"发布计划",
			);
			const missing = await service.invoke("session.rename", { sessionId: "missing", title: "valid" });
			assert.equal(missing.ok, false);
			if (!missing.ok) assert.equal(missing.code, "SESSION_NOT_FOUND");
		} finally {
			await service.close();
		}
	});

	it("does not replace the active transcript when an earlier session selection finishes late", async () => {
		const paths = await repository();
		const workers: FakeWorker[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
		});
		try {
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const projectId = (opened.data as { id: string }).id;
			const first = await service.invoke("session.create", { projectId });
			assert.equal(first.ok, true);
			if (!first.ok) return;
			const firstId = (first.data as { id: string }).id;
			assert.equal((await service.invoke("session.select", { sessionId: firstId })).ok, true);
			const firstWorker = workers.at(-1)!;
			firstWorker.historyMessages = [{ type: "message", entryId: "first", role: "user", text: "first session" }];
			const second = await service.invoke("session.create", { projectId });
			assert.equal(second.ok, true);
			if (!second.ok) return;
			const secondId = (second.data as { id: string }).id;
			assert.equal((await service.invoke("session.select", { sessionId: secondId })).ok, true);
			workers.at(-1)!.historyMessages = [
				{ type: "message", entryId: "second", role: "user", text: "second session" },
			];
			let releaseHistory: (() => void) | undefined;
			const postMessage = firstWorker.postMessage.bind(firstWorker);
			firstWorker.postMessage = (request) => {
				if (request && typeof request === "object" && "type" in request && request.type === "history")
					releaseHistory = () => postMessage(request);
				else postMessage(request);
			};
			const slowSelection = service.invoke("session.select", { sessionId: firstId });
			await settled(
				async () => releaseHistory,
				(release) => release !== undefined,
			);
			assert.equal((await service.invoke("session.select", { sessionId: secondId })).ok, true);
			releaseHistory!();
			assert.equal((await slowSelection).ok, true);
			const snapshot = await service.snapshot();
			assert.equal(snapshot.activeSessionId, secondId);
			assert.deepEqual(
				snapshot.messages.map((message) => message.id),
				["second"],
			);
			assert.equal((await service.invoke("project.open", { path: paths.projectPath })).ok, true);
			assert.deepEqual(
				(await service.snapshot()).messages.map((message) => message.id),
				["second"],
			);
		} finally {
			await service.close();
		}
	});

	it("validates named commands and reconnects from a durable event sequence", async () => {
		const paths = await repository();
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => new FakeWorker(),
		});
		try {
			assert.deepEqual(await service.invoke("project.open", { path: 42 }), {
				ok: false,
				code: "INVALID_ARGUMENT",
				message: "Invalid command or request payload",
			});
			assert.deepEqual(await service.invoke("app.quit", undefined), { ok: true, data: { closing: true } });
			const before = await service.snapshot();
			assert.ok(before.providers.some((provider) => provider.id === "anthropic"));
			assert.deepEqual(
				await service.invoke("auth.configure", {
					providerId: "anthropic",
					credential: "local-test-credential",
				}),
				{ ok: true, data: { configured: true } },
			);
			assert.equal(
				(await service.snapshot()).providers.find((provider) => provider.id === "anthropic")?.configured,
				true,
			);
			const live: number[] = [];
			const unsubscribe = await service.subscribe(before.lastEventSeq, (event) => live.push(event.seq));
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			assert.ok(live.length > 0);
			unsubscribe();
			const replayed: number[] = [];
			(await service.subscribe(before.lastEventSeq, (event) => replayed.push(event.seq)))();
			assert.deepEqual(replayed, live);
			assert.ok(replayed.every((seq, index) => index === 0 || seq > replayed[index - 1]));
		} finally {
			await service.close();
		}
	});

	it("validates and persists language and send shortcut preferences while reading legacy settings", async () => {
		const paths = await repository();
		const expected = {
			language: "zh-CN",
			theme: "dark",
			defaultModel: "orbit-smoke/smoke",
			confirmToolCalls: false,
			sendShortcut: "ctrlEnter",
		};
		const createService = () =>
			DesktopAppService.open({
				dataDirectory: paths.dataDirectory,
				agentDirectory: paths.agentDirectory,
				createWorkerTransport: () => new FakeWorker(),
			});
		let service = await createService();
		try {
			assert.deepEqual((await service.snapshot()).settings, {
				language: "en",
				theme: "system",
				defaultModel: "",
				confirmToolCalls: true,
				sendShortcut: "enter",
			});
			assert.deepEqual(await service.invoke("settings.save", { ...expected, language: "fr" }), {
				ok: false,
				code: "INVALID_ARGUMENT",
				message: "Invalid command or request payload",
			});
			assert.deepEqual(await service.invoke("settings.save", { ...expected, sendShortcut: "altEnter" }), {
				ok: false,
				code: "INVALID_ARGUMENT",
				message: "Invalid command or request payload",
			});
			assert.deepEqual(await service.invoke("settings.save", expected), { ok: true, data: expected });
		} finally {
			await service.close();
		}

		service = await createService();
		try {
			assert.deepEqual((await service.snapshot()).settings, expected);
		} finally {
			await service.close();
		}

		const db = await openNodeSqliteDatabase(join(paths.dataDirectory, "orbit.sqlite"));
		try {
			await db.run(
				"UPDATE desktop_preferences SET value = ? WHERE key = 'settings'",
				JSON.stringify({ theme: "light", defaultModel: "legacy/model", confirmToolCalls: false }),
			);
		} finally {
			await db.close();
		}
		service = await createService();
		try {
			assert.deepEqual((await service.snapshot()).settings, {
				language: "en",
				theme: "light",
				defaultModel: "legacy/model",
				confirmToolCalls: false,
				sendShortcut: "enter",
			});
		} finally {
			await service.close();
		}
	});

	it("clears session selection across projects and restores a live session when selected again", async () => {
		const paths = await repository();
		const otherPath = join(paths.root, "other");
		await mkdir(otherPath);
		const workers: FakeWorker[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
		});
		try {
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const session = await service.invoke("session.create", { projectId: (opened.data as { id: string }).id });
			assert.equal(session.ok, true);
			if (!session.ok) return;
			const id = (session.data as { id: string }).id;
			assert.equal((await service.snapshot()).activeSessionId, id);
			assert.equal((await service.invoke("project.open", { path: otherPath })).ok, true);
			assert.equal((await service.snapshot()).activeSessionId, undefined);
			assert.equal((await service.invoke("session.select", { sessionId: id })).ok, true);
			assert.equal((await service.snapshot()).activeSessionId, id);
			workers.at(-1)?.emit({
				type: "tool",
				phase: "end",
				toolCallId: "read-1",
				toolName: "read",
				args: { path: "file.txt" },
				result: { text: "before" },
			});
			const withTool = await settled(
				() => service.snapshot(),
				(snapshot) => snapshot.messages.some((message) => message.id === "tool:read-1"),
			);
			assert.equal(withTool.messages.find((message) => message.id === "tool:read-1")?.parts[0]?.kind, "tool");
			const beforeUi = withTool.lastEventSeq;
			workers.at(-1)?.emit({ type: "ui.update", update: "status", key: "build", message: "Running" });
			workers.at(-1)?.emit({ type: "ui.update", update: "editor", mode: "replace", message: "draft" });
			workers.at(-1)?.emit({ type: "ui.update", update: "editor", mode: "append", message: " more" });
			const withUi = await settled(
				() => service.snapshot(),
				(snapshot) => snapshot.extensionUi[`session:${id}`]?.editorText === "draft more",
			);
			assert.equal(withUi.extensionUi[`session:${id}`]?.status.build, "Running");
			const replayedUi: string[] = [];
			(await service.subscribe(beforeUi, (event) => replayedUi.push(event.type)))();
			assert.equal(replayedUi.filter((type) => type === "extension.update").length, 3);
			workers.at(-1)?.emit({ type: "ui.request", requestId: "dialog-1", kind: "editor", title: "Edit" });
			workers.at(-1)?.emit({ type: "ui.dismiss", requestId: "dialog-1", reason: "timeout" });
			const dialogEvents = await settled(
				async () => {
					const events: Array<{ type: string; requestId?: string }> = [];
					(await service.subscribe(beforeUi, (event) => events.push(event)))();
					return events;
				},
				(events) => events.some((event) => event.type === "extension.dismiss"),
			);
			assert.ok(
				dialogEvents.some(
					(event) => event.type === "extension.dismiss" && event.requestId === `session:${id}:dialog-1`,
				),
			);
		} finally {
			await service.close();
		}
	});

	it("restores a long session and forks from its newest entry", async () => {
		const paths = await repository();
		const messages = Array.from({ length: 80 }, (_, index) => ({
			type: "message",
			entryId: `entry-${index}`,
			role: "user",
			text: `message ${index}`,
			parts: [{ kind: "text", text: `message ${index}` }],
		}));
		const workers: FakeWorker[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new FakeWorker();
				if (workers.length === 1) worker.historyMessages = messages;
				workers.push(worker);
				return worker;
			},
		});
		try {
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const created = await service.invoke("session.create", { projectId: (opened.data as { id: string }).id });
			assert.equal(created.ok, true);
			if (!created.ok) return;
			const sessionId = (created.data as { id: string }).id;
			assert.equal((await service.invoke("session.select", { sessionId })).ok, true);
			const snapshot = await service.snapshot();
			assert.equal(snapshot.messages.length, 80);
			assert.equal(snapshot.messages.at(-1)?.id, "entry-79");
			assert.deepEqual(snapshot.messages.at(-1)?.parts, [{ kind: "text", text: "message 79" }]);
			assert.equal((await service.invoke("session.fork", { sessionId })).ok, true);
			assert.equal(workers[1]?.forkedFrom, "entry-79");
		} finally {
			await service.close();
		}
	});

	it("persists the selected model in a new Pi session and restores it for the live worker", async () => {
		const paths = await repository();
		const workers: FakeWorker[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
		});
		try {
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			assert.equal(
				(
					await service.invoke("settings.save", {
						language: "en",
						theme: "system",
						defaultModel: "orbit-smoke/smoke",
						confirmToolCalls: true,
						sendShortcut: "enter",
					})
				).ok,
				true,
			);
			const created = await service.invoke("session.create", { projectId: (opened.data as { id: string }).id });
			assert.equal(created.ok, true);
			if (!created.ok) return;
			const session = created.data as { id: string; model: string };
			assert.equal(session.model, "orbit-smoke/smoke");
			assert.ok(
				workers[0]?.requests.some(
					(request) =>
						request.type === "init" &&
						request.payload &&
						typeof request.payload === "object" &&
						"sessionId" in request.payload &&
						request.payload.sessionId === session.id,
				),
			);
			assert.ok(
				workers[0]?.requests.some(
					(request) =>
						request.type === "model.select" &&
						request.payload &&
						typeof request.payload === "object" &&
						"provider" in request.payload &&
						request.payload.provider === "orbit-smoke" &&
						"persist" in request.payload &&
						request.payload.persist === false,
				),
			);
			assert.equal((await service.invoke("session.select", { sessionId: session.id })).ok, true);
			assert.ok(
				workers[1]?.requests.some(
					(request) =>
						request.type === "init" &&
						request.payload &&
						typeof request.payload === "object" &&
						"sessionId" in request.payload &&
						request.payload.sessionId === session.id &&
						"sessionFile" in request.payload &&
						typeof request.payload.sessionFile === "string" &&
						"model" in request.payload &&
						request.payload.model &&
						typeof request.payload.model === "object" &&
						"modelId" in request.payload.model &&
						request.payload.model.modelId === "smoke",
				),
			);
		} finally {
			await service.close();
		}
	});

	it("persists MCP status before notifying subscribers and keeps OAuth URLs transient", async () => {
		const paths = await repository();
		const workers: FakeWorker[] = [];
		const authEvents: Array<{ sessionId: string; serverName: string; url: string }> = [];
		const openedUrls: string[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
			onMcpAuthEvent: (event) => authEvents.push(event),
			openExternal: async (url) => {
				openedUrls.push(url);
			},
		});
		const db = await openNodeSqliteDatabase(join(paths.dataDirectory, "orbit.sqlite"));
		try {
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const created = await service.invoke("session.create", { projectId: (opened.data as { id: string }).id });
			assert.equal(created.ok, true);
			if (!created.ok) return;
			const sessionId = (created.data as { id: string }).id;
			assert.equal((await service.invoke("session.select", { sessionId })).ok, true);
			const worker = workers.at(-1);
			assert.ok(worker);
			worker.mcpServers = [
				{
					name: "docs",
					scope: "project",
					enabled: true,
					exposure: "deferred",
					state: "connected",
					toolCount: 2,
					resourceCount: 1,
					usesOAuth: true,
				},
			];
			const current = await service.snapshot();
			let resolveStatus!: (event: DesktopEvent) => void;
			const statusPromise = new Promise<DesktopEvent>((resolve) => {
				resolveStatus = resolve;
			});
			const unsubscribeStatus = await service.subscribe(current.lastEventSeq, (event) => {
				if (event.type === "mcp.status") resolveStatus(event);
			});
			worker.emit({ type: "mcp.status", servers: worker.mcpServers });
			const statusEvent = await statusPromise;
			assert.equal(statusEvent.type, "mcp.status");
			if (statusEvent.type !== "mcp.status") return;
			const storedStatus = await db.get<{ kind: string; payload: string }>(
				"SELECT kind, payload FROM desktop_app_events WHERE seq = ?",
				statusEvent.seq,
			);
			assert.equal(storedStatus?.kind, "mcp.status");
			assert.deepEqual(JSON.parse(storedStatus?.payload ?? "null"), {
				workerKey: `session:${sessionId}`,
				servers: worker.mcpServers,
			});
			unsubscribeStatus();

			const beforeAuth = await service.snapshot();
			const unsubscribeAuth = await service.subscribe(beforeAuth.lastEventSeq, (event) => {
				if (event.type === "mcp.status")
					assert.fail("OAuth URL must not be published as a durable MCP status event");
			});
			const originalLatest = await db.get<{ seq: number }>(
				"SELECT COALESCE(MAX(seq), 0) AS seq FROM desktop_app_events",
			);
			const originalSequence = originalLatest?.seq ?? 0;
			const authEventCount = authEvents.length;
			const openedUrlCount = openedUrls.length;
			worker.emit({ type: "mcp.auth_url", name: "docs", url: "https://example.invalid/oauth?code=secret" });
			await settled(
				async () => ({ authCount: authEvents.length, urlCount: openedUrls.length }),
				(value) => value.authCount > authEventCount && value.urlCount > openedUrlCount,
			);
			unsubscribeAuth();
			assert.deepEqual(authEvents.slice(authEventCount), [
				{ sessionId, serverName: "docs", url: "https://example.invalid/oauth?code=secret" },
			]);
			assert.deepEqual(openedUrls.slice(openedUrlCount), ["https://example.invalid/oauth?code=secret"]);
			const afterAuth = await db.get<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM desktop_app_events");
			assert.equal(afterAuth?.seq ?? 0, originalSequence);
			const durableAuthText = await db.get<{ found: number }>(
				"SELECT COUNT(*) AS found FROM desktop_app_events WHERE payload LIKE ?",
				"%code=secret%",
			);
			assert.equal(durableAuthText?.found, 0);
		} finally {
			await db.close();
			await service.close();
		}
	});

	it("routes MCP commands to the session worker and returns stable worker errors", async () => {
		const paths = await repository();
		const workers: FakeWorker[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
		});
		try {
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const created = await service.invoke("session.create", { projectId: (opened.data as { id: string }).id });
			assert.equal(created.ok, true);
			if (!created.ok) return;
			const sessionId = (created.data as { id: string }).id;
			assert.equal((await service.invoke("session.select", { sessionId })).ok, true);
			const worker = workers.at(-1);
			assert.ok(worker);
			worker.mcpServers = [
				{
					name: "docs",
					scope: "project",
					enabled: true,
					exposure: "deferred",
					state: "connected",
					toolCount: 2,
					resourceCount: 1,
					usesOAuth: false,
				},
			];
			const listed = await service.invoke("mcp.list", { sessionId });
			assert.deepEqual(listed, { ok: true, data: worker.mcpServers });
			assert.deepEqual((await service.snapshot()).mcpServers, worker.mcpServers);
			assert.deepEqual(await service.invoke("mcp.reconnect", { sessionId, name: "docs" }), {
				ok: true,
				data: {},
			});
			assert.ok(worker.requests.some((request) => request.type === "mcp.reconnect"));
			assert.deepEqual(await service.invoke("mcp.reload", { sessionId }), {
				ok: true,
				data: { reloaded: true },
			});
			assert.ok(worker.requests.some((request) => request.type === "mcp.reload"));
			worker.failNextMcpAction = { type: "mcp.sign-out", message: "MCP action failed" };
			assert.deepEqual(await service.invoke("mcp.sign-out", { sessionId, name: "docs" }), {
				ok: false,
				code: "OPERATION_FAILED",
				message: "MCP action failed",
			});
			assert.deepEqual(await service.invoke("mcp.reconnect", { sessionId, name: 42 }), {
				ok: false,
				code: "INVALID_ARGUMENT",
				message: "Invalid command or request payload",
			});
		} finally {
			await service.close();
		}
	});

	it("creates writable tasks with project roles while still blocking unrelated local changes", async () => {
		const paths = await repository();
		const workers: FakeWorker[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
		});
		try {
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const projectId = (opened.data as { id: string }).id;
			const role = await service.invoke("role.save", {
				id: "new",
				name: "Project reviewer",
				description: "Reviews project changes",
				systemPrompt: "Review the project changes carefully.",
				model: "",
				tools: ["read", "write"],
				scope: "project",
			});
			assert.equal(role.ok, true);

			const created = await service.invoke("task.create", {
				projectId,
				roleId: "project:project-reviewer",
				prompt: "Review the changes",
				dependsOn: [],
			});
			assert.equal(created.ok, true);
			if (!created.ok) return;
			const task = created.data as { worktreePath: string };
			const init = workers.at(-1)?.requests.find((request) => request.type === "init")?.payload;
			assert.ok(init && typeof init === "object");
			assert.equal("cwd" in init ? init.cwd : undefined, task.worktreePath);
			assert.equal("systemPrompt" in init ? init.systemPrompt : undefined, "Review the project changes carefully.");
			assert.deepEqual("tools" in init ? init.tools : undefined, ["read", "write"]);

			await writeFile(join(paths.projectPath, "unrelated.txt"), "local work\n");
			const rejected = await service.invoke("task.create", {
				projectId,
				roleId: "project:project-reviewer",
				prompt: "Review the changes",
				dependsOn: [],
			});
			assert.equal(rejected.ok, false);
			if (!rejected.ok) assert.equal(rejected.code, "WORKSPACE_DIRTY");
		} finally {
			await service.close();
		}
	});

	it("creates tasks for project roles when the opened project is inside a Git repository", async () => {
		const paths = await repository();
		const nestedProjectPath = join(paths.projectPath, "nested");
		await mkdir(nestedProjectPath);
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => new FakeWorker(),
		});
		try {
			const opened = await service.invoke("project.open", { path: nestedProjectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const projectId = (opened.data as { id: string }).id;
			const role = await service.invoke("role.save", {
				id: "new",
				name: "Nested reviewer",
				description: "Reviews nested projects",
				systemPrompt: "Review the nested project.",
				model: "",
				tools: ["read"],
				scope: "project",
			});
			assert.equal(role.ok, true);
			const created = await service.invoke("task.create", {
				projectId,
				roleId: "project:nested-reviewer",
				prompt: "Review nested changes",
				dependsOn: [],
			});
			assert.equal(created.ok, true);
		} finally {
			await service.close();
		}
	});

	it("runs a child in a clean worktree, persists completion, and merges as an uncommitted change", async () => {
		const paths = await repository();
		let mergedTaskId: string | undefined;
		const workers: FakeWorker[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
		});
		try {
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const project = opened.data as { id: string };
			const role = await service.invoke("role.save", {
				id: "user:coder",
				name: "Coder",
				description: "Edits a project",
				systemPrompt: "Make focused changes.",
				model: "",
				tools: ["read", "write"],
				scope: "user",
			});
			assert.equal(role.ok, true);
			const created = await service.invoke("task.create", {
				projectId: project.id,
				roleId: "user:coder",
				prompt: "Update file",
				dependsOn: [],
			});
			assert.equal(created.ok, true);
			if (!created.ok) return;
			const task = created.data as { id: string; worktreePath: string; status: string };
			assert.equal(task.status, "running");
			await writeFile(join(task.worktreePath, "file.txt"), "after\n");
			workers.at(-1)?.emit({ type: "state", state: "idle" });
			const completed = await settled(
				() => service.snapshot(),
				(snapshot) => snapshot.tasks.some((item) => item.id === task.id && item.status === "completed"),
			);
			const taskView = completed.tasks.find((item) => item.id === task.id);
			assert.deepEqual(
				taskView?.changes.map((item) => item.path),
				["file.txt"],
			);
			const merged = await service.invoke("task.merge", { taskId: task.id });
			assert.deepEqual(merged, { ok: true, data: { merged: true, conflicts: [] } });
			mergedTaskId = task.id;
			assert.equal(await readFile(join(paths.projectPath, "file.txt"), "utf8"), "after\n");
			const status = await execFileAsync("git", ["-C", paths.projectPath, "status", "--porcelain=v1"]);
			assert.match(status.stdout, /M file.txt/);
		} finally {
			await service.close();
		}
		if (mergedTaskId) {
			const reopened = await DesktopAppService.open({
				dataDirectory: paths.dataDirectory,
				agentDirectory: paths.agentDirectory,
				createWorkerTransport: () => new FakeWorker(),
			});
			try {
				const restored = (await reopened.snapshot()).tasks.find((item) => item.id === mergedTaskId);
				assert.equal(restored?.status, "merged");
				assert.deepEqual(
					restored?.changes.map((item) => item.path),
					["file.txt"],
				);
			} finally {
				await reopened.close();
			}
		}
	});

	it("fills a queued task slot after a worker reports failure", async () => {
		const paths = await repository();
		const workers: FakeWorker[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
		});
		try {
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const projectId = (opened.data as { id: string }).id;
			const role = await service.invoke("role.save", {
				id: "user:coder",
				name: "Coder",
				description: "Edits a project",
				systemPrompt: "Make focused changes.",
				model: "",
				tools: ["read", "write"],
				scope: "user",
			});
			assert.equal(role.ok, true);
			const tasks: string[] = [];
			for (let index = 0; index < 6; index++) {
				const created = await service.invoke("task.create", {
					projectId,
					roleId: "user:coder",
					prompt: `Task ${index}`,
					dependsOn: index === 1 ? [tasks[0]!] : [],
				});
				assert.equal(created.ok, true);
				if (created.ok) tasks.push((created.data as { id: string }).id);
			}
			workers[0]!.emit({ type: "state", state: "failed", message: "worker failed" });

			const snapshot = await settled(
				() => service.snapshot(),
				(value) => value.tasks.find((task) => task.id === tasks[5])?.status === "running",
			);
			assert.equal(snapshot.tasks.find((task) => task.id === tasks[0])?.status, "failed");
			assert.equal(snapshot.tasks.find((task) => task.id === tasks[1])?.status, "failed");
			assert.match(
				snapshot.tasks.find((task) => task.id === tasks[1])?.resultSummary ?? "",
				/prerequisite .* failed/,
			);
			assert.equal(snapshot.tasks.find((task) => task.id === tasks[5])?.status, "running");
			const rejected = await service.invoke("task.create", {
				projectId,
				roleId: "user:coder",
				prompt: "Cannot start",
				dependsOn: [tasks[0]!],
			});
			assert.equal(rejected.ok, false);
			if (!rejected.ok) assert.equal(rejected.code, "INVALID_DEPENDENCY");
		} finally {
			await service.close();
		}
	});

	it("fills queued slots after pausing and cancelling running tasks", async () => {
		const paths = await repository();
		const workers: FakeWorker[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
		});
		try {
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const role = await service.invoke("role.save", {
				id: "user:coder",
				name: "Coder",
				description: "Edits a project",
				systemPrompt: "Make focused changes.",
				model: "",
				tools: ["read", "write"],
				scope: "user",
			});
			assert.equal(role.ok, true);
			const tasks: string[] = [];
			for (let index = 0; index < 6; index++) {
				const created = await service.invoke("task.create", {
					projectId: (opened.data as { id: string }).id,
					roleId: "user:coder",
					prompt: `Task ${index}`,
					dependsOn: [],
				});
				assert.equal(created.ok, true);
				if (created.ok) tasks.push((created.data as { id: string }).id);
			}

			assert.equal((await service.invoke("task.pause", { taskId: tasks[0]! })).ok, true);
			let snapshot = await settled(
				() => service.snapshot(),
				(value) => value.tasks.find((task) => task.id === tasks[4])?.status === "running",
			);
			assert.equal(snapshot.tasks.find((task) => task.id === tasks[0])?.status, "paused");
			assert.equal((await service.invoke("task.cancel", { taskId: tasks[1]! })).ok, true);
			snapshot = await settled(
				() => service.snapshot(),
				(value) => value.tasks.find((task) => task.id === tasks[5])?.status === "running",
			);
			assert.equal(snapshot.tasks.find((task) => task.id === tasks[1])?.status, "cancelled");
		} finally {
			await service.close();
		}
	});

	it("fills a queued task slot after a task start request fails", async () => {
		const paths = await repository();
		const workers: FakeWorker[] = [];
		let failNextTaskStart = false;
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new FakeWorker();
				if (failNextTaskStart) {
					worker.failNextPrompt = true;
					worker.ignoreKill = true;
					failNextTaskStart = false;
				}
				workers.push(worker);
				return worker;
			},
		});
		try {
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const projectId = (opened.data as { id: string }).id;
			const role = await service.invoke("role.save", {
				id: "user:coder",
				name: "Coder",
				description: "Edits a project",
				systemPrompt: "Make focused changes.",
				model: "",
				tools: ["read", "write"],
				scope: "user",
			});
			assert.equal(role.ok, true);
			const prerequisite = await service.invoke("task.create", {
				projectId,
				roleId: "user:coder",
				prompt: "Prerequisite",
				dependsOn: [],
			});
			assert.equal(prerequisite.ok, true);
			if (!prerequisite.ok) return;
			const prerequisiteId = (prerequisite.data as { id: string }).id;
			const children: string[] = [];
			for (let index = 0; index < 5; index++) {
				const created = await service.invoke("task.create", {
					projectId,
					roleId: "user:coder",
					prompt: `Dependent ${index}`,
					dependsOn: [prerequisiteId],
				});
				assert.equal(created.ok, true);
				if (created.ok) children.push((created.data as { id: string }).id);
			}
			failNextTaskStart = true;
			workers[0]!.emit({ type: "state", state: "idle" });

			const snapshot = await settled(
				() => service.snapshot(),
				(value) => children.every((id) => value.tasks.find((task) => task.id === id)?.status !== "queued"),
				1_000, // This scenario must outlast the worker manager's 5-second forced-exit timeout.
			);
			assert.equal(
				children.filter((id) => snapshot.tasks.find((task) => task.id === id)?.status === "running").length,
				4,
			);
			assert.equal(
				children.filter((id) => snapshot.tasks.find((task) => task.id === id)?.status === "failed").length,
				1,
			);
		} finally {
			// Release deliberately unresponsive fakes even when an assertion fails.
			for (const worker of workers) if (worker.ignoreKill) worker.exit(0);
			await service.close();
		}
	});

	it("captures and publishes a task diff when its worker exits unexpectedly", async () => {
		const paths = await repository();
		const workers: FakeWorker[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
		});
		try {
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const role = await service.invoke("role.save", {
				id: "user:coder",
				name: "Coder",
				description: "Edits a project",
				systemPrompt: "Make focused changes.",
				model: "",
				tools: ["read", "write"],
				scope: "user",
			});
			assert.equal(role.ok, true);
			const tasks: Array<{ id: string; worktreePath: string }> = [];
			for (let index = 0; index < 5; index++) {
				const created = await service.invoke("task.create", {
					projectId: (opened.data as { id: string }).id,
					roleId: "user:coder",
					prompt: `Update file ${index}`,
					dependsOn: [],
				});
				assert.equal(created.ok, true);
				if (created.ok) tasks.push(created.data as { id: string; worktreePath: string });
			}
			const task = tasks[0]!;
			await writeFile(join(task.worktreePath, "file.txt"), "partial change\n");
			const events: DesktopEvent[] = [];
			const unsubscribe = await service.subscribe((await service.snapshot()).lastEventSeq, (event) =>
				events.push(event),
			);
			workers[0]!.exit(1);
			const snapshot = await settled(
				() => service.snapshot(),
				(value) =>
					value.tasks.find((item) => item.id === task.id)?.status === "review" &&
					value.tasks.find((item) => item.id === tasks[4]?.id)?.status === "running",
			);
			unsubscribe();
			assert.deepEqual(
				snapshot.tasks.find((item) => item.id === task.id)?.changes.map((change) => change.path),
				["file.txt"],
			);
			const taskEvent = events
				.filter(
					(event): event is Extract<DesktopEvent, { type: "task" }> =>
						event.type === "task" && event.task.id === task.id,
				)
				.at(-1);
			assert.deepEqual(
				taskEvent?.task.changes.map((change) => change.path),
				["file.txt"],
			);
		} finally {
			await service.close();
		}
	});

	it("routes main agent team tools without blocking child completion events", async () => {
		const paths = await repository();
		const workers: FakeWorker[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
		});
		try {
			const opened = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const projectId = (opened.data as { id: string }).id;
			assert.equal(
				(
					await service.invoke("role.save", {
						id: "user:coder",
						name: "Coder",
						description: "Edits a project",
						systemPrompt: "Make focused changes.",
						model: "",
						tools: ["read", "write"],
						scope: "user",
					})
				).ok,
				true,
			);
			const created = await service.invoke("session.create", { projectId });
			assert.equal(created.ok, true);
			if (!created.ok) return;
			const sessionId = (created.data as { id: string }).id;
			assert.equal((await service.invoke("session.select", { sessionId })).ok, true);
			const rootWorker = workers.at(-1);
			assert.ok(rootWorker);
			assert.ok(
				rootWorker.requests.some(
					(request) =>
						request.type === "init" &&
						request.payload &&
						typeof request.payload === "object" &&
						"enableTeamTools" in request.payload &&
						request.payload.enableTeamTools === true,
				),
			);
			rootWorker.emit({ type: "main.request", requestId: "roles-1", action: "team.roles", payload: {} });
			const rolesReply = await settled(
				async () =>
					rootWorker.requests.find(
						(request) =>
							request.type === "main.resolve" &&
							request.payload &&
							typeof request.payload === "object" &&
							"requestId" in request.payload &&
							request.payload.requestId === "roles-1",
					),
				(request) => request !== undefined,
			);
			assert.deepEqual(
				(rolesReply?.payload as { result: Array<{ id: string }> }).result.map((role) => role.id),
				["user:coder"],
			);
			rootWorker.emit({
				type: "main.request",
				requestId: "create-1",
				action: "task.create",
				payload: { roleId: "user:coder", prompt: "Update file", dependsOn: [] },
			});
			const createReply = await settled(
				async () =>
					rootWorker.requests.find(
						(request) =>
							request.type === "main.resolve" &&
							request.payload &&
							typeof request.payload === "object" &&
							"requestId" in request.payload &&
							request.payload.requestId === "create-1",
					),
				(request) => request !== undefined,
			);
			const taskId = (createReply?.payload as { result: { taskId: string } }).result.taskId;
			const childWorker = workers.at(-1);
			assert.ok(childWorker && childWorker !== rootWorker);
			childWorker.emit({ type: "main.request", requestId: "deny-1", action: "team.roles", payload: {} });
			const denied = await settled(
				async () =>
					childWorker.requests.find(
						(request) =>
							request.type === "main.resolve" &&
							request.payload &&
							typeof request.payload === "object" &&
							"requestId" in request.payload &&
							request.payload.requestId === "deny-1",
					),
				(request) => request !== undefined,
			);
			assert.equal((denied?.payload as { error: { code: string } }).error.code, "TEAM_TOOLS_UNAVAILABLE");
			rootWorker.emit({
				type: "main.request",
				requestId: "wait-1",
				action: "task.wait",
				payload: { taskId, timeoutMs: 2_000 },
			});
			childWorker.emit({ type: "state", state: "idle" });
			const waitReply = await settled(
				async () =>
					rootWorker.requests.find(
						(request) =>
							request.type === "main.resolve" &&
							request.payload &&
							typeof request.payload === "object" &&
							"requestId" in request.payload &&
							request.payload.requestId === "wait-1",
					),
				(request) => request !== undefined,
			);
			assert.equal((waitReply?.payload as { result: { status: string } }).result.status, "completed");
		} finally {
			await service.close();
		}
	});
});
