import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	type ExtensionMode,
	type ExtensionUIDialogOptions,
	getAgentDir,
	type McpManagerActionResult,
	type McpManagerHandle,
	type McpManagerServer,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createDesktopExtensionUIContext, type DesktopExtensionDialogRequest } from "../extensions/ui-context.ts";
import {
	appendTextAttachments,
	type DesktopAttachment,
	imageContentFromAttachments,
	validateAttachments,
} from "../shared/attachments.ts";
import {
	isWorkerRequest,
	parseMcpServerConfigJson,
	type WorkerErrorCode,
	type WorkerEvent,
	type WorkerMainRequest,
	type WorkerRequest,
	type WorkerResponse,
} from "../shared/worker-protocol.ts";
import { listDesktopResources, runDesktopResource } from "./resource-catalog.ts";
import { createDesktopTeamTools } from "./team-tools.ts";

type InitRequest = Extract<WorkerRequest, { readonly type: "init" }>;
type InitPayload = InitRequest["payload"];
type RequestListener = (message: unknown) => void;

/** The small process-message surface shared by Electron UtilityProcess and worker test doubles. */
export interface DesktopWorkerPort {
	postMessage(message: WorkerResponse | WorkerEvent): void;
	on(event: "message", listener: RequestListener): this;
	off?(event: "message", listener: RequestListener): this;
}

export interface DesktopWorkerHostOptions {
	readonly createRuntime?: (
		input: InitPayload,
		customTools: ToolDefinition[],
		onMcpManager: (manager: McpManagerHandle | undefined) => void,
	) => Promise<AgentSessionRuntime>;
	readonly onShutdown?: () => void;
}

type UiPending = {
	resolve(value: string | boolean | undefined): void;
	dismiss(reason: "aborted" | "timeout" | "closed"): void;
};
type MainPending = {
	readonly resolve: (result: JsonValue) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
	readonly signal?: AbortSignal;
	readonly abortListener?: () => void;
};

type PromptRun = {
	readonly id?: string;
	abortRequested: boolean;
	lastAssistant?: Extract<AgentMessage, { role: "assistant" }>;
	completion?: Promise<void>;
};

const MAX_EVENT_TEXT = 20_000;
const MAX_JSON_DEPTH = 5;
const DESKTOP_EXTENSION_MODE: ExtensionMode = "desktop";

function validateSessionInput(text: string, attachments: readonly DesktopAttachment[] | undefined): void {
	if (!text.trim() && (!attachments || attachments.length === 0)) throw new Error("Enter a message or attach a file.");
	validateAttachments(attachments);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function redactText(value: string): string {
	return value
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|sk_[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
		.replace(
			/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
			"$1[REDACTED]",
		)
		.slice(0, MAX_EVENT_TEXT);
}

function safeJson(value: unknown, depth = 0, seen = new WeakSet<object>()): JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") return redactText(value);
	if (typeof value !== "object" || depth >= MAX_JSON_DEPTH || seen.has(value)) return "[omitted]";
	seen.add(value);
	if (Array.isArray(value)) return value.slice(0, 64).map((item) => safeJson(item, depth + 1, seen));
	const result: Record<string, JsonValue> = {};
	for (const [key, item] of Object.entries(value).slice(0, 100)) {
		result[key] = /(?:api.?key|token|secret|password|credential|authorization)/i.test(key)
			? "[REDACTED]"
			: safeJson(item, depth + 1, seen);
	}
	return result;
}

function textFromMessage(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return "";
	if (typeof message.content === "string") return redactText(message.content);
	const text = message.content
		.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [redactText(part.text)] : []))
		.join("");
	return text || (message.role === "assistant" && message.errorMessage ? redactText(message.errorMessage) : "");
}

function messageRole(message: AgentMessage): "user" | "assistant" | "toolResult" | undefined {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult"
		? message.role
		: undefined;
}

function toolResultsByCall(
	entries: ReturnType<AgentSessionRuntime["session"]["sessionManager"]["getBranch"]>,
): Map<string, Extract<AgentMessage, { role: "toolResult" }>> {
	const results = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult")
			results.set(entry.message.toolCallId, entry.message);
	}
	return results;
}

function messageParts(
	message: AgentMessage,
	toolResults: ReadonlyMap<string, Extract<AgentMessage, { role: "toolResult" }>>,
): JsonValue[] {
	if (message.role === "toolResult") {
		const output = message.content
			.flatMap((part) => (part.type === "text" ? [redactText(part.text)] : []))
			.join("")
			.slice(0, 4_000);
		return [{ kind: "tool", name: message.toolName, status: message.isError ? "error" : "complete", output }];
	}
	if (message.role !== "user" && message.role !== "assistant") return [];
	if (typeof message.content === "string") return [{ kind: "text", text: redactText(message.content) }];
	return message.content
		.flatMap((part): JsonValue[] => {
			if (part.type === "text") return [{ kind: "text", text: redactText(part.text) }];
			if (part.type === "thinking") return [{ kind: "thinking", text: redactText(part.thinking) }];
			if (part.type === "image") return [{ kind: "image", mimeType: part.mimeType }];
			if (part.type === "toolCall") {
				const result = toolResults.get(part.id);
				const input = JSON.stringify(safeJson(part.arguments)).slice(0, 4_000);
				return [
					{
						kind: "tool",
						name: part.name,
						status: result ? (result.isError ? "error" : "complete") : "running",
						input,
					},
				];
			}
			return [];
		})
		.slice(0, 32);
}

function modelDto(model: Model<Api> | undefined): JsonValue {
	if (!model) return null;
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		api: model.api,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		input: [...model.input],
		reasoning: model.reasoning,
	};
}

function eventForMessage(
	phase: "start" | "update" | "end",
	message: AgentMessage,
	entryId?: string,
	toolResults: ReadonlyMap<string, Extract<AgentMessage, { role: "toolResult" }>> = new Map(),
): WorkerEvent | undefined {
	const role = messageRole(message);
	if (!role) return undefined;
	const timestamp = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : undefined;
	const text = textFromMessage(message);
	const parts = messageParts(message, toolResults);
	return {
		type: "event",
		event: {
			type: "message",
			phase,
			role,
			text,
			parts: safeJson(parts.length === 0 && text ? [{ kind: "text", text }] : parts) as JsonValue[],
			...(timestamp === undefined ? {} : { timestamp }),
			...(entryId === undefined ? {} : { entryId }),
		},
	};
}

function sessionMessages(runtime: AgentSessionRuntime): JsonValue {
	const branch = runtime.session.sessionManager.getBranch();
	const toolResults = toolResultsByCall(branch);
	const messages = branch.flatMap((entry) => {
		if (entry.type !== "message") return [];
		const event = eventForMessage("end", entry.message, entry.id, toolResults);
		return event && event.type === "event" && event.event.type === "message" ? [event.event] : [];
	});
	return messages.slice(-500).map((message) => safeJson(message));
}

export async function createPiRuntime(
	input: InitPayload,
	customTools: ToolDefinition[] = [],
	onMcpManager?: (manager: McpManagerHandle | undefined) => void,
): Promise<AgentSessionRuntime> {
	const agentDir = input.agentDir ?? process.env.PI_AGENT_DIR ?? getAgentDir();
	const sessionManager = createDesktopSessionManager({ ...input, agentDir });
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: {
				systemPrompt: input.systemPrompt,
				extensionFactories: [
					createCodemodeExtension(),
					createToolSearchExtension(),
					createMcpExtension({ agentDir: input.agentDir ?? agentDir, onManager: onMcpManager }),
				],
			},
		});
		const requestedModel = input.model
			? services.modelRuntime.getModel(input.model.provider, input.model.modelId)
			: undefined;
		if (input.model && !requestedModel)
			throw new Error(`Unknown model ${input.model.provider}/${input.model.modelId}`);
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: requestedModel,
			tools: input.tools,
			customTools,
			sessionStartEvent,
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	return createAgentSessionRuntime(createRuntime, {
		cwd: input.cwd,
		agentDir,
		sessionManager,
	});
}

/** Recreate an Orbit session with its saved identity when Pi has not written its first message yet. */
export function createDesktopSessionManager(
	input: Pick<InitPayload, "cwd" | "sessionFile" | "sessionId" | "agentDir"> & { sessionDir?: string },
): SessionManager {
	if (input.sessionFile && existsSync(input.sessionFile)) {
		return SessionManager.open(input.sessionFile, undefined, input.cwd);
	}
	const sessionDir =
		input.sessionDir ?? join(input.agentDir ?? getAgentDir(), "sessions", sessionDirectoryName(input.cwd));
	return SessionManager.create(input.cwd, sessionDir, input.sessionId ? { id: input.sessionId } : undefined);
}

function sessionDirectoryName(cwd: string): string {
	const resolvedCwd = resolve(cwd);
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export class DesktopWorkerHost {
	private readonly port: DesktopWorkerPort;
	private readonly createRuntime: NonNullable<DesktopWorkerHostOptions["createRuntime"]>;
	private readonly onShutdown?: () => void;
	private readonly pendingUi = new Map<string, UiPending>();
	private readonly pendingMain = new Map<string, MainPending>();
	private runtime?: AgentSessionRuntime;
	private mcpManager?: McpManagerHandle;
	private unsubscribeMcpManager?: () => void;
	private unsubscribeSession?: () => void;
	private listener: RequestListener;
	private initialized = false;
	private shuttingDown = false;
	private nextUiRequest = 0;
	private extensionToolsExpanded = false;
	private activeRun?: PromptRun;

	constructor(port: DesktopWorkerPort, options: DesktopWorkerHostOptions = {}) {
		this.port = port;
		this.createRuntime = options.createRuntime ?? createPiRuntime;
		this.onShutdown = options.onShutdown;
		this.listener = (value) => void this.handleMessage(value);
		port.on("message", this.listener);
	}

	async close(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		for (const pending of [...this.pendingUi.values()]) pending.dismiss("closed");
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		for (const [requestId, pending] of this.pendingMain) {
			clearTimeout(pending.timer);
			if (pending.signal && pending.abortListener)
				pending.signal.removeEventListener("abort", pending.abortListener);
			pending.reject(new Error("Pi Orbit worker closed while waiting for the main process"));
			this.pendingMain.delete(requestId);
		}
		try {
			await this.runtime?.session.abort();
			await this.runtime?.dispose();
		} finally {
			this.unsubscribeMcpManager?.();
			this.unsubscribeMcpManager = undefined;
			this.mcpManager = undefined;
			this.runtime = undefined;
			this.emit({ type: "event", event: { type: "state", state: "closed" } });
			this.port.off?.("message", this.listener);
			this.onShutdown?.();
		}
	}

	private emit(message: WorkerResponse | WorkerEvent): void {
		this.port.postMessage(message);
	}

	private respond(id: string, data: JsonValue): void {
		this.emit({ id, ok: true, data });
	}

	private reject(id: string, code: WorkerErrorCode, message: string): void {
		this.emit({ id, ok: false, error: { code, message: redactText(message) } });
	}

	private requestMain(request: WorkerMainRequest, signal?: AbortSignal): Promise<JsonValue> {
		if (signal?.aborted) return Promise.reject(new Error("Delegated task request was cancelled"));
		if (this.shuttingDown) return Promise.reject(new Error("Pi Orbit worker is shutting down"));
		const requestId = randomUUID();
		return new Promise((resolve, reject) => {
			const finishWithError = (message: string) => {
				this.pendingMain.delete(requestId);
				clearTimeout(timer);
				if (signal && abortListener) signal.removeEventListener("abort", abortListener);
				reject(new Error(message));
			};
			const timer = setTimeout(
				() => finishWithError("Main process did not answer the delegated task request"),
				65_000,
			);
			const abortListener = signal ? () => finishWithError("Delegated task request was cancelled") : undefined;
			this.pendingMain.set(requestId, { resolve, reject, timer, signal, abortListener });
			if (signal && abortListener) signal.addEventListener("abort", abortListener, { once: true });
			try {
				this.emit({ type: "event", event: { type: "main.request", requestId, ...request } });
			} catch (error) {
				finishWithError(errorMessage(error));
			}
		});
	}

	private async handleMessage(value: unknown): Promise<void> {
		if (!isWorkerRequest(value)) {
			this.reject("", "INVALID_REQUEST", "Worker received an invalid request");
			return;
		}
		const request = value;
		if (this.shuttingDown && request.type !== "shutdown") {
			this.reject(request.id, "SHUTTING_DOWN", "Worker is shutting down");
			return;
		}
		if (request.type === "ui.resolve") {
			const pending = this.pendingUi.get(request.payload.requestId);
			if (pending) pending.resolve(request.payload.result === null ? undefined : request.payload.result);
			this.respond(request.id, { resolved: pending !== undefined });
			return;
		}
		if (request.type === "main.resolve") {
			const pending = this.pendingMain.get(request.payload.requestId);
			if (pending) {
				this.pendingMain.delete(request.payload.requestId);
				clearTimeout(pending.timer);
				if (pending.signal && pending.abortListener)
					pending.signal.removeEventListener("abort", pending.abortListener);
				if ("error" in request.payload)
					pending.reject(new Error(`${request.payload.error.code}: ${request.payload.error.message}`));
				else pending.resolve(safeJson(request.payload.result));
			}
			this.respond(request.id, { resolved: pending !== undefined });
			return;
		}
		if (request.type === "init") {
			await this.initialize(request);
			return;
		}
		if (request.type === "shutdown") {
			await this.close();
			this.respond(request.id, { closing: true });
			return;
		}
		if (request.type === "abort") {
			if (!this.runtime) return this.reject(request.id, "NOT_INITIALIZED", "Worker is not initialized");
			const run = this.activeRun;
			if (run) run.abortRequested = true;
			await this.runtime.session.abort();
			// Settlement is emitted before prompt() resolves. Finish its terminal event before
			// acknowledging abort, so the next prompt cannot overlap the previous run.
			await run?.completion;
			this.respond(request.id, { aborted: true });
			return;
		}
		if (!this.runtime) return this.reject(request.id, "NOT_INITIALIZED", "Worker is not initialized");
		try {
			await this.dispatch(request);
		} catch (error) {
			this.reject(request.id, "OPERATION_FAILED", errorMessage(error));
		}
	}

	private async initialize(request: InitRequest): Promise<void> {
		if (this.initialized) return this.reject(request.id, "ALREADY_INITIALIZED", "Worker is already initialized");
		this.initialized = true;
		try {
			const customTools = request.payload.enableTeamTools
				? createDesktopTeamTools((mainRequest, signal) => this.requestMain(mainRequest, signal))
				: [];
			this.runtime = await this.createRuntime(request.payload, customTools, (manager) =>
				this.bindMcpManager(manager),
			);
			await this.bindDesktopExtensions(this.runtime);
			this.unsubscribeSession = this.runtime.session.subscribe((event) => this.publishSessionEvent(event));
			for (const diagnostic of this.runtime.diagnostics) {
				this.emit({
					type: "event",
					event: { type: "diagnostic", level: diagnostic.type, message: redactText(diagnostic.message) },
				});
			}
			this.emit({
				type: "event",
				event: {
					type: "state",
					state: "ready",
					sessionId: this.runtime.session.sessionId,
					...(this.runtime.session.sessionFile === undefined
						? {}
						: { sessionFile: this.runtime.session.sessionFile }),
				},
			});
			const model = this.runtime.session.model;
			this.respond(request.id, {
				sessionId: this.runtime.session.sessionId,
				sessionFile: this.runtime.session.sessionFile ?? null,
				model: modelDto(model),
				messages: sessionMessages(this.runtime),
			});
		} catch (error) {
			this.initialized = false;
			this.reject(request.id, "OPERATION_FAILED", errorMessage(error));
		}
	}

	private async dispatch(
		request: Exclude<WorkerRequest, { readonly type: "init" | "ui.resolve" | "shutdown" }>,
	): Promise<void> {
		const runtime = this.runtime!;
		switch (request.type) {
			case "prompt": {
				if (runtime.session.isStreaming || this.activeRun)
					return this.reject(request.id, "OPERATION_FAILED", "Session is already streaming");
				validateSessionInput(request.payload.text, request.payload.attachments);
				const text = appendTextAttachments(request.payload.text, request.payload.attachments);
				const images = imageContentFromAttachments(request.payload.attachments);
				const run: PromptRun = { id: request.payload.runId, abortRequested: false };
				this.activeRun = run;
				this.respond(request.id, { accepted: true });
				this.emit({
					type: "event",
					event: {
						type: "state",
						state: "streaming",
						sessionId: runtime.session.sessionId,
						...(run.id ? { runId: run.id } : {}),
					},
				});
				run.completion = runtime.session
					.prompt(text, {
						source: "rpc",
						...(images.length === 0 ? {} : { images }),
					})
					.then(
						() => this.publishRunOutcome(run),
						(error: unknown) => this.publishRunOutcome(run, errorMessage(error)),
					)
					.finally(() => {
						if (this.activeRun === run) this.activeRun = undefined;
					});
				return;
			}
			case "message": {
				validateSessionInput(request.payload.text, request.payload.attachments);
				const text = appendTextAttachments(request.payload.text, request.payload.attachments);
				const images = imageContentFromAttachments(request.payload.attachments);
				const runId = this.activeRun?.id;
				this.respond(request.id, { accepted: true, delivery: request.payload.deliverAs });
				void runtime.session
					.prompt(text, {
						source: "rpc",
						streamingBehavior: request.payload.deliverAs,
						...(images.length === 0 ? {} : { images }),
					})
					.catch((error: unknown) => {
						const message = redactText(errorMessage(error));
						this.emit({
							type: "event",
							event: {
								type: "state",
								state: "failed",
								sessionId: runtime.session.sessionId,
								message,
								...(runId ? { runId } : {}),
							},
						});
						this.emit({ type: "event", event: { type: "diagnostic", level: "error", message } });
					});
				return;
			}
			case "compact": {
				const result = await runtime.session.compact(request.payload.instructions);
				this.respond(request.id, safeJson(result));
				return;
			}
			case "fork": {
				const result = await runtime.fork(request.payload.entryId, { position: request.payload.position });
				await this.afterSessionReplacement(runtime);
				this.respond(request.id, {
					cancelled: result.cancelled,
					selectedText: result.selectedText ?? null,
					...this.sessionDto(runtime),
				});
				return;
			}
			case "new": {
				const result = await runtime.newSession({ parentSession: request.payload.parentSession });
				await this.afterSessionReplacement(runtime);
				this.respond(request.id, { cancelled: result.cancelled, ...this.sessionDto(runtime) });
				return;
			}
			case "switch": {
				const result = await runtime.switchSession(request.payload.sessionFile);
				await this.afterSessionReplacement(runtime);
				this.respond(request.id, { cancelled: result.cancelled, ...this.sessionDto(runtime) });
				return;
			}
			case "history":
				this.respond(request.id, this.sessionDto(runtime));
				return;
			case "model.list": {
				const models =
					request.payload?.availableOnly === false
						? runtime.services.modelRuntime.getModels()
						: runtime.services.modelRuntime.getAvailableSnapshot();
				this.respond(request.id, safeJson(models.map((model) => modelDto(model))));
				return;
			}
			case "model.select": {
				const model = runtime.services.modelRuntime.getModel(request.payload.provider, request.payload.modelId);
				if (!model) return this.reject(request.id, "NOT_FOUND", "Model was not found");
				await runtime.session.setModel(model, { persist: request.payload.persist });
				this.respond(request.id, modelDto(runtime.session.model as Model<Api> | undefined));
				return;
			}
			case "auth.refresh": {
				const provider = request.payload.provider;
				const result = await runtime.services.modelRuntime.refresh({ providers: [provider], allowNetwork: false });
				const error = result.errors.get(provider);
				if (error) throw error;
				this.respond(request.id, {
					provider,
					configured: runtime.services.modelRuntime.hasConfiguredAuth(provider),
					models: safeJson(runtime.services.modelRuntime.getModels(provider).map((model) => modelDto(model))),
					availableModels: safeJson(
						runtime.services.modelRuntime
							.getAvailableSnapshot()
							.filter((model) => model.provider === provider)
							.map((model) => modelDto(model)),
					),
				});
				return;
			}
			case "catalog.list": {
				const models = runtime.services.modelRuntime.getModels(request.payload?.provider);
				this.respond(request.id, safeJson(models.map((model) => modelDto(model))));
				return;
			}
			case "resources.list": {
				this.respond(request.id, safeJson(listDesktopResources(runtime)));
				return;
			}
			case "resources.run": {
				const result = runDesktopResource(runtime, request.payload.kind, request.payload.id, {
					onCommandError: (error) => {
						const message = redactText(errorMessage(error));
						this.emit({
							type: "event",
							event: { type: "state", state: "failed", sessionId: runtime.session.sessionId, message },
						});
						this.emit({
							type: "event",
							event: {
								type: "diagnostic",
								level: "error",
								message,
								code: "RESOURCE_COMMAND_FAILED",
								operation: "resources.run",
							},
						});
					},
					onCommandComplete: () => {
						this.emit({
							type: "event",
							event: { type: "state", state: "idle", sessionId: runtime.session.sessionId },
						});
					},
				});
				this.respond(request.id, safeJson(result));
				if (result.started)
					this.emit({
						type: "event",
						event: { type: "state", state: "streaming", sessionId: runtime.session.sessionId },
					});
				return;
			}
			case "settings.get": {
				const settings = runtime.services.settingsManager;
				this.respond(request.id, {
					defaultProvider: settings.getDefaultProvider() ?? null,
					defaultModel: settings.getDefaultModel() ?? null,
					defaultThinkingLevel: settings.getDefaultThinkingLevel() ?? null,
					steeringMode: settings.getSteeringMode(),
					followUpMode: settings.getFollowUpMode(),
					compactionEnabled: settings.getCompactionEnabled(),
				});
				return;
			}
			case "settings.update": {
				const settings = runtime.services.settingsManager;
				const payload = request.payload;
				if (payload.defaultModel)
					settings.setDefaultModelAndProvider(payload.defaultModel.provider, payload.defaultModel.modelId);
				if (payload.defaultThinkingLevel) settings.setDefaultThinkingLevel(payload.defaultThinkingLevel);
				if (payload.steeringMode) settings.setSteeringMode(payload.steeringMode);
				if (payload.followUpMode) settings.setFollowUpMode(payload.followUpMode);
				if (payload.compactionEnabled !== undefined) settings.setCompactionEnabled(payload.compactionEnabled);
				this.respond(request.id, { updated: true });
				return;
			}
			case "stats.get":
				this.respond(request.id, safeJson(runtime.session.getSessionStats()));
				return;
			case "mcp.reload":
				if (!runtime.session.isIdle) {
					return this.reject(
						request.id,
						"OPERATION_FAILED",
						"Cannot reload MCP servers while the session is streaming",
					);
				}
				await runtime.session.reload();
				this.respond(request.id, { reloaded: true });
				return;
			case "mcp.list": {
				const manager = this.mcpManager;
				if (!manager) return this.reject(request.id, "OPERATION_FAILED", "MCP manager is not ready");
				this.respond(request.id, safeJson(this.mcpServersDto(manager.getServers())));
				return;
			}
			case "mcp.sign-in": {
				const manager = this.mcpManager;
				if (!manager) return this.reject(request.id, "OPERATION_FAILED", "MCP manager is not ready");
				const name = request.payload.name;
				const result = await manager.signIn(name, {
					showAuthorizationUrl: (url) => {
						this.emit({ type: "event", event: { type: "mcp.auth_url", name, url: url.href } });
					},
					promptForRedirectUrl: async (signal) => {
						const result = await this.requestExtensionDialog(
							{
								type: "input",
								title: `Sign in to MCP server ${name}`,
								placeholder: "http://127.0.0.1/.../callback?code=...",
							},
							{ signal },
						);
						return typeof result === "string" ? result : undefined;
					},
				});
				this.respondMcpActionResult(request.id, result);
				this.emitMcpStatus(manager);
				return;
			}
			case "mcp.sign-out":
				return this.runMcpAction(request.id, async (manager) => manager.signOut(request.payload.name));
			case "mcp.reconnect":
				return this.runMcpAction(request.id, async (manager) => manager.reconnect(request.payload.name));
			case "mcp.set-enabled":
				return this.runMcpAction(request.id, async (manager) =>
					manager.setEnabled(request.payload.name, request.payload.enabled),
				);
			case "mcp.set-exposure":
				return this.runMcpAction(request.id, async (manager) =>
					manager.setExposure(request.payload.name, request.payload.exposure),
				);
			case "mcp.add": {
				const config = this.parseMcpServerConfig(request.id, request.payload.configJson);
				if (!config) return;
				return this.runMcpAction(request.id, async (manager) =>
					manager.addServer(request.payload.name, config, request.payload.scope),
				);
			}
			case "mcp.update": {
				const config = this.parseMcpServerConfig(request.id, request.payload.configJson);
				if (!config) return;
				return this.runMcpAction(request.id, async (manager) => manager.updateServer(request.payload.name, config));
			}
			case "mcp.remove":
				return this.runMcpAction(request.id, async (manager) => manager.removeServer(request.payload.name));
			case "abort":
				this.reject(request.id, "UNSUPPORTED_OPERATION", `Unsupported worker request: ${request.type}`);
		}
	}

	private mcpServersDto(servers: readonly McpManagerServer[]): McpManagerServer[] {
		return servers.map((server) => ({
			name: server.name,
			scope: server.scope,
			enabled: server.enabled,
			exposure: server.exposure,
			state: server.state,
			toolCount: server.toolCount,
			resourceCount: server.resourceCount,
			usesOAuth: server.usesOAuth,
		}));
	}

	private emitMcpStatus(manager: McpManagerHandle): void {
		this.emit({ type: "event", event: { type: "mcp.status", servers: this.mcpServersDto(manager.getServers()) } });
	}

	private bindMcpManager(manager: McpManagerHandle | undefined): void {
		this.unsubscribeMcpManager?.();
		this.unsubscribeMcpManager = undefined;
		this.mcpManager = manager;
		if (manager) {
			this.unsubscribeMcpManager = manager.subscribe(() => this.emitMcpStatus(manager));
			this.emitMcpStatus(manager);
		} else {
			this.emit({ type: "event", event: { type: "mcp.status", servers: [] } });
		}
	}

	private async runMcpAction(
		id: string,
		action: (manager: McpManagerHandle) => Promise<McpManagerActionResult> | McpManagerActionResult,
	): Promise<void> {
		const manager = this.mcpManager;
		if (!manager) return this.reject(id, "OPERATION_FAILED", "MCP manager is not ready");
		const result = await action(manager);
		this.respondMcpActionResult(id, result);
		this.emitMcpStatus(manager);
	}

	private parseMcpServerConfig(id: string, configJson: string) {
		try {
			return parseMcpServerConfigJson(configJson);
		} catch (error) {
			this.reject(id, "INVALID_ARGUMENT", errorMessage(error));
			return undefined;
		}
	}

	private respondMcpActionResult(id: string, result: McpManagerActionResult): void {
		if (!result.ok) {
			this.reject(id, "OPERATION_FAILED", redactText(result.error));
			return;
		}
		this.respond(id, safeJson(result));
	}

	private sessionDto(runtime: AgentSessionRuntime): Record<string, JsonValue> {
		return {
			sessionId: runtime.session.sessionId,
			sessionFile: runtime.session.sessionFile ?? null,
			model: modelDto(runtime.session.model as Model<Api> | undefined),
			messages: sessionMessages(runtime),
		};
	}

	private async afterSessionReplacement(runtime: AgentSessionRuntime): Promise<void> {
		this.unsubscribeSession?.();
		await this.bindDesktopExtensions(runtime);
		this.unsubscribeSession = runtime.session.subscribe((event) => this.publishSessionEvent(event));
		const dto = this.sessionDto(runtime);
		this.emit({
			type: "event",
			event: {
				type: "state",
				state: "ready",
				sessionId: runtime.session.sessionId,
				...(runtime.session.sessionFile === undefined ? {} : { sessionFile: runtime.session.sessionFile }),
			},
		});
		this.emit({
			type: "event",
			event: { type: "diagnostic", level: "info", message: `Session switched to ${String(dto.sessionId)}` },
		});
	}

	private publishRunOutcome(run: PromptRun, error?: string): void {
		if (this.shuttingDown) return;
		const base = {
			type: "state" as const,
			sessionId: this.runtime?.session.sessionId,
			...(run.id ? { runId: run.id } : {}),
		};
		if (run.abortRequested || run.lastAssistant?.stopReason === "aborted") {
			this.emit({ type: "event", event: { ...base, state: "idle", outcome: "aborted" } });
		} else if (error !== undefined || run.lastAssistant?.stopReason === "error") {
			const message = redactText(error ?? run.lastAssistant?.errorMessage ?? "Model request failed");
			this.emit({ type: "event", event: { ...base, state: "failed", message } });
			this.emit({ type: "event", event: { type: "diagnostic", level: "error", message } });
		} else {
			this.emit({ type: "event", event: { ...base, state: "idle", outcome: "completed" } });
		}
	}

	private publishSessionEvent(event: AgentSessionEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant" && this.activeRun)
			this.activeRun.lastAssistant = event.message;
		if (event.type === "agent_start") {
			this.emit({
				type: "event",
				event: {
					type: "state",
					state: "streaming",
					sessionId: this.runtime?.session.sessionId,
					...(this.activeRun?.id ? { runId: this.activeRun.id } : {}),
				},
			});
		} else if (event.type === "agent_settled") {
			// A settled run may still reject (and model errors normally resolve). The owning
			// prompt publishes exactly one outcome once both its events and promise finish.
			if (this.activeRun) return;
			this.emit({
				type: "event",
				event: { type: "state", state: "idle", sessionId: this.runtime?.session.sessionId },
			});
		} else if (event.type === "message_start" || event.type === "message_update") {
			const messageEvent = eventForMessage(event.type === "message_start" ? "start" : "update", event.message);
			if (messageEvent) this.emit(messageEvent);
		} else if (
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_update" ||
			event.type === "tool_execution_end"
		) {
			const args = event.type === "tool_execution_end" ? null : event.args;
			this.emit({
				type: "event",
				event: {
					type: "tool",
					phase:
						event.type === "tool_execution_start"
							? "start"
							: event.type === "tool_execution_update"
								? "update"
								: "end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: safeJson(args),
					...(event.type === "tool_execution_update" ? { result: safeJson(event.partialResult) } : {}),
					...(event.type === "tool_execution_end"
						? { result: safeJson(event.result), isError: event.isError }
						: {}),
				},
			});
		} else if (event.type === "entry_appended" && event.entry.type === "message") {
			const messageEvent = eventForMessage(
				"end",
				event.entry.message,
				event.entry.id,
				toolResultsByCall(this.runtime?.session.sessionManager.getBranch() ?? []),
			);
			if (messageEvent) this.emit(messageEvent);
		} else if (event.type === "session_info_changed") {
			this.emit({
				type: "event",
				event: { type: "ui.update", update: "status", key: "session", message: event.name },
			});
		}
	}

	private requestExtensionDialog(
		request: DesktopExtensionDialogRequest,
		options?: ExtensionUIDialogOptions,
	): Promise<string | boolean | undefined> {
		const signal = options?.signal;
		if (signal?.aborted) return Promise.resolve(undefined);
		const requestId = `ui-${++this.nextUiRequest}`;
		return new Promise((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const finish = (value: string | boolean | undefined, reason?: "aborted" | "timeout" | "closed") => {
				if (settled) return;
				settled = true;
				this.pendingUi.delete(requestId);
				if (timer) clearTimeout(timer);
				if (signal && onAbort) signal.removeEventListener("abort", onAbort);
				if (reason) {
					this.emit({ type: "event", event: { type: "ui.dismiss", requestId, reason } });
				}
				resolve(value);
			};
			const onAbort = signal ? () => finish(undefined, "aborted") : undefined;
			this.pendingUi.set(requestId, {
				resolve: (value) => finish(value),
				dismiss: (reason) => finish(undefined, reason),
			});
			if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });
			const timeout = options?.timeout;
			if (timeout !== undefined && Number.isFinite(timeout) && timeout >= 0) {
				timer = setTimeout(() => finish(undefined, "timeout"), timeout);
			}
			const serializableOptions = options?.timeout === undefined ? {} : { timeout: options.timeout };
			try {
				this.emit({
					type: "event",
					event: {
						type: "ui.request",
						requestId,
						kind: request.type,
						title: redactText(request.title),
						...(request.type === "select" ? { options: request.options.map(redactText) } : {}),
						...(request.type === "confirm" ? { message: redactText(request.message) } : {}),
						...(request.type === "input"
							? { placeholder: request.placeholder === undefined ? undefined : redactText(request.placeholder) }
							: {}),
						...(request.type === "editor"
							? { message: request.prefill === undefined ? undefined : redactText(request.prefill) }
							: {}),
						...(Object.keys(serializableOptions).length === 0
							? {}
							: { dialogOptions: safeJson(serializableOptions) }),
					},
				});
			} catch {
				finish(undefined);
			}
		});
	}

	private async bindDesktopExtensions(runtime: AgentSessionRuntime): Promise<void> {
		const uiContext = createDesktopExtensionUIContext({
			requestDialog: (dialog, dialogOptions) => this.requestExtensionDialog(dialog, dialogOptions),
			notify: (message, level) =>
				this.emit({
					type: "event",
					event: { type: "ui.update", update: "notify", message: redactText(message), level },
				}),
			setStatus: (key, message) =>
				this.emit({
					type: "event",
					event: {
						type: "ui.update",
						update: "status",
						key: redactText(key),
						message: message === undefined ? undefined : redactText(message),
					},
				}),
			setTitle: (title) =>
				this.emit({
					type: "event",
					event: { type: "ui.update", update: "status", key: "title", message: redactText(title) },
				}),
			setWorkingMessage: (message) =>
				this.emit({
					type: "event",
					event: {
						type: "ui.update",
						update: "working",
						message: message === undefined ? undefined : redactText(message),
					},
				}),
			setWorkingVisible: (visible) =>
				this.emit({ type: "event", event: { type: "ui.update", update: "workingVisible", visible } }),
			setWorkingIndicator: (options) =>
				this.emit({
					type: "event",
					event: { type: "ui.update", update: "workingIndicator", value: safeJson(options) },
				}),
			setHiddenThinkingLabel: (label) =>
				this.emit({
					type: "event",
					event: {
						type: "ui.update",
						update: "hiddenThinkingLabel",
						message: label === undefined ? undefined : redactText(label),
					},
				}),
			setWidget: (key, content, options) =>
				this.emit({
					type: "event",
					event: {
						type: "ui.update",
						update: "widget",
						key: redactText(key),
						value: safeJson({ content, options }),
					},
				}),
			pasteToEditor: (text) =>
				this.emit({
					type: "event",
					event: { type: "ui.update", update: "editor", mode: "append", message: redactText(text) },
				}),
			setEditorText: (text) =>
				this.emit({
					type: "event",
					event: { type: "ui.update", update: "editor", mode: "replace", message: redactText(text) },
				}),
			getEditorText: () => "",
			getAllThemes: () => [],
			setTheme: () => {
				const message = "Extension theme selection is unavailable; use the Pi Orbit application theme setting.";
				this.emit({
					type: "event",
					event: {
						type: "diagnostic",
						level: "warning",
						code: "unsupported_desktop_ui",
						operation: "setTheme",
						migration: "Use the desktop theme setting from your extension's desktop adapter.",
						message,
					},
				});
				return { success: false, error: message };
			},
			getToolsExpanded: () => this.extensionToolsExpanded,
			setToolsExpanded: (expanded) => {
				this.extensionToolsExpanded = expanded;
				this.emit({ type: "event", event: { type: "ui.update", update: "toolsExpanded", visible: expanded } });
			},
			reportDiagnostic: (diagnostic) =>
				this.emit({
					type: "event",
					event: {
						type: "diagnostic",
						level: "warning",
						code: diagnostic.code,
						operation: diagnostic.operation,
						migration: diagnostic.migration,
						message: redactText(diagnostic.message),
					},
				}),
		});
		await runtime.session.bindExtensions({ mode: DESKTOP_EXTENSION_MODE, uiContext });
	}
}

/** Install the request handler in the child process created by Electron utilityProcess.fork(). */
export function installDesktopWorker(
	port: DesktopWorkerPort,
	options: DesktopWorkerHostOptions = {},
): DesktopWorkerHost {
	return new DesktopWorkerHost(port, options);
}

export type DesktopWorkerRuntimeFactory = DesktopWorkerHostOptions["createRuntime"];
