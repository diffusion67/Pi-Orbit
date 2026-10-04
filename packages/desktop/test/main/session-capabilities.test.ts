import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopAppService } from "../../src/main/app-service.ts";
import type { WorkerTransport } from "../../src/main/worker-manager.ts";

const roots: string[] = [];
type StoredHistory = {
	sessionId: string;
	sessionFile: string;
	model: { provider: string; id: string };
	messages: unknown[];
	leafId?: string;
};

class SessionWorker implements WorkerTransport {
	private listener?: (message: unknown) => void;
	private exited?: (code: number) => void;
	private session?: StoredHistory;
	readonly requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
	failNavigation = false;
	cancelNavigation = false;
	constructor(privateHistory: Map<string, StoredHistory>) {
		this.history = privateHistory;
	}
	private readonly history: Map<string, StoredHistory>;
	onMessage(listener: (message: unknown) => void): void {
		this.listener = listener;
	}
	onExit(listener: (code: number) => void): void {
		this.exited = listener;
	}
	kill(): void {
		this.exited?.(0);
	}
	postMessage(message: unknown): void {
		const request = message as { id: string; type: string; payload: Record<string, unknown> };
		const { id, type, payload } = request;
		this.requests.push({ type, payload });
		if (type === "init") {
			const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : randomUUID();
			const sessionFile =
				typeof payload.sessionFile === "string" ? payload.sessionFile : join(tmpdir(), `${sessionId}.jsonl`);
			this.session = this.history.get(sessionFile) ?? {
				sessionId,
				sessionFile,
				model: { provider: "test", id: "model" },
				messages: [],
			};
			this.history.set(sessionFile, this.session);
		}
		if (type === "tree.navigate" && this.failNavigation) {
			this.listener?.({ id, ok: false, error: { code: "NOT_FOUND", message: "Entry not found" } });
			return;
		}
		let data: unknown = {};
		switch (type) {
			case "init":
			case "history":
				data = this.session;
				break;
			case "model.list":
				data = [];
				break;
			case "resources.list":
				data = { skills: [], templates: [], commands: [], extensions: [] };
				break;
			case "clone":
			case "fork": {
				const sessionId = randomUUID();
				const sessionFile = join(tmpdir(), `${sessionId}.jsonl`);
				data = {
					...this.session,
					sessionId,
					sessionFile,
					cancelled: false,
					...(type === "fork" && payload.position === "before" ? { selectedText: "Original fork request" } : {}),
				};
				this.history.set(sessionFile, data as StoredHistory);
				break;
			}
			case "session.import": {
				const header = JSON.parse(readFileSync(String(payload.sessionFile), "utf8").split("\n")[0]) as {
					id: string;
				};
				this.session = {
					sessionId: header.id,
					sessionFile: join(tmpdir(), `${header.id}.jsonl`),
					model: { provider: "test", id: "model" },
					messages: [],
				};
				this.history.set(this.session.sessionFile, this.session);
				data = { ...this.session, cancelled: false, sessionName: "Imported Pi name" };
				break;
			}
			case "session.export":
				data = { path: payload.path, format: payload.format };
				break;
			case "tree.get":
				data = {
					leafId: "assistant-1",
					entries: [{ id: "user-1", parentId: null, type: "message", role: "user", label: "Original request" }],
				};
				break;
			case "tree.navigate": {
				if (!this.cancelNavigation && this.session) this.session.messages = [];
				data = { ...this.session, cancelled: this.cancelNavigation, editorText: "Original request", leafId: null };
				break;
			}
			case "thinking.get":
			case "thinking.set":
				data = { level: payload.level ?? "off", availableLevels: ["off", "high"] };
				break;
			case "stats.get":
				data = { sessionId: this.session?.sessionId, totalMessages: 2, tokens: { total: 120 }, cost: 0.01 };
				break;
			case "resources.reload":
				data = { reloaded: true };
				break;
			case "session.rename":
				data = { renamed: true };
				break;
			case "compact":
				if (this.session) this.session.messages = [];
				data = { aborted: false };
				break;
		}
		this.listener?.({ id, ok: true, data });
	}
}

async function setup(
	dialogs: {
		chooseSessionFile?: () => Promise<string | undefined>;
		chooseSessionExportFile?: (title: string, format: "html" | "jsonl") => Promise<string | undefined>;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "orbit-native-capabilities-"));
	roots.push(root);
	const projectPath = join(root, "project");
	await mkdir(projectPath);
	const workers: SessionWorker[] = [];
	const history = new Map<string, StoredHistory>();
	const service = await DesktopAppService.open({
		...dialogs,
		dataDirectory: join(root, "data"),
		agentDirectory: join(root, "agent"),
		createWorkerTransport: () => {
			const worker = new SessionWorker(history);
			workers.push(worker);
			return worker;
		},
	});
	const project = await service.invoke("project.open", { path: projectPath });
	if (!project.ok) throw new Error(project.message);
	const session = await service.invoke("session.create", { projectId: (project.data as { id: string }).id });
	if (!session.ok) throw new Error(session.message);
	const sessionId = (session.data as { id: string }).id;
	await service.invoke("session.select", { sessionId });
	return { service, workers, sessionId, history, root, projectId: (project.data as { id: string }).id };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("native session capability bridge", () => {
	it("forks at the actual native leaf or selected entry and returns restored request text", async () => {
		const { service, workers, sessionId, history } = await setup();
		try {
			for (const item of history.values()) item.leafId = "trailing-native-state";
			const worker = workers.at(-1)!;
			expect(await service.invoke("session.fork", { sessionId })).toMatchObject({ ok: true });
			expect(worker.requests).toContainEqual({
				type: "fork",
				payload: { entryId: "trailing-native-state", position: "at" },
			});
			const currentId = (await service.snapshot()).activeSessionId!;
			expect(
				await service.invoke("session.fork", { sessionId: currentId, entryId: "user-entry", position: "before" }),
			).toMatchObject({ ok: true, data: { selectedText: "Original fork request" } });
		} finally {
			await service.close();
		}
	});
	it("imports through a private copy, preserves the source, and rejects existing session IDs", async () => {
		let selectedFile: string | undefined;
		const { service, workers, root, projectId, sessionId } = await setup({
			chooseSessionFile: async () => selectedFile,
		});
		try {
			expect(await service.invoke("session.import", { projectId })).toEqual({ ok: true, data: { imported: false } });
			expect((await service.snapshot()).activeSessionId).toBe(sessionId);
			const importId = randomUUID();
			selectedFile = join(root, "source.jsonl");
			const source = `${JSON.stringify({ type: "session", version: 3, id: importId, cwd: "/missing-original-project", timestamp: new Date().toISOString() })}\n`;
			await writeFile(selectedFile, source);
			const result = await service.invoke("session.import", { projectId });
			expect(result).toMatchObject({
				ok: true,
				data: { imported: true, session: { id: importId, title: "Imported Pi name" } },
			});
			expect(await readFile(selectedFile, "utf8")).toBe(source);
			expect((await service.snapshot()).activeSessionId).toBe(importId);
			const request = workers
				.flatMap((worker) => worker.requests)
				.find((request) => request.type === "session.import");
			expect(request?.payload.sessionFile).not.toBe(selectedFile);
			const cwdOverride = request?.payload.cwdOverride;
			expect(typeof cwdOverride).toBe("string");
			if (typeof cwdOverride !== "string") throw new Error("Imported session has no project working directory");
			expect(await realpath(cwdOverride)).toBe(await realpath(join(root, "project")));
			expect((await readdir(join(root, "data"))).filter((name) => name.startsWith("import-"))).toEqual([]);
			expect(await service.invoke("session.import", { projectId })).toMatchObject({
				ok: false,
				code: "SESSION_EXISTS",
			});
			expect((await service.snapshot()).sessions).toHaveLength(2);
		} finally {
			await service.close();
		}
	});
	it("exports both native formats and keeps cancellation neutral", async () => {
		let outputPath: string | undefined;
		const choices: Array<{ title: string; format: string }> = [];
		const { service, workers, root, sessionId } = await setup({
			chooseSessionExportFile: async (title, format) => {
				choices.push({ title, format });
				return outputPath;
			},
		});
		try {
			expect(await service.invoke("session.export", { sessionId })).toEqual({ ok: true, data: { exported: false } });
			for (const format of ["html", "jsonl"] as const) {
				outputPath = join(root, `export.${format}`);
				expect(await service.invoke("session.export", { sessionId, format })).toEqual({
					ok: true,
					data: { exported: true, path: outputPath },
				});
				expect(workers.at(-1)?.requests).toContainEqual({
					type: "session.export",
					payload: { path: outputPath, format },
				});
			}
			expect(choices.map((choice) => choice.format)).toEqual(["html", "html", "jsonl"]);
			expect(await service.invoke("session.export", { sessionId, format: "pdf" })).toMatchObject({
				ok: false,
				code: "INVALID_ARGUMENT",
			});
		} finally {
			await service.close();
		}
	});
	it("exposes thinking, usage and resource reload with validated IPC", async () => {
		const { service, workers, sessionId } = await setup();
		try {
			expect(await service.invoke("session.thinking.get", { sessionId })).toMatchObject({
				ok: true,
				data: { level: "off", availableLevels: ["off", "high"] },
			});
			expect(await service.invoke("session.thinking.set", { sessionId, level: "high" })).toMatchObject({
				ok: true,
				data: { level: "high" },
			});
			expect(await service.invoke("session.thinking.set", { sessionId, level: "invalid" })).toMatchObject({
				ok: false,
				code: "INVALID_ARGUMENT",
			});
			expect(await service.invoke("session.stats", { sessionId })).toMatchObject({
				ok: true,
				data: { sessionId, tokens: { total: 120 } },
			});
			expect(await service.invoke("session.reload", { sessionId })).toEqual({ ok: true, data: { reloaded: true } });
			expect(workers.at(-1)?.requests.some((request) => request.type === "resources.reload")).toBe(true);
		} finally {
			await service.close();
		}
	});
	it("registers a cloned branch under a distinct session without changing the source ID", async () => {
		const { service, sessionId } = await setup();
		try {
			const result = await service.invoke("session.clone", { sessionId });
			expect(result.ok).toBe(true);
			const snapshot = await service.snapshot();
			expect(snapshot.activeSessionId).not.toBe(sessionId);
			expect(snapshot.sessions).toHaveLength(2);
			expect(snapshot.sessions.some((session) => session.id === sessionId)).toBe(true);
			expect(snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)?.title).toBe(
				"New session (clone)",
			);
		} finally {
			await service.close();
		}
	});
	it("navigates the existing session, refreshes transcript, and preserves state on cancellation and failure", async () => {
		const { service, workers, sessionId } = await setup();
		try {
			expect(await service.invoke("session.tree", { sessionId })).toMatchObject({
				ok: true,
				data: { leafId: "assistant-1", entries: [{ id: "user-1" }] },
			});
			const worker = workers.at(-1)!;
			worker.cancelNavigation = true;
			expect(await service.invoke("session.navigate", { sessionId, entryId: "user-1" })).toEqual({
				ok: true,
				data: { navigated: false },
			});
			worker.cancelNavigation = false;
			worker.failNavigation = true;
			expect(await service.invoke("session.navigate", { sessionId, entryId: "unknown" })).toMatchObject({
				ok: false,
				code: "NOT_FOUND",
			});
			worker.failNavigation = false;
			expect(await service.invoke("session.navigate", { sessionId, entryId: "user-1" })).toEqual({
				ok: true,
				data: { navigated: true, editorText: "Original request" },
			});
			expect((await service.snapshot()).activeSessionId).toBe(sessionId);
			expect((await service.snapshot()).messages).toEqual([]);
		} finally {
			await service.close();
		}
	});
	it("persists native session names and refreshes history after custom compaction", async () => {
		const { service, workers, sessionId } = await setup();
		try {
			expect(await service.invoke("session.rename", { sessionId, title: "Named in Pi" })).toMatchObject({
				ok: true,
				data: { title: "Named in Pi" },
			});
			expect(workers.at(-1)?.requests).toContainEqual({ type: "session.rename", payload: { title: "Named in Pi" } });
			expect(await service.invoke("session.compact", { sessionId, instructions: "Keep file paths" })).toEqual({
				ok: true,
				data: { compacted: true },
			});
			expect(workers.at(-1)?.requests).toContainEqual({
				type: "compact",
				payload: { instructions: "Keep file paths" },
			});
		} finally {
			await service.close();
		}
	});
});
