import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRuntime, ExtensionUIContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type McpManagerHandle, type McpSignInPrompt, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { isWorkerRequest } from "../../src/shared/worker-protocol.ts";
import {
	createDesktopSessionManager,
	createPiRuntime,
	type DesktopWorkerPort,
	installDesktopWorker,
} from "../../src/worker/worker-host.ts";

type ExtensionBindingMode = Parameters<AgentSessionRuntime["session"]["bindExtensions"]>[0]["mode"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isMainRequest(value: unknown): value is {
	event: { type: "main.request"; requestId: string; action: string; payload: unknown };
} {
	if (!isRecord(value) || !isRecord(value.event)) return false;
	return (
		value.event.type === "main.request" &&
		typeof value.event.requestId === "string" &&
		typeof value.event.action === "string" &&
		"payload" in value.event
	);
}

describe("desktop worker protocol and credentials", () => {
	it("loads Pi's built-in codemode, tool search, and MCP extensions in desktop sessions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-desktop-builtins-"));
		let runtime: AgentSessionRuntime | undefined;
		try {
			runtime = await createPiRuntime({ cwd: directory, agentDir: join(directory, "agent") }, []);
			const extensions = runtime.services.resourceLoader.getExtensions().extensions;
			const registeredTools = extensions.flatMap((extension) => [...extension.tools.keys()]);

			expect(registeredTools).toEqual(expect.arrayContaining(["codemode", "tool_search"]));
			expect(extensions.some((extension) => extension.commands.has("mcp"))).toBe(true);
		} finally {
			await runtime?.dispose();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("reopens an empty session with its Orbit ID and persists the first message", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-empty-session-"));
		try {
			const sessionId = randomUUID();
			const sessionDir = join(directory, "sessions");
			const created = createDesktopSessionManager({ cwd: directory, sessionDir, sessionId });
			const originalFile = created.getSessionFile();
			expect(originalFile).toBeDefined();
			created.appendModelChange("test-provider", "test-model");
			expect(created.getBranch()).toMatchObject([{ type: "model_change", provider: "test-provider" }]);
			await expect(readFile(originalFile!)).rejects.toMatchObject({ code: "ENOENT" });

			const reopened = createDesktopSessionManager({
				cwd: directory,
				sessionDir,
				sessionFile: originalFile,
				sessionId,
			});
			expect(reopened.getSessionId()).toBe(sessionId);
			reopened.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });

			const persistedFile = reopened.getSessionFile();
			expect(persistedFile).toBeDefined();
			const persisted = await readFile(persistedFile!, "utf8");
			expect(persisted).toContain('"role":"user"');
			const restored = SessionManager.open(persistedFile!, undefined, directory);
			expect(restored.getSessionId()).toBe(sessionId);
			expect(restored.getBranch()).toMatchObject([
				{ type: "message", message: { role: "user", content: "first prompt" } },
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("accepts only known, strictly shaped worker requests", () => {
		expect(isWorkerRequest({ id: "r1", type: "init", payload: { cwd: "C:/repo" } })).toBe(true);
		expect(isWorkerRequest({ id: "r2", type: "prompt", payload: { text: "hello", execute: "arbitrary" } })).toBe(
			false,
		);
		expect(isWorkerRequest({ id: "r3", type: "auth.refresh", payload: { provider: "fake" } })).toBe(true);
		expect(
			isWorkerRequest({ id: "r4", type: "auth.configure", payload: { provider: "fake", apiKey: "secret" } }),
		).toBe(false);
	});

	it("bridges typed MCP manager actions and emits only safe server status", async () => {
		const sent: unknown[] = [];
		const listeners = new Set<(value: unknown) => void>();
		const port: DesktopWorkerPort = {
			postMessage: (message) => sent.push(message),
			on: (_event, listener) => {
				listeners.add(listener);
				return port;
			},
			off: (_event, listener) => {
				listeners.delete(listener);
				return port;
			},
		};
		const servers = [
			{
				name: "docs",
				scope: "project" as const,
				enabled: true,
				exposure: "codemode" as const,
				state: "connected" as const,
				toolCount: 2,
				resourceCount: 1,
				usesOAuth: false,
				secret: "do-not-forward",
			},
		];
		const added: unknown[] = [];
		const manager = {
			getServers: () => servers,
			subscribe: () => () => undefined,
			signIn: async (_name: string, prompt: McpSignInPrompt) => {
				prompt.showAuthorizationUrl(new URL("https://auth.example/authorize?state=temporary"));
				const redirect = await prompt.promptForRedirectUrl(new AbortController().signal);
				return redirect ? { ok: true as const } : { ok: false as const, error: "cancelled" };
			},
			signOut: async () => ({ ok: true as const, changed: false }),
			reconnect: async () => ({ ok: true as const }),
			setEnabled: async () => ({ ok: true as const }),
			setExposure: () => ({ ok: false as const, error: "server rejected Authorization: Bearer secret-token" }),
			addServer: (...args: unknown[]) => {
				added.push(...args);
				return { ok: true as const, changed: true, reloadRequired: true };
			},
			updateServer: () => ({ ok: true as const, changed: true, reloadRequired: true }),
			removeServer: () => ({ ok: true as const, changed: true, reloadRequired: true }),
		} as unknown as McpManagerHandle;
		let isStreaming = false;
		let reloadCount = 0;
		const fakeRuntime = {
			diagnostics: [],
			session: {
				sessionId: "session-mcp",
				sessionFile: undefined,
				model: undefined,
				get isStreaming() {
					return isStreaming;
				},
				get isIdle() {
					return !isStreaming;
				},
				sessionManager: { getBranch: () => [] },
				bindExtensions: async () => undefined,
				subscribe: () => () => undefined,
				reload: async () => {
					reloadCount++;
				},
				abort: async () => undefined,
			},
			dispose: async () => undefined,
		};
		const host = installDesktopWorker(port, {
			createRuntime: async (_input, _tools, onMcpManager) => {
				onMcpManager(manager);
				return fakeRuntime as unknown as AgentSessionRuntime;
			},
		});
		const sendRequest = (message: unknown) => {
			for (const listener of listeners) listener(message);
		};
		const waitResponse = async (id: string): Promise<Record<string, unknown>> => {
			for (let attempt = 0; attempt < 100; attempt++) {
				const response = sent.find(
					(item) => item !== null && typeof item === "object" && "id" in item && item.id === id,
				);
				if (response !== undefined) return response as Record<string, unknown>;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			throw new Error(`Timed out waiting for worker response ${id}`);
		};

		sendRequest({ id: "init-mcp", type: "init", payload: { cwd: process.cwd() } });
		await waitResponse("init-mcp");
		sendRequest({ id: "mcp-sign-in", type: "mcp.sign-in", payload: { name: "docs" } });
		for (let attempt = 0; attempt < 100; attempt++) {
			if (
				sent.some((item) => isRecord(item) && isRecord(item.event) && item.event.type === "ui.request") &&
				sent.some((item) => isRecord(item) && isRecord(item.event) && item.event.type === "mcp.auth_url")
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		const signInDialog = sent.find(
			(item) => isRecord(item) && isRecord(item.event) && item.event.type === "ui.request",
		) as { event: { requestId: string } };
		expect(sent).toContainEqual({
			type: "event",
			event: { type: "mcp.auth_url", name: "docs", url: "https://auth.example/authorize?state=temporary" },
		});
		expect(sent.some((item) => isRecord(item) && item.id === "mcp-sign-in")).toBe(false);
		sendRequest({
			id: "mcp-sign-in-dialog-response",
			type: "ui.resolve",
			payload: { requestId: signInDialog.event.requestId, result: "http://127.0.0.1/callback?code=example" },
		});
		expect(await waitResponse("mcp-sign-in")).toMatchObject({ ok: true, data: { ok: true } });
		sendRequest({ id: "mcp-list", type: "mcp.list", payload: {} });
		expect(await waitResponse("mcp-list")).toMatchObject({
			ok: true,
			data: [{ name: "docs", state: "connected", toolCount: 2 }],
		});
		expect(JSON.stringify(sent)).not.toContain("do-not-forward");
		sendRequest({
			id: "mcp-add",
			type: "mcp.add",
			payload: { name: "new-server", scope: "project", configJson: '{"command":"server","env":{"TOKEN":"secret"}}' },
		});
		expect(await waitResponse("mcp-add")).toMatchObject({
			ok: true,
			data: { ok: true, changed: true, reloadRequired: true },
		});
		expect(added).toEqual(["new-server", { command: "server", env: { TOKEN: "secret" } }, "project"]);
		sendRequest({
			id: "mcp-action-failed",
			type: "mcp.set-exposure",
			payload: { name: "docs", exposure: "direct" },
		});
		expect(await waitResponse("mcp-action-failed")).toMatchObject({
			ok: false,
			error: { code: "OPERATION_FAILED", message: "server rejected Authorization: Bearer [REDACTED]" },
		});
		sendRequest({ id: "mcp-reload", type: "mcp.reload", payload: {} });
		expect(await waitResponse("mcp-reload")).toMatchObject({ ok: true, data: { reloaded: true } });
		expect(reloadCount).toBe(1);
		isStreaming = true;
		sendRequest({ id: "mcp-busy-reload", type: "mcp.reload", payload: {} });
		expect(await waitResponse("mcp-busy-reload")).toMatchObject({
			ok: false,
			error: { message: "Cannot reload MCP servers while the session is streaming" },
		});
		expect(reloadCount).toBe(1);
		await host.close();
	});

	it("settles extension dialogs on timeout and abort and emits dismiss events", async () => {
		const sent: unknown[] = [];
		const listeners = new Set<(value: unknown) => void>();
		const port: DesktopWorkerPort = {
			postMessage: (message) => sent.push(message),
			on: (_event, listener) => {
				listeners.add(listener);
				return port;
			},
			off: (_event, listener) => {
				listeners.delete(listener);
				return port;
			},
		};
		let ui: ExtensionUIContext | undefined;
		let extensionMode: ExtensionBindingMode;
		const fakeRuntime = {
			diagnostics: [],
			session: {
				sessionId: "session-dialogs",
				sessionFile: undefined,
				model: undefined,
				sessionManager: { getBranch: () => [] },
				bindExtensions: async (bindings: { mode?: ExtensionBindingMode; uiContext: ExtensionUIContext }) => {
					ui = bindings.uiContext;
					extensionMode = bindings.mode;
				},
				subscribe: () => () => undefined,
				abort: async () => undefined,
			},
			dispose: async () => undefined,
		};
		const host = installDesktopWorker(port, {
			createRuntime: async () => fakeRuntime as unknown as AgentSessionRuntime,
		});
		const sendRequest = (message: unknown) => {
			for (const listener of listeners) listener(message);
		};
		const waitUntil = async (predicate: () => boolean) => {
			for (let attempt = 0; attempt < 100; attempt++) {
				if (predicate()) return;
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			throw new Error("Timed out waiting for the expected worker event");
		};
		sendRequest({ id: "init-dialogs", type: "init", payload: { cwd: process.cwd() } });
		await waitUntil(() => sent.some((item) => isRecord(item) && item.id === "init-dialogs"));
		const extensionUI = ui!;
		// Extensions can distinguish the desktop host while still receiving its typed UI bridge.
		expect(extensionMode).toBe("desktop");
		extensionUI.setEditorText("replace this draft");
		extensionUI.pasteToEditor(" append this text");
		const editorUpdates = sent.flatMap((item) =>
			isRecord(item) && isRecord(item.event) && item.event.type === "ui.update" ? [item.event] : [],
		);
		expect(editorUpdates).toEqual([
			{ type: "ui.update", update: "editor", mode: "replace", message: "replace this draft" },
			{ type: "ui.update", update: "editor", mode: "append", message: " append this text" },
		]);
		const timedOut = extensionUI.select("Timed", ["yes"], { timeout: 15 });
		const timeoutRequest = sent.find(
			(item) => isRecord(item) && isRecord(item.event) && item.event.type === "ui.request",
		) as { event: { requestId: string; dialogOptions?: unknown } };
		expect(timeoutRequest.event.dialogOptions).toEqual({ timeout: 15 });
		await expect(timedOut).resolves.toBeUndefined();
		expect(sent).toContainEqual({
			type: "event",
			event: { type: "ui.dismiss", requestId: timeoutRequest.event.requestId, reason: "timeout" },
		});

		const abortController = new AbortController();
		const aborted = extensionUI.select("Abort", ["yes"], { signal: abortController.signal });
		const abortRequest = sent
			.filter((item) => isRecord(item) && isRecord(item.event) && item.event.type === "ui.request")
			.at(-1) as { event: { requestId: string } };
		abortController.abort();
		await expect(aborted).resolves.toBeUndefined();
		expect(sent).toContainEqual({
			type: "event",
			event: { type: "ui.dismiss", requestId: abortRequest.event.requestId, reason: "aborted" },
		});
		await host.close();
	});

	it("returns from prompt and queues steering and follow-up while the Pi session is running", async () => {
		const sent: unknown[] = [];
		const listeners = new Set<(value: unknown) => void>();
		const port: DesktopWorkerPort = {
			postMessage: (message) => sent.push(message),
			on: (_event, listener) => {
				listeners.add(listener);
				return port;
			},
			off: (_event, listener) => {
				listeners.delete(listener);
				return port;
			},
		};
		let rejectPrompt: ((error: Error) => void) | undefined;
		let isStreaming = false;
		const promptOptions: unknown[] = [];
		const promptTexts: string[] = [];
		const fakeRuntime = {
			diagnostics: [],
			session: {
				sessionId: "session-1",
				sessionFile: undefined,
				model: undefined,
				get isStreaming() {
					return isStreaming;
				},
				sessionManager: { getBranch: () => [] },
				bindExtensions: async () => undefined,
				subscribe: () => () => undefined,
				prompt: (text: string, options: unknown) => {
					promptTexts.push(text);
					promptOptions.push(options);
					return new Promise<void>((_resolve, reject) => {
						rejectPrompt = reject;
					});
				},
				abort: async () => undefined,
			},
			dispose: async () => undefined,
		};
		const host = installDesktopWorker(port, {
			createRuntime: async () => fakeRuntime as unknown as AgentSessionRuntime,
		});
		const sendRequest = (message: unknown) => {
			for (const listener of listeners) listener(message);
		};
		const waitResponse = async (id: string): Promise<unknown> => {
			for (let attempt = 0; attempt < 100; attempt++) {
				const response = sent.find(
					(item) => item !== null && typeof item === "object" && "id" in item && item.id === id,
				);
				if (response !== undefined) return response;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			throw new Error(`Timed out waiting for worker response ${id}`);
		};

		sendRequest({ id: "init", type: "init", payload: { cwd: process.cwd() } });
		expect(await waitResponse("init")).toMatchObject({ ok: true, data: { sessionId: "session-1", messages: [] } });
		const imageAttachment = { type: "image", name: "diagram.png", mimeType: "image/png", data: "aGVsbG8=" };
		const textAttachment = { type: "text", name: "notes.md", text: "see this note" };
		sendRequest({
			id: "prompt",
			type: "prompt",
			payload: { text: "start", attachments: [imageAttachment, textAttachment] },
		});
		expect(await waitResponse("prompt")).toMatchObject({ ok: true, data: { accepted: true } });
		isStreaming = true;
		sendRequest({
			id: "message",
			type: "message",
			payload: { text: "steer", deliverAs: "steer", attachments: [textAttachment] },
		});
		expect(await waitResponse("message")).toMatchObject({ ok: true, data: { accepted: true, delivery: "steer" } });
		sendRequest({
			id: "follow-up",
			type: "message",
			payload: { text: "follow up", deliverAs: "followUp", attachments: [imageAttachment] },
		});
		expect(await waitResponse("follow-up")).toMatchObject({
			ok: true,
			data: { accepted: true, delivery: "followUp" },
		});
		expect(promptOptions).toEqual([
			{ source: "rpc", images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
			{ source: "rpc", streamingBehavior: "steer" },
			{
				source: "rpc",
				streamingBehavior: "followUp",
				images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			},
		]);
		expect(promptTexts).toEqual([
			'start\n\n<file name="diagram.png"></file>\n<file name="notes.md">\nsee this note\n</file>',
			'steer\n\n<file name="notes.md">\nsee this note\n</file>',
			'follow up\n\n<file name="diagram.png"></file>',
		]);

		rejectPrompt?.(new Error("request failed"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(sent).toContainEqual({
			type: "event",
			event: { type: "state", state: "failed", sessionId: "session-1", message: "request failed" },
		});
		await host.close();
	});

	it("restores the newest messages and keeps their entry IDs available for fork", async () => {
		const sent: unknown[] = [];
		const listeners = new Set<(value: unknown) => void>();
		const port: DesktopWorkerPort = {
			postMessage: (message) => sent.push(message),
			on: (_event, listener) => {
				listeners.add(listener);
				return port;
			},
			off: (_event, listener) => {
				listeners.delete(listener);
				return port;
			},
		};
		const branch = Array.from({ length: 80 }, (_, index) => ({
			type: "message",
			id: `entry-${index}`,
			message: {
				role: "user",
				content:
					index === 79
						? [
								{ type: "text", text: "message 79" },
								{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
							]
						: `message ${index}`,
			},
		}));
		let forkedEntryId: string | undefined;
		const fakeRuntime = {
			diagnostics: [],
			session: {
				sessionId: "session-long-history",
				sessionFile: undefined,
				model: undefined,
				sessionManager: { getBranch: () => branch },
				bindExtensions: async () => undefined,
				subscribe: () => () => undefined,
				abort: async () => undefined,
			},
			fork: async (entryId: string) => {
				forkedEntryId = entryId;
				return { cancelled: false, selectedText: undefined };
			},
			dispose: async () => undefined,
		};
		const host = installDesktopWorker(port, {
			createRuntime: async () => fakeRuntime as unknown as AgentSessionRuntime,
		});
		const sendRequest = (message: unknown) => {
			for (const listener of listeners) listener(message);
		};
		const waitResponse = async (id: string): Promise<Record<string, unknown>> => {
			for (let attempt = 0; attempt < 100; attempt++) {
				const response = sent.find(
					(item) => item !== null && typeof item === "object" && "id" in item && item.id === id,
				);
				if (isRecord(response)) return response;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			throw new Error(`Timed out waiting for worker response ${id}`);
		};

		sendRequest({ id: "init-long-history", type: "init", payload: { cwd: process.cwd() } });
		const initialized = await waitResponse("init-long-history");
		expect(initialized).toMatchObject({ ok: true });
		if (!isRecord(initialized.data) || !Array.isArray(initialized.data.messages))
			throw new Error("Worker did not return session messages");
		expect(initialized.data.messages).toHaveLength(80);
		expect(initialized.data.messages.at(-1)).toMatchObject({
			entryId: "entry-79",
			text: "message 79",
			parts: [
				{ kind: "text", text: "message 79" },
				{ kind: "image", mimeType: "image/png" },
			],
		});

		sendRequest({ id: "fork-latest", type: "fork", payload: { entryId: "entry-79" } });
		await waitResponse("fork-latest");
		expect(forkedEntryId).toBe("entry-79");
		await host.close();
	});

	it("emits one finalized message with its stored entry ID for fork actions", async () => {
		const sent: unknown[] = [];
		const listeners = new Set<(value: unknown) => void>();
		const port: DesktopWorkerPort = {
			postMessage: (message) => sent.push(message),
			on: (_event, listener) => {
				listeners.add(listener);
				return port;
			},
			off: (_event, listener) => {
				listeners.delete(listener);
				return port;
			},
		};
		const assistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "finished" },
				{ type: "thinking", thinking: "plan safely" },
				{ type: "toolCall", id: "tool-call-1", name: "task_create", arguments: { roleId: "builder" } },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			timestamp: 123,
		};
		const branch = [
			{ type: "message", id: "entry-assistant-1", message: assistantMessage },
			{
				type: "message",
				id: "entry-tool-result-1",
				message: {
					role: "toolResult",
					toolCallId: "tool-call-1",
					toolName: "task_create",
					content: [{ type: "text", text: "task-1 created" }],
					isError: false,
					timestamp: 124,
				},
			},
		];
		let sessionListener: ((event: unknown) => void) | undefined;
		const refreshOptions: unknown[] = [];
		const fakeRuntime = {
			diagnostics: [],
			services: {
				modelRuntime: {
					refresh: async (options: unknown) => {
						refreshOptions.push(options);
						return { errors: new Map() };
					},
					hasConfiguredAuth: () => true,
					getModels: () => [],
					getAvailableSnapshot: () => [],
				},
			},
			session: {
				sessionId: "session-ids",
				sessionFile: undefined,
				model: undefined,
				sessionManager: { getBranch: () => branch },
				bindExtensions: async () => undefined,
				subscribe: (listener: (event: unknown) => void) => {
					sessionListener = listener;
					return () => {
						sessionListener = undefined;
					};
				},
				abort: async () => undefined,
			},
			dispose: async () => undefined,
		};
		const host = installDesktopWorker(port, {
			createRuntime: async () => fakeRuntime as unknown as AgentSessionRuntime,
		});
		const sendRequest = (message: unknown) => {
			for (const listener of listeners) listener(message);
		};
		const waitResponse = async (id: string): Promise<unknown> => {
			for (let attempt = 0; attempt < 100; attempt++) {
				const response = sent.find(
					(item) => item !== null && typeof item === "object" && "id" in item && item.id === id,
				);
				if (response !== undefined) return response;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			throw new Error(`Timed out waiting for worker response ${id}`);
		};

		sendRequest({ id: "init-ids", type: "init", payload: { cwd: process.cwd() } });
		expect(await waitResponse("init-ids")).toMatchObject({
			ok: true,
			data: {
				messages: [
					{
						entryId: "entry-assistant-1",
						role: "assistant",
						text: "finished",
						parts: [
							{ kind: "text", text: "finished" },
							{ kind: "thinking", text: "plan safely" },
							{
								kind: "tool",
								name: "task_create",
								status: "complete",
								input: '{"roleId":"builder"}',
							},
							{ kind: "image", mimeType: "image/png" },
						],
					},
					{ entryId: "entry-tool-result-1", role: "toolResult", text: "task-1 created" },
				],
			},
		});
		sessionListener?.({ type: "message_end", message: assistantMessage });
		sessionListener?.({
			type: "entry_appended",
			entry: { type: "message", id: "entry-assistant-1", message: assistantMessage },
		});
		expect(sent).toContainEqual({
			type: "event",
			event: {
				type: "message",
				phase: "end",
				role: "assistant",
				text: "finished",
				parts: [
					{ kind: "text", text: "finished" },
					{ kind: "thinking", text: "plan safely" },
					{
						kind: "tool",
						name: "task_create",
						status: "complete",
						input: '{"roleId":"builder"}',
					},
					{ kind: "image", mimeType: "image/png" },
				],
				timestamp: 123,
				entryId: "entry-assistant-1",
			},
		});
		expect(
			sent.filter(
				(item) =>
					item !== null &&
					typeof item === "object" &&
					"event" in item &&
					item.event !== null &&
					typeof item.event === "object" &&
					"type" in item.event &&
					item.event.type === "message" &&
					"phase" in item.event &&
					item.event.phase === "end",
			),
		).toHaveLength(1);
		branch.push({
			type: "message",
			id: "entry-user-2",
			message: {
				role: "user",
				content: [{ type: "text", text: "persisted after worker initialization" }],
				timestamp: 124,
			},
		});
		sendRequest({ id: "history-ids", type: "history", payload: {} });
		expect(await waitResponse("history-ids")).toMatchObject({
			ok: true,
			data: {
				sessionId: "session-ids",
				messages: [
					{
						entryId: "entry-assistant-1",
						role: "assistant",
						text: "finished",
						parts: [
							{ kind: "text", text: "finished" },
							{ kind: "thinking", text: "plan safely" },
							{
								kind: "tool",
								name: "task_create",
								status: "complete",
								input: '{"roleId":"builder"}',
							},
							{ kind: "image", mimeType: "image/png" },
						],
					},
					{
						entryId: "entry-tool-result-1",
						role: "toolResult",
						text: "task-1 created",
						parts: [{ kind: "tool", name: "task_create", status: "complete", output: "task-1 created" }],
					},
					{
						entryId: "entry-user-2",
						role: "user",
						text: "persisted after worker initialization",
						parts: [{ kind: "text", text: "persisted after worker initialization" }],
					},
				],
			},
		});
		sendRequest({ id: "auth-refresh", type: "auth.refresh", payload: { provider: "fake-provider" } });
		expect(await waitResponse("auth-refresh")).toMatchObject({
			ok: true,
			data: { provider: "fake-provider", configured: true, models: [], availableModels: [] },
		});
		expect(refreshOptions).toEqual([{ providers: ["fake-provider"], allowNetwork: false }]);
		const failedMessage = {
			role: "assistant",
			content: [],
			errorMessage: "Local faux provider failed",
			stopReason: "error",
			timestamp: 125,
		};
		sessionListener?.({ type: "message_end", message: failedMessage });
		sessionListener?.({
			type: "entry_appended",
			entry: { type: "message", id: "entry-error-1", message: failedMessage },
		});
		expect(sent).toContainEqual({
			type: "event",
			event: {
				type: "message",
				phase: "end",
				role: "assistant",
				text: "Local faux provider failed",
				parts: [{ kind: "text", text: "Local faux provider failed" }],
				timestamp: 125,
				entryId: "entry-error-1",
			},
		});
		await host.close();
	});

	it("routes team tool calls through correlated main-process requests", async () => {
		const sent: unknown[] = [];
		const listeners = new Set<(value: unknown) => void>();
		const port: DesktopWorkerPort = {
			postMessage: (message) => sent.push(message),
			on: (_event, listener) => {
				listeners.add(listener);
				return port;
			},
			off: (_event, listener) => {
				listeners.delete(listener);
				return port;
			},
		};
		let registeredTools: ToolDefinition[] = [];
		const fakeRuntime = {
			diagnostics: [],
			session: {
				sessionId: "session-team-tools",
				sessionFile: "session.jsonl",
				model: undefined,
				sessionManager: { getBranch: () => [] },
				bindExtensions: async () => undefined,
				subscribe: () => () => undefined,
				abort: async () => undefined,
			},
			dispose: async () => undefined,
		};
		const host = installDesktopWorker(port, {
			createRuntime: async (_input, tools) => {
				registeredTools = tools;
				return fakeRuntime as unknown as AgentSessionRuntime;
			},
		});
		const sendRequest = (message: unknown) => {
			for (const listener of listeners) listener(message);
		};
		const waitResponse = async (id: string): Promise<unknown> => {
			for (let attempt = 0; attempt < 100; attempt++) {
				const response = sent.find(
					(item) => item !== null && typeof item === "object" && "id" in item && item.id === id,
				);
				if (response !== undefined) return response;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			throw new Error(`Timed out waiting for worker response ${id}`);
		};

		sendRequest({ id: "init-team-tools", type: "init", payload: { cwd: process.cwd(), enableTeamTools: true } });
		await waitResponse("init-team-tools");
		expect(registeredTools.map((item) => item.name)).toEqual([
			"team_roles",
			"task_create",
			"task_message",
			"task_wait",
			"task_cancel",
		]);
		const rolesTool = registeredTools.find((item) => item.name === "team_roles");
		if (!rolesTool) throw new Error("Missing team_roles tool");
		const resultPromise = rolesTool.execute("call-roles", {}, undefined, undefined, {} as never);
		const mainRequest = sent.find(
			(item) =>
				item !== null &&
				typeof item === "object" &&
				"event" in item &&
				item.event !== null &&
				typeof item.event === "object" &&
				"type" in item.event &&
				item.event.type === "main.request",
		);
		expect(mainRequest).toMatchObject({ event: { type: "main.request", action: "team.roles", payload: {} } });
		if (
			mainRequest === undefined ||
			mainRequest === null ||
			typeof mainRequest !== "object" ||
			!("event" in mainRequest) ||
			mainRequest.event === null ||
			typeof mainRequest.event !== "object" ||
			!("requestId" in mainRequest.event) ||
			typeof mainRequest.event.requestId !== "string"
		) {
			throw new Error("Worker did not emit a correlated main request");
		}
		sendRequest({
			id: "resolve-roles",
			type: "main.resolve",
			payload: { requestId: mainRequest.event.requestId, result: [{ id: "builder", name: "Builder" }] },
		});
		expect(await waitResponse("resolve-roles")).toMatchObject({ ok: true, data: { resolved: true } });
		expect(await resultPromise).toMatchObject({
			content: [{ type: "text", text: '[{"id":"builder","name":"Builder"}]' }],
		});
		const waitTool = registeredTools.find((item) => item.name === "task_wait");
		if (!waitTool) throw new Error("Missing task_wait tool");
		const controller = new AbortController();
		const previousMainRequestCount = sent.filter(isMainRequest).length;
		const waitPromise = waitTool.execute(
			"call-wait",
			{ taskId: "task-1", timeoutMs: 1_000 },
			controller.signal,
			undefined,
			{} as never,
		);
		const waitRequest = sent.filter(isMainRequest)[previousMainRequestCount];
		expect(waitRequest).toMatchObject({ event: { type: "main.request", action: "task.wait" } });
		if (!waitRequest) throw new Error("Worker did not emit a task.wait request");
		controller.abort();
		await expect(waitPromise).rejects.toThrow("cancelled");
		sendRequest({
			id: "resolve-cancelled-wait",
			type: "main.resolve",
			payload: { requestId: waitRequest.event.requestId, result: { status: "completed" } },
		});
		expect(await waitResponse("resolve-cancelled-wait")).toMatchObject({
			ok: true,
			data: { resolved: false },
		});
		await host.close();
	});

	it("acknowledges shutdown only after the session aborts and runtime is disposed", async () => {
		const sent: unknown[] = [];
		const listeners = new Set<(value: unknown) => void>();
		const port: DesktopWorkerPort = {
			postMessage: (message) => sent.push(message),
			on: (_event, listener) => {
				listeners.add(listener);
				return port;
			},
			off: (_event, listener) => {
				listeners.delete(listener);
				return port;
			},
		};
		const lifecycle: string[] = [];
		let resolveAbort!: () => void;
		let resolveDispose!: () => void;
		let markDisposeStarted!: () => void;
		const disposeStarted = new Promise<void>((resolve) => {
			markDisposeStarted = resolve;
		});
		const fakeRuntime = {
			diagnostics: [],
			session: {
				sessionId: "session-shutdown",
				sessionFile: "session.jsonl",
				model: undefined,
				sessionManager: { getBranch: () => [] },
				bindExtensions: async () => undefined,
				subscribe: () => () => undefined,
				abort: () => {
					lifecycle.push("abort:start");
					return new Promise<void>((resolve) => {
						resolveAbort = () => {
							lifecycle.push("abort:complete");
							resolve();
						};
					});
				},
			},
			dispose: () => {
				lifecycle.push("dispose:start");
				markDisposeStarted();
				return new Promise<void>((resolve) => {
					resolveDispose = () => {
						lifecycle.push("dispose:complete");
						resolve();
					};
				});
			},
		};
		installDesktopWorker(port, {
			createRuntime: async () => fakeRuntime as unknown as AgentSessionRuntime,
			onShutdown: () => lifecycle.push("shutdown:callback"),
		});
		const sendRequest = (message: unknown) => {
			for (const listener of listeners) listener(message);
		};
		const waitResponse = async (id: string): Promise<unknown> => {
			for (let attempt = 0; attempt < 100; attempt++) {
				const response = sent.find(
					(item) => item !== null && typeof item === "object" && "id" in item && item.id === id,
				);
				if (response !== undefined) return response;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			throw new Error(`Timed out waiting for worker response ${id}`);
		};

		sendRequest({ id: "init-shutdown", type: "init", payload: { cwd: process.cwd() } });
		await waitResponse("init-shutdown");
		sendRequest({ id: "shutdown", type: "shutdown" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(sent.some((item) => isRecord(item) && item.id === "shutdown")).toBe(false);
		expect(lifecycle).toEqual(["abort:start"]);

		resolveAbort();
		await disposeStarted;
		expect(sent.some((item) => isRecord(item) && item.id === "shutdown")).toBe(false);
		expect(lifecycle).toEqual(["abort:start", "abort:complete", "dispose:start"]);

		resolveDispose();
		expect(await waitResponse("shutdown")).toMatchObject({ ok: true, data: { closing: true } });
		expect(lifecycle).toEqual([
			"abort:start",
			"abort:complete",
			"dispose:start",
			"dispose:complete",
			"shutdown:callback",
		]);
	});
});
