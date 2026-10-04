import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AuthEvent, AuthInteraction, CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { getAgentDir, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	createTaskWorktree,
	GitWorkspaceDirtyError,
	inspectProjectChanges,
	inspectTaskWorktree,
	mergeTaskWorktree,
} from "../git/worktrees.ts";
import { type DesktopAttachment, validateAttachments } from "../shared/attachments.ts";
import {
	type DesktopCommand,
	type DesktopCommandPayload,
	isDesktopCommand,
	isValidDesktopPayload,
} from "../shared/commands.ts";
import type {
	DesktopAuthEvent,
	DesktopAuthPrompt,
	DesktopCatalogEntry,
	DesktopChatMessage,
	DesktopEvent,
	DesktopExtensionUiState,
	DesktopMcpAuthEvent,
	DesktopMcpServer,
	DesktopProject,
	DesktopProvider,
	DesktopResult,
	DesktopRole,
	DesktopSession,
	DesktopSessionPolicy,
	DesktopSessionQueue,
	DesktopSessionStats,
	DesktopSessionTree,
	DesktopSnapshot,
	DesktopTask,
	DesktopThinkingState,
} from "../shared/desktop-types.ts";
import { appendTerminalOutput } from "../shared/terminal-output.ts";
import { isWorkerMainRequest, type WorkerEvent, type WorkerMainRequest } from "../shared/worker-protocol.ts";
import { recoverTaskDetail, type TaskDetail, TaskDetailStore } from "../team/task-details.ts";
import { TeamTaskError, type TeamTaskRecord, TeamTaskStore } from "../team/task-store.ts";
import { AppEventLog, type StoredAppEvent } from "./event-log.ts";
import { ProjectRegistry, type StoredProject, type StoredSession } from "./project-registry.ts";
import { ProviderCatalog } from "./provider-catalog.ts";
import { RoleStore } from "./role-store.ts";
import type { TerminalService } from "./terminal-service.ts";
import { AgentWorkerManager, WorkerRequestError, type WorkerTransport } from "./worker-manager.ts";

const execFileAsync = promisify(execFile);
const EMPTY_CATALOG = { skills: [], templates: [], commands: [], extensions: [] } satisfies DesktopSnapshot["catalog"];
type Settings = DesktopSnapshot["settings"];
type SettingsRow = { readonly value: string };
const DEFAULT_SETTINGS: Settings = {
	language: "en",
	theme: "system",
	defaultModel: "",
	confirmToolCalls: true,
	sendShortcut: "enter",
	subagentsEnabled: false,
	maxParallelTasks: 4,
};
const SESSION_ADMISSION_COMMANDS = new Set<DesktopCommand>([
	"session.prompt",
	"settings.save",
	"provider.save",
	"provider.remove",
	"auth.configure",
	"auth.clear",
	"auth.logout",
]);

function validateSessionInput(text: string, attachments: readonly DesktopAttachment[] | undefined): void {
	if (!text.trim() && (!attachments || attachments.length === 0))
		throw new DesktopAppError("INVALID_ARGUMENT", "Enter a message or attach a file.");
	try {
		validateAttachments(attachments);
	} catch (error) {
		throw new DesktopAppError("INVALID_ARGUMENT", error instanceof Error ? error.message : "Invalid attachment.");
	}
}

type WorkerInit = {
	sessionId: string;
	sessionFile: string | null;
	sessionName?: string;
	leafId?: string;
	model: unknown;
	messages: unknown;
	toolPolicy?: DesktopSessionPolicy;
};
type WorkerMessage = Extract<WorkerEvent["event"], { type: "message" }>;
type Listener = (event: DesktopEvent) => void;

export type DesktopAppServiceOptions = {
	dataDirectory: string;
	agentDirectory?: string;
	createWorkerTransport: () => WorkerTransport;
	createTerminalService?: (
		onOutput: (terminalId: string, text: string) => void,
		onExit: (terminalId: string) => void,
	) => TerminalService;
	createProviderModels?: (credentials: CredentialStore) => MutableModels;
	onAuthEvent?: (event: DesktopAuthEvent) => void;
	onMcpAuthEvent?: (event: DesktopMcpAuthEvent) => void;
	openExternal?: (url: string) => Promise<void>;
	chooseProjectDirectory?: (defaultPath?: string) => Promise<string | undefined>;
	chooseSessionFile?: () => Promise<string | undefined>;
	chooseSessionExportFile?: (title: string, format: "html" | "jsonl") => Promise<string | undefined>;
};

type PendingAuthFlow = { readonly controller: AbortController; readonly promptIds: Set<string> };
type PendingAuthPrompt = { readonly flowId: string; resolve(value: string): void; reject(error: Error): void };

export class DesktopAppError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "DesktopAppError";
		this.code = code;
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new DesktopAppError("INVALID_WORKER_RESPONSE", `Worker omitted ${field}`);
	return value;
}

function modelName(value: unknown): string {
	const model = record(value);
	return model && typeof model.provider === "string" && typeof model.id === "string"
		? `${model.provider}/${model.id}`
		: "";
}

function parseModelName(value: string): { provider: string; modelId: string } {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1)
		throw new DesktopAppError("INVALID_MODEL", "Choose a provider/model pair");
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function mcpServerViews(value: unknown): DesktopMcpServer[] {
	if (!Array.isArray(value) || value.length > 256)
		throw new DesktopAppError("INVALID_WORKER_RESPONSE", "Worker returned an invalid MCP server list");
	return value.map((item): DesktopMcpServer => {
		const server = record(item);
		if (
			!server ||
			typeof server.name !== "string" ||
			server.name.length < 1 ||
			server.name.length > 256 ||
			(server.scope !== undefined &&
				server.scope !== "global" &&
				server.scope !== "project" &&
				server.scope !== "extension") ||
			typeof server.enabled !== "boolean" ||
			(server.exposure !== "codemode" &&
				server.exposure !== "deferred" &&
				server.exposure !== "direct" &&
				server.exposure !== "hidden") ||
			(server.state !== "disabled" &&
				server.state !== "connecting" &&
				server.state !== "connected" &&
				server.state !== "disconnected" &&
				server.state !== "needs-auth" &&
				server.state !== "failed" &&
				server.state !== "closed") ||
			!Number.isSafeInteger(server.toolCount) ||
			Number(server.toolCount) < 0 ||
			!Number.isSafeInteger(server.resourceCount) ||
			Number(server.resourceCount) < 0 ||
			typeof server.usesOAuth !== "boolean"
		)
			throw new DesktopAppError("INVALID_WORKER_RESPONSE", "Worker returned an invalid MCP server");
		return {
			name: server.name,
			...(server.scope === undefined ? {} : { scope: server.scope }),
			enabled: server.enabled,
			exposure: server.exposure,
			state: server.state,
			toolCount: Number(server.toolCount),
			resourceCount: Number(server.resourceCount),
			usesOAuth: server.usesOAuth,
		};
	});
}

function mcpActionResult(value: unknown): { changed?: boolean; reloadRequired?: boolean } {
	const result = record(value);
	if (!result) throw new DesktopAppError("INVALID_WORKER_RESPONSE", "Worker returned an invalid MCP action result");
	if (result.ok === false)
		throw new DesktopAppError(
			"MCP_ACTION_FAILED",
			typeof result.error === "string" ? result.error : "MCP action failed",
		);
	if (result.ok !== true && result.changed === undefined && result.reloadRequired === undefined)
		throw new DesktopAppError("INVALID_WORKER_RESPONSE", "Worker returned an invalid MCP action result");
	return {
		...(typeof result.changed === "boolean" ? { changed: result.changed } : {}),
		...(typeof result.reloadRequired === "boolean" ? { reloadRequired: result.reloadRequired } : {}),
	};
}

function workerInit(value: unknown): WorkerInit {
	const data = record(value);
	if (!data) throw new DesktopAppError("INVALID_WORKER_RESPONSE", "Worker did not return session details");
	const policy = record(data.toolPolicy);
	return {
		sessionId: requiredString(data.sessionId, "sessionId"),
		sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : null,
		...(typeof data.sessionName === "string" ? { sessionName: data.sessionName } : {}),
		...(typeof data.leafId === "string" ? { leafId: data.leafId } : {}),
		model: data.model,
		messages: data.messages,
		...(policy && (policy.mode === "build" || policy.mode === "plan") && typeof policy.confirmToolCalls === "boolean"
			? { toolPolicy: { mode: policy.mode, confirmToolCalls: policy.confirmToolCalls } }
			: {}),
	};
}

function sessionQueue(value: unknown): DesktopSessionQueue {
	const data = record(value);
	if (
		!data ||
		!Array.isArray(data.steering) ||
		!Array.isArray(data.followUp) ||
		!data.steering.every((entry) => typeof entry === "string") ||
		!data.followUp.every((entry) => typeof entry === "string") ||
		!Number.isSafeInteger(data.pendingCount) ||
		Number(data.pendingCount) < 0
	)
		throw new DesktopAppError("INVALID_WORKER_RESPONSE", "Worker returned an invalid message queue");
	return {
		steering: data.steering,
		followUp: data.followUp,
		pendingCount: Number(data.pendingCount),
		...(data.truncated === true ? { truncated: true } : {}),
	};
}

function chatParts(value: unknown, fallbackText: string): DesktopChatMessage["parts"] {
	if (!Array.isArray(value)) return [{ kind: "text", text: fallbackText }];
	const parts = value.slice(0, 32).flatMap((item): DesktopChatMessage["parts"] => {
		const part = record(item);
		if (!part) return [];
		if ((part.kind === "text" || part.kind === "thinking") && typeof part.text === "string")
			return [{ kind: part.kind, text: part.text }];
		if (part.kind === "image" && typeof part.mimeType === "string")
			return [{ kind: "image", mimeType: part.mimeType }];
		if (
			part.kind === "tool" &&
			typeof part.name === "string" &&
			(part.status === "running" || part.status === "complete" || part.status === "error")
		)
			return [
				{
					kind: "tool",
					name: part.name,
					status: part.status,
					...(typeof part.input === "string" ? { input: part.input } : {}),
					...(typeof part.output === "string" ? { output: part.output } : {}),
				},
			];
		return [];
	});
	return parts.length > 0 ? parts : [{ kind: "text", text: fallbackText }];
}

function sessionView(session: StoredSession): DesktopSession {
	return {
		id: session.id,
		projectId: session.projectId,
		title: session.title,
		updatedAt: session.updatedAt,
		model: session.model,
		status: session.status,
		archived: session.archived === true,
	};
}

function taskView(task: TeamTaskRecord, roleName: string, detail?: TaskDetail): DesktopTask {
	return {
		id: task.id,
		projectId: task.projectId,
		...(task.parentTaskId === null ? {} : { parentTaskId: task.parentTaskId }),
		roleId: task.roleId,
		roleName,
		prompt: task.prompt,
		dependsOn: [...task.dependsOn],
		status: task.status,
		...(task.baseCommit === null ? {} : { baseCommit: task.baseCommit }),
		...(task.worktreePath === null ? {} : { worktreePath: task.worktreePath }),
		...(task.sessionFile === null ? {} : { sessionFile: task.sessionFile }),
		...(task.lastSettledEntryId === null ? {} : { lastSettledEntryId: task.lastSettledEntryId }),
		updatedAt: new Date(task.updatedAt).toISOString(),
		resultSummary: task.blockedReason ?? detail?.resultSummary,
		filesChanged: detail?.changes.length ?? 0,
		usage: detail?.usage,
		messages: detail?.messages ?? [],
		toolRecords: detail?.toolRecords ?? [],
		changes: detail?.changes ?? [],
	};
}

/** Main process owns project state, task state, event order, and agent lifetimes. */
export class DesktopAppService {
	private readonly db: SqliteDatabase;
	private readonly dataDirectory: string;
	private readonly agentDirectory: string;
	private readonly team: TeamTaskStore;
	private readonly taskDetailStore: TaskDetailStore;
	private readonly registry: ProjectRegistry;
	private readonly roles: RoleStore;
	private readonly providerCatalog: ProviderCatalog;
	private readonly events: AppEventLog;
	private readonly workers: AgentWorkerManager;
	private readonly terminalService?: TerminalService;
	private terminalState?: NonNullable<DesktopSnapshot["terminal"]>;
	private readonly pendingUiRequests = new Map<string, { key: string; requestId: string; generation: string }>();
	private readonly workerGenerations = new Map<string, string>();
	private readonly listeners = new Set<Listener>();
	private readonly taskDetails = new Map<string, TaskDetail>();
	private readonly taskRunIds = new Map<string, string>();
	private readonly taskCancellationRequests = new Set<string>();
	private readonly sessionRunIds = new Map<string, string>();
	private readonly sessionControlTails = new Map<string, Promise<unknown>>();
	private readonly sessionWorkerStarts = new Map<string, Promise<void>>();
	private readonly sessionQueues = new Map<string, DesktopSessionQueue>();
	private readonly taskControlTails = new Map<string, Promise<unknown>>();
	private readonly taskScheduleTails = new Map<string, Promise<void>>();
	private settingsSaveTail: Promise<unknown> = Promise.resolve();
	private sessionAdmissionTail: Promise<unknown> = Promise.resolve();
	private taskAdmissionTail: Promise<unknown> = Promise.resolve();
	private readonly messageIds = new Map<string, string>();
	private readonly sessionMessageCache = new Map<string, DesktopChatMessage[]>();
	private readonly extensionUi = new Map<string, DesktopExtensionUiState>();
	private readonly mcpServersByWorker = new Map<string, DesktopMcpServer[]>();
	private readonly pendingTaskWaits = new Set<() => void>();
	private readonly pendingAuthFlows = new Map<string, PendingAuthFlow>();
	private readonly pendingAuthPrompts = new Map<string, PendingAuthPrompt>();
	private readonly onAuthEvent?: (event: DesktopAuthEvent) => void;
	private readonly onMcpAuthEvent?: (event: DesktopMcpAuthEvent) => void;
	private readonly openExternal?: (url: string) => Promise<void>;
	private readonly chooseProjectDirectory?: (defaultPath?: string) => Promise<string | undefined>;
	private readonly chooseSessionFile?: () => Promise<string | undefined>;
	private readonly chooseSessionExportFile?: (title: string, format: "html" | "jsonl") => Promise<string | undefined>;
	private readonly rolesById = new Map<string, string>();
	private activeMessages: DesktopChatMessage[] = [];
	private providerCache: DesktopProvider[] = [];
	private catalogCache: DesktopSnapshot["catalog"] = EMPTY_CATALOG;
	private lastPublished = 0;
	private workerEventTail: Promise<void> = Promise.resolve();
	private workerUiEventTail: Promise<void> = Promise.resolve();
	private eventPublishTail: Promise<void> = Promise.resolve();
	private closing = false;

	private constructor(
		db: SqliteDatabase,
		team: TeamTaskStore,
		taskDetailStore: TaskDetailStore,
		registry: ProjectRegistry,
		events: AppEventLog,
		options: DesktopAppServiceOptions,
	) {
		this.db = db;
		this.team = team;
		this.taskDetailStore = taskDetailStore;
		this.dataDirectory = options.dataDirectory;
		this.agentDirectory = options.agentDirectory ?? getAgentDir();
		this.registry = registry;
		this.roles = new RoleStore(this.agentDirectory);
		this.providerCatalog = new ProviderCatalog(this.agentDirectory, options.createProviderModels);
		this.onAuthEvent = options.onAuthEvent;
		this.onMcpAuthEvent = options.onMcpAuthEvent;
		this.openExternal = options.openExternal;
		this.chooseProjectDirectory = options.chooseProjectDirectory;
		this.chooseSessionFile = options.chooseSessionFile;
		this.chooseSessionExportFile = options.chooseSessionExportFile;
		this.events = events;
		this.workers = new AgentWorkerManager({
			createProcess: options.createWorkerTransport,
			onEvent: (key, event) => {
				const generation = this.workerGenerations.get(key);
				if (!generation) return;
				if (event.type === "main.request") {
					void this.handleMainRequest(key, event).catch((error: unknown) => {
						this.emitDiagnostic("MAIN_REQUEST_FAILED", error instanceof Error ? error.message : String(error));
					});
					return;
				}
				if (event.type === "ui.request" || event.type === "ui.dismiss") {
					// Starting or stopping a worker can await an extension dialog. Deliver
					// dialogs in their own ordered queue, independent of lifecycle operations.
					this.workerUiEventTail = this.workerUiEventTail
						.then(() => this.handleWorkerEvent(key, event, generation))
						.catch((error: unknown) => {
							this.emitDiagnostic(
								"WORKER_UI_EVENT_FAILED",
								error instanceof Error ? error.message : String(error),
							);
						});
					return;
				}
				this.workerEventTail = this.workerEventTail
					.then(() => this.handleWorkerEvent(key, event, generation))
					.catch((error: unknown) => {
						this.emitDiagnostic("WORKER_EVENT_FAILED", error instanceof Error ? error.message : String(error));
					});
			},
			onUnexpectedExit: (key, code) => {
				const generation = this.workerGenerations.get(key);
				if (!generation) return;
				this.workerEventTail = this.workerEventTail.then(() => this.handleWorkerExit(key, code, generation));
				this.workerEventTail = this.workerEventTail.catch((error: unknown) => {
					this.emitDiagnostic(
						"WORKER_EXIT_HANDLING_FAILED",
						error instanceof Error ? error.message : String(error),
					);
				});
			},
		});
		this.terminalService = options.createTerminalService?.(
			(terminalId, output) => {
				if (this.terminalState?.id === terminalId) {
					this.terminalState = {
						...this.terminalState,
						...appendTerminalOutput(this.terminalState, output),
					};
				}
				void this.recordEvent("terminal.output", { terminalId, text: output });
			},
			(terminalId) => {
				if (this.terminalState?.id !== terminalId) return;
				this.terminalState = { ...this.terminalState, state: "exited" };
				void this.emitSnapshot();
			},
		);
	}

	static async open(options: DesktopAppServiceOptions): Promise<DesktopAppService> {
		await mkdir(options.dataDirectory, { recursive: true });
		const db = await openNodeSqliteDatabase(join(options.dataDirectory, "orbit.sqlite"));
		const team = await TeamTaskStore.openDatabase(db);
		try {
			const taskDetailStore = await TaskDetailStore.open(db);
			const registry = await ProjectRegistry.open(db);
			const events = await AppEventLog.open(db);
			await db.exec(
				"CREATE TABLE IF NOT EXISTS desktop_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
			);
			const service = new DesktopAppService(db, team, taskDetailStore, registry, events, options);
			service.lastPublished = await events.latestSequence();
			service.providerCache = await service.providerCatalog.list();
			await service.recoverTaskDetails();
			return service;
		} catch (error) {
			await team.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		for (const cancel of this.pendingTaskWaits) cancel();
		for (const flow of this.pendingAuthFlows.values()) flow.controller.abort();
		for (const prompt of this.pendingAuthPrompts.values()) prompt.reject(new Error("Login cancelled"));
		this.pendingAuthPrompts.clear();
		this.terminalService?.closeAll();
		// A lifecycle event may be waiting for a worker's startup dialog. Stop those
		// workers first, then drain the operations their exit settles.
		await this.workers.stopAll();
		await this.workerEventTail;
		await this.workerUiEventTail;
		await Promise.allSettled([...this.taskControlTails.values()]);
		await Promise.allSettled([...this.sessionControlTails.values(), ...this.sessionWorkerStarts.values()]);
		await Promise.allSettled([this.sessionAdmissionTail, this.taskAdmissionTail]);
		await Promise.allSettled([...this.taskScheduleTails.values()]);
		await Promise.allSettled([this.settingsSaveTail]);
		for (const requestId of [...this.pendingUiRequests.keys()]) await this.dismissPendingUiRequest(requestId);
		await this.eventPublishTail;
		await this.team.close();
		this.listeners.clear();
	}

	private async recoverTaskDetails(): Promise<void> {
		for (const task of (await this.team.snapshot()).tasks) {
			const stored = await this.taskDetailStore.get(task.id);
			let recovered: ReturnType<typeof recoverTaskDetail> | undefined;
			try {
				recovered = recoverTaskDetail(task);
			} catch (error) {
				this.emitDiagnostic("TASK_HISTORY_FAILED", error instanceof Error ? error.message : String(error));
			}
			const detail: TaskDetail = {
				messages: recovered?.messages.length ? recovered.messages : (stored?.messages ?? []),
				toolRecords: recovered?.toolRecords.length ? recovered.toolRecords : (stored?.toolRecords ?? []),
				changes: stored?.changes ?? [],
				...((recovered?.resultSummary ?? stored?.resultSummary)
					? { resultSummary: recovered?.resultSummary ?? stored?.resultSummary }
					: {}),
				...((recovered?.usage ?? stored?.usage) ? { usage: recovered?.usage ?? stored?.usage } : {}),
			};
			if (task.worktreePath && task.baseCommit && ["review", "completed", "merged"].includes(task.status)) {
				try {
					detail.changes = [
						...(await inspectTaskWorktree({ worktreePath: task.worktreePath, baseCommit: task.baseCommit })),
					];
				} catch (error) {
					this.emitDiagnostic("TASK_DIFF_FAILED", error instanceof Error ? error.message : String(error));
				}
			}
			this.taskDetails.set(task.id, detail);
			await this.taskDetailStore.save(task.id, detail);
			if (recovered?.lastSettledEntryId && recovered.lastSettledEntryId !== task.lastSettledEntryId)
				await this.team.updateTask(task.id, { lastSettledEntryId: recovered.lastSettledEntryId });
		}
		this.lastPublished = await this.events.latestSequence();
	}

	async subscribe(afterSequence: number, listener: Listener): Promise<() => void> {
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
			throw new DesktopAppError("INVALID_ARGUMENT", "Invalid event sequence");
		let replaying = true;
		let lastSequence = afterSequence;
		const pending: DesktopEvent[] = [];
		const deliver = (event: DesktopEvent): void => {
			if (event.seq <= lastSequence) return;
			lastSequence = event.seq;
			listener(event);
		};
		const liveListener: Listener = (event) => {
			if (replaying) pending.push(event);
			else deliver(event);
		};
		this.listeners.add(liveListener);
		try {
			for (const event of await this.events.eventsSince(afterSequence)) deliver(this.mapEvent(event));
			replaying = false;
			pending.sort((a, b) => a.seq - b.seq);
			for (const event of pending) deliver(event);
		} catch (error) {
			this.listeners.delete(liveListener);
			throw error;
		}
		return () => this.listeners.delete(liveListener);
	}

	async snapshot(): Promise<DesktopSnapshot> {
		// Mark the replay boundary before reading state. Events committed while the snapshot is
		// assembled will then be replayed to subscribers instead of hidden behind its sequence.
		const lastEventSeq = await this.events.latestSequence();
		const storedProjects = await this.registry.listProjects();
		const projects = await Promise.all(storedProjects.map((project) => this.projectView(project)));
		const activeProjectId = await this.registry.getActiveProjectId();
		const activeProject = activeProjectId ? await this.registry.getProject(activeProjectId) : undefined;
		const roles = activeProject ? await this.roles.list(activeProject.path) : [];
		this.rolesById.clear();
		for (const role of roles) this.rolesById.set(role.id, role.name);
		const taskSnapshot = await this.team.snapshot();
		const activeSessionId = await this.registry.getActiveSessionId();
		return {
			lastEventSeq,
			projects,
			...(activeProjectId === undefined ? {} : { activeProjectId }),
			sessions: (await this.registry.listSessions()).map(sessionView),
			...(activeSessionId === undefined ? {} : { activeSessionId }),
			messages: this.activeMessages,
			sessionQueues: Object.fromEntries(this.sessionQueues),
			tasks: taskSnapshot.tasks.map((task) =>
				taskView(task, this.rolesById.get(task.roleId) ?? task.roleId, this.taskDetails.get(task.id)),
			),
			roles,
			catalog: this.catalogCache,
			providers: this.providerCache,
			mcpServers: activeSessionId ? (this.mcpServersByWorker.get(`session:${activeSessionId}`) ?? []) : [],
			extensionUi: Object.fromEntries(this.extensionUi),
			settings: await this.readSettings(),
			features: { terminal: this.terminalService !== undefined, desktopExtensions: true },
			...(this.terminalState === undefined ? {} : { terminal: this.terminalState }),
			capabilities: {
				terminal: this.terminalService
					? { available: true }
					: { available: false, diagnostic: "PTY service is not initialized" },
				catalog: {
					available:
						this.catalogCache.skills.length +
							this.catalogCache.templates.length +
							this.catalogCache.commands.length +
							this.catalogCache.extensions.length >
						0,
					diagnostic: "Pi resources are loaded when a session starts",
				},
			},
		};
	}

	async invoke(command: unknown, payload: unknown): Promise<DesktopResult<unknown>> {
		if (this.closing) return { ok: false, code: "SHUTTING_DOWN", message: "Application is closing" };
		if (!isDesktopCommand(command) || !isValidDesktopPayload(command, payload)) {
			return { ok: false, code: "INVALID_ARGUMENT", message: "Invalid command or request payload" };
		}
		try {
			const data = await this.runCommand(command, payload);
			await this.publishCommitted();
			return { ok: true, data };
		} catch (error) {
			const code =
				error instanceof DesktopAppError
					? error.code
					: error instanceof WorkerRequestError
						? error.code
						: error instanceof GitWorkspaceDirtyError
							? "WORKSPACE_DIRTY"
							: error instanceof TeamTaskError
								? error.code
								: "OPERATION_FAILED";
			return { ok: false, code, message: error instanceof Error ? error.message : String(error) };
		}
	}

	private async runCommand(command: DesktopCommand, payload: unknown, admitted = false): Promise<unknown> {
		if (!admitted && SESSION_ADMISSION_COMMANDS.has(command)) {
			const operation = this.sessionAdmissionTail
				.catch(() => {})
				.then(() => {
					if (this.closing) throw new DesktopAppError("SHUTTING_DOWN", "Application is closing");
					return command === "session.prompt" || command === "settings.save"
						? this.runCommand(command, payload, true)
						: this.withTaskAdmission(() => this.runCommand(command, payload, true));
				});
			this.sessionAdmissionTail = operation;
			return operation;
		}
		switch (command) {
			case "app.snapshot":
				return this.snapshot();
			case "app.quit":
				return { closing: true };
			case "project.browse": {
				if (!this.chooseProjectDirectory)
					throw new DesktopAppError("DIALOG_UNAVAILABLE", "The native folder picker is unavailable");
				const input = payload as DesktopCommandPayload<"project.browse">;
				return { path: (await this.chooseProjectDirectory(input.path)) ?? null };
			}
			case "project.open": {
				const input = payload as DesktopCommandPayload<"project.open">;
				const previousProjectId = await this.registry.getActiveProjectId();
				const project = await this.registry.openProject(input.path);
				if (previousProjectId !== project.id) {
					this.activeMessages = [];
					this.catalogCache = EMPTY_CATALOG;
				}
				await this.emitSnapshot();
				return this.projectView(project);
			}
			case "project.create": {
				const input = payload as DesktopCommandPayload<"project.create">;
				const project = await this.registry.createProject(input.path, input.name);
				this.activeMessages = [];
				this.catalogCache = EMPTY_CATALOG;
				await this.emitSnapshot();
				return this.projectView(project);
			}
			case "project.changes": {
				const { projectId, mode, ref } = payload as DesktopCommandPayload<"project.changes">;
				const project = await this.registry.getProject(projectId);
				if (!project) throw new DesktopAppError("PROJECT_NOT_FOUND", "Unknown project");
				return inspectProjectChanges({ projectPath: project.path, mode, ref });
			}
			case "session.create":
				return this.createSession(payload as DesktopCommandPayload<"session.create">);
			case "session.import": {
				const { projectId } = payload as DesktopCommandPayload<"session.import">;
				return this.importSession(projectId);
			}
			case "session.export": {
				const { sessionId, format = "html" } = payload as DesktopCommandPayload<"session.export">;
				const session = await this.requireSession(sessionId);
				if (!this.chooseSessionExportFile)
					throw new DesktopAppError("DIALOG_UNAVAILABLE", "The session export picker is unavailable");
				const path = await this.chooseSessionExportFile(session.title, format);
				if (!path) return { exported: false };
				await this.ensureSessionWorker(sessionId);
				await this.workers.request(`session:${sessionId}`, "session.export", { path, format }, 600_000);
				return { exported: true, path };
			}
			case "session.select":
				return this.withSessionControl((payload as DesktopCommandPayload<"session.select">).sessionId, () =>
					this.selectSession((payload as DesktopCommandPayload<"session.select">).sessionId),
				);
			case "session.archive":
			case "session.restore": {
				const { sessionId } = payload as DesktopCommandPayload<"session.archive">;
				const archived = command === "session.archive";
				return this.withSessionControl(sessionId, async () => {
					const session = await this.requireSession(sessionId);
					if (archived && session.status === "running")
						throw new DesktopAppError("SESSION_BUSY", "Wait for the session to finish before archiving it");
					if (archived) {
						await this.sessionWorkerStarts.get(sessionId);
					}
					const wasActive = (await this.registry.getActiveSessionId()) === sessionId;
					await this.registry.setSessionArchived(sessionId, archived);
					if (archived) {
						this.sessionRunIds.delete(sessionId);
						this.sessionQueues.delete(sessionId);
						await this.workers.stop(`session:${sessionId}`);
					}
					if (archived && wasActive) {
						this.activeMessages = [];
						this.catalogCache = EMPTY_CATALOG;
					}
					await this.emitSnapshot();
					return { archived };
				});
			}
			case "session.policy.get":
			case "session.policy.set": {
				const input = payload as DesktopCommandPayload<"session.policy.set">;
				await this.ensureSessionWorker(input.sessionId);
				const result = await this.workers.request(
					`session:${input.sessionId}`,
					command === "session.policy.get" ? "tool.policy.get" : "tool.policy.set",
					command === "session.policy.get" ? {} : { mode: input.mode },
				);
				if (command === "session.policy.set") {
					await this.db.run(
						"INSERT INTO desktop_preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
						`session-tool-mode:${input.sessionId}`,
						input.mode,
					);
				}
				return result;
			}
			case "session.queue.get":
			case "session.queue.clear": {
				const { sessionId } = payload as DesktopCommandPayload<"session.queue.get">;
				await this.ensureSessionWorker(sessionId);
				const result = sessionQueue(
					await this.workers.request(
						`session:${sessionId}`,
						command === "session.queue.get" ? "queue.get" : "queue.clear",
						{},
					),
				);
				// Clear returns the removed entries so the renderer can recover them explicitly.
				if (command === "session.queue.get") this.sessionQueues.set(sessionId, result);
				else this.sessionQueues.set(sessionId, { steering: [], followUp: [], pendingCount: 0 });
				await this.emitSnapshot();
				return result;
			}
			case "session.rename": {
				const input = payload as DesktopCommandPayload<"session.rename">;
				const title = input.title.trim();
				if (!title || /[\u0000-\u001f\u007f]/.test(title))
					throw new DesktopAppError("INVALID_ARGUMENT", "Session names must be 1–200 characters on a single line");
				await this.requireSession(input.sessionId);
				await this.ensureSessionWorker(input.sessionId);
				await this.workers.request(`session:${input.sessionId}`, "session.rename", { title });
				await this.registry.renameSession(input.sessionId, title);
				await this.emitSnapshot();
				return sessionView(await this.requireSession(input.sessionId));
			}
			case "session.prompt": {
				const input = payload as DesktopCommandPayload<"session.prompt">;
				validateSessionInput(input.text, input.attachments);
				return this.withSessionControl(input.sessionId, async () => {
					if ((await this.requireSession(input.sessionId)).status === "running")
						throw new DesktopAppError("SESSION_BUSY", "The session is already running");
					await this.ensureSessionWorker(input.sessionId);
					const runId = randomUUID();
					this.sessionRunIds.set(input.sessionId, runId);
					await this.setSessionStatus(input.sessionId, "running");
					try {
						await this.workers.request(`session:${input.sessionId}`, "prompt", {
							text: input.text,
							runId,
							...(input.attachments === undefined ? {} : { attachments: input.attachments }),
						});
					} catch (error) {
						if (this.sessionRunIds.get(input.sessionId) === runId) {
							this.sessionRunIds.delete(input.sessionId);
							await this.setSessionStatus(input.sessionId, "error");
						}
						throw error;
					}
					await this.emitSnapshot();
					return { accepted: true };
				});
			}
			case "session.message": {
				const input = payload as DesktopCommandPayload<"session.message">;
				validateSessionInput(input.text, input.attachments);
				if ((await this.requireSession(input.sessionId)).status !== "running")
					throw new DesktopAppError("SESSION_NOT_RUNNING", "Session must be running to receive a message");
				return this.workers.request(`session:${input.sessionId}`, "message", {
					text: input.text,
					expectedRunId: this.sessionRunIds.get(input.sessionId),
					deliverAs: input.deliverAs,
					...(input.attachments === undefined ? {} : { attachments: input.attachments }),
				});
			}
			case "session.abort": {
				const input = payload as DesktopCommandPayload<"session.abort">;
				await this.workers.request(`session:${input.sessionId}`, "abort", {});
				return { aborted: true };
			}
			case "session.compact": {
				const input = payload as DesktopCommandPayload<"session.compact">;
				await this.ensureSessionWorker(input.sessionId);
				const result = await this.workers.request(
					`session:${input.sessionId}`,
					"compact",
					{
						...(input.instructions ? { instructions: input.instructions } : {}),
					},
					600_000,
				);
				await this.refreshSessionHistory(input.sessionId);
				await this.emitSnapshot();
				return { compacted: record(result)?.aborted !== true };
			}
			case "session.fork": {
				const { sessionId, entryId, position } = payload as DesktopCommandPayload<"session.fork">;
				return this.forkSession(sessionId, false, entryId, position);
			}
			case "session.clone":
				return this.forkSession((payload as DesktopCommandPayload<"session.clone">).sessionId, true);
			case "session.tree": {
				const { sessionId } = payload as DesktopCommandPayload<"session.tree">;
				await this.ensureSessionWorker(sessionId);
				return this.workers.request(`session:${sessionId}`, "tree.get", {}) as Promise<DesktopSessionTree>;
			}
			case "session.navigate": {
				const { sessionId, entryId } = payload as DesktopCommandPayload<"session.navigate">;
				await this.ensureSessionWorker(sessionId);
				const result = record(
					await this.workers.request(`session:${sessionId}`, "tree.navigate", { entryId }, 600_000),
				);
				if (result?.cancelled === true) return { navigated: false };
				await this.refreshSessionHistory(sessionId);
				await this.emitSnapshot();
				return {
					navigated: true,
					...(typeof result?.editorText === "string" ? { editorText: result.editorText } : {}),
				};
			}
			case "session.stats": {
				const { sessionId } = payload as DesktopCommandPayload<"session.stats">;
				await this.ensureSessionWorker(sessionId);
				return this.workers.request(`session:${sessionId}`, "stats.get", {}) as Promise<DesktopSessionStats>;
			}
			case "session.thinking.get": {
				const { sessionId } = payload as DesktopCommandPayload<"session.thinking.get">;
				await this.ensureSessionWorker(sessionId);
				return this.workers.request(`session:${sessionId}`, "thinking.get", {}) as Promise<DesktopThinkingState>;
			}
			case "session.thinking.set": {
				const { sessionId, level } = payload as DesktopCommandPayload<"session.thinking.set">;
				await this.ensureSessionWorker(sessionId);
				return this.workers.request(`session:${sessionId}`, "thinking.set", {
					level,
				}) as Promise<DesktopThinkingState>;
			}
			case "session.reload": {
				const { sessionId } = payload as DesktopCommandPayload<"session.reload">;
				await this.ensureSessionWorker(sessionId);
				await this.workers.request(`session:${sessionId}`, "resources.reload", {}, 600_000);
				await this.refreshWorkerCatalog(`session:${sessionId}`);
				await this.emitSnapshot();
				return { reloaded: true };
			}
			case "model.select": {
				const input = payload as DesktopCommandPayload<"model.select">;
				await this.ensureSessionWorker(input.sessionId);
				const model = parseModelName(input.model);
				await this.workers.request(`session:${input.sessionId}`, "model.select", { ...model, persist: false });
				const current = await this.requireSession(input.sessionId);
				await this.registry.upsertSession({ ...current, model: input.model, updatedAt: new Date().toISOString() });
				await this.emitSnapshot();
				return { model: input.model };
			}
			case "mcp.list": {
				const input = payload as DesktopCommandPayload<"mcp.list">;
				const servers = mcpServerViews(await this.requestMcp(input.sessionId, "mcp.list", {}));
				this.mcpServersByWorker.set(`session:${input.sessionId}`, servers);
				return servers;
			}
			case "mcp.sign-in": {
				const input = payload as DesktopCommandPayload<"mcp.sign-in">;
				return mcpActionResult(
					await this.requestMcp(input.sessionId, "mcp.sign-in", { name: input.name }, 600_000),
				);
			}
			case "mcp.sign-out": {
				const input = payload as DesktopCommandPayload<"mcp.sign-out">;
				return mcpActionResult(await this.requestMcp(input.sessionId, "mcp.sign-out", { name: input.name }));
			}
			case "mcp.reconnect": {
				const input = payload as DesktopCommandPayload<"mcp.reconnect">;
				return mcpActionResult(await this.requestMcp(input.sessionId, "mcp.reconnect", { name: input.name }));
			}
			case "mcp.set-enabled": {
				const input = payload as DesktopCommandPayload<"mcp.set-enabled">;
				return mcpActionResult(
					await this.requestMcp(input.sessionId, "mcp.set-enabled", { name: input.name, enabled: input.enabled }),
				);
			}
			case "mcp.set-exposure": {
				const input = payload as DesktopCommandPayload<"mcp.set-exposure">;
				return mcpActionResult(
					await this.requestMcp(input.sessionId, "mcp.set-exposure", {
						name: input.name,
						exposure: input.exposure,
					}),
				);
			}
			case "mcp.add": {
				const input = payload as DesktopCommandPayload<"mcp.add">;
				return mcpActionResult(
					await this.requestMcp(input.sessionId, "mcp.add", {
						name: input.name,
						scope: input.scope,
						configJson: input.configJson,
					}),
				);
			}
			case "mcp.update": {
				const input = payload as DesktopCommandPayload<"mcp.update">;
				return mcpActionResult(
					await this.requestMcp(input.sessionId, "mcp.update", { name: input.name, configJson: input.configJson }),
				);
			}
			case "mcp.remove": {
				const input = payload as DesktopCommandPayload<"mcp.remove">;
				return mcpActionResult(await this.requestMcp(input.sessionId, "mcp.remove", { name: input.name }));
			}
			case "mcp.reload": {
				const input = payload as DesktopCommandPayload<"mcp.reload">;
				const response = record(await this.requestMcp(input.sessionId, "mcp.reload", {}));
				if (response?.reloaded !== true)
					throw new DesktopAppError("INVALID_WORKER_RESPONSE", "MCP session reload did not complete");
				await this.refreshWorkerCatalog(`session:${input.sessionId}`);
				await this.emitSnapshot();
				return { reloaded: true };
			}
			case "auth.configure": {
				const input = payload as DesktopCommandPayload<"auth.configure">;
				await this.requireIdleProviderWorkers();
				await this.providerCatalog.configure(input.providerId, input.credential);
				this.providerCache = await this.providerCatalog.list();
				const key = await this.activeSessionWorkerKey();
				if (key) {
					await this.workers.request(key, "auth.refresh", { provider: input.providerId });
					await this.refreshWorkerCatalog(key);
				}
				await this.emitSnapshot();
				return { configured: true };
			}
			case "provider.save": {
				const { credential, ...provider } = payload as DesktopCommandPayload<"provider.save">;
				await this.requireIdleProviderWorkers();
				await this.providerCatalog.saveCustom(provider, credential);
				await this.refreshProviderState(provider.id, true);
				return { saved: true };
			}
			case "provider.remove": {
				const input = payload as DesktopCommandPayload<"provider.remove">;
				await this.requireIdleProviderWorkers();
				await this.providerCatalog.removeCustom(input.providerId);
				await this.refreshProviderState(input.providerId, true);
				return { removed: true };
			}
			case "auth.clear": {
				const input = payload as DesktopCommandPayload<"auth.clear">;
				await this.requireIdleProviderWorkers();
				await this.providerCatalog.clear(input.providerId);
				await this.refreshProviderState(input.providerId);
				return { cleared: true };
			}
			case "auth.logout": {
				const input = payload as DesktopCommandPayload<"auth.logout">;
				await this.requireIdleProviderWorkers();
				await this.providerCatalog.clear(input.providerId);
				await this.refreshProviderState(input.providerId);
				return { cleared: true };
			}
			case "auth.login": {
				const input = payload as DesktopCommandPayload<"auth.login">;
				return this.startOAuthLogin(input.providerId);
			}
			case "auth.respond": {
				const input = payload as DesktopCommandPayload<"auth.respond">;
				const prompt = this.pendingAuthPrompts.get(input.promptId);
				if (!prompt || prompt.flowId !== input.flowId)
					throw new DesktopAppError("AUTH_PROMPT_EXPIRED", "This sign-in prompt is no longer active");
				this.pendingAuthPrompts.delete(input.promptId);
				prompt.resolve(input.value);
				return { accepted: true };
			}
			case "auth.cancel": {
				const input = payload as DesktopCommandPayload<"auth.cancel">;
				const flow = this.pendingAuthFlows.get(input.flowId);
				flow?.controller.abort();
				return { cancelled: Boolean(flow) };
			}
			case "auth.open-url": {
				const input = payload as DesktopCommandPayload<"auth.open-url">;
				let parsed: URL;
				try {
					parsed = new URL(input.url);
				} catch {
					throw new DesktopAppError("INVALID_URL", "The sign-in URL is invalid");
				}
				if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
					throw new DesktopAppError("INVALID_URL", "Only web sign-in URLs can be opened");
				if (!this.openExternal)
					throw new DesktopAppError("OPEN_URL_UNAVAILABLE", "Opening external links is unavailable");
				await this.openExternal(parsed.toString());
				return { opened: true };
			}
			case "settings.save": {
				const settings = payload as Settings;
				const operation = this.settingsSaveTail.catch(() => {}).then(() => this.saveSettings(settings));
				this.settingsSaveTail = operation;
				return operation;
			}
			case "role.save": {
				const project = await this.requireActiveProject();
				const role = await this.roles.save(payload as DesktopRole, project.path);
				await this.emitSnapshot();
				return role;
			}
			case "task.create":
				return this.createTask(payload as DesktopCommandPayload<"task.create">);
			case "task.message": {
				const input = payload as DesktopCommandPayload<"task.message">;
				const task = await this.requireTask(input.taskId);
				if (task.status !== "running")
					throw new DesktopAppError("TASK_NOT_RUNNING", "Task must be running to receive a message");
				await this.workers.request(`task:${task.id}`, "message", { text: input.text, deliverAs: "steer" });
				return { accepted: true };
			}
			case "task.pause":
				return this.pauseTask((payload as DesktopCommandPayload<"task.pause">).taskId);
			case "task.resume":
				return this.resumeTask((payload as DesktopCommandPayload<"task.resume">).taskId);
			case "task.cancel":
				return this.cancelTask((payload as DesktopCommandPayload<"task.cancel">).taskId);
			case "task.merge":
				return this.mergeTask((payload as DesktopCommandPayload<"task.merge">).taskId);
			case "catalog.toggle":
				throw new DesktopAppError("UNSUPPORTED_CAPABILITY", "Resource activation is controlled by Pi settings");
			case "catalog.run": {
				const input = payload as DesktopCommandPayload<"catalog.run">;
				const key = await this.activeSessionWorkerKey();
				if (!key) throw new DesktopAppError("NO_ACTIVE_SESSION", "Select a session to use Pi resources");
				return this.workers.request(key, "resources.run", input);
			}
			case "terminal.start": {
				const input = payload as DesktopCommandPayload<"terminal.start">;
				const terminal = this.requireTerminalService();
				const project = await this.registry.getProject(input.projectId);
				if (!project) throw new DesktopAppError("PROJECT_NOT_FOUND", "Unknown project");
				if (this.terminalState?.state === "running") terminal.stop(this.terminalState.id);
				const handle = await terminal.start(project.path, input.command);
				this.terminalState = { id: handle.id, title: handle.command ?? "Shell", state: handle.state, output: "" };
				await this.emitSnapshot();
				return this.terminalState;
			}
			case "terminal.input": {
				const input = payload as DesktopCommandPayload<"terminal.input">;
				this.requireTerminalService().input(input.terminalId, input.text);
				return { accepted: true };
			}
			case "terminal.resize": {
				const input = payload as DesktopCommandPayload<"terminal.resize">;
				this.requireTerminalService().resize(input.terminalId, input.cols, input.rows);
				return { resized: true };
			}
			case "terminal.stop": {
				const input = payload as DesktopCommandPayload<"terminal.stop">;
				const stopped = this.requireTerminalService().stop(input.terminalId);
				if (this.terminalState?.id === input.terminalId) {
					this.terminalState = { ...this.terminalState, state: "exited" };
					await this.emitSnapshot();
				}
				return { stopped };
			}
			case "extension.ui.respond": {
				const input = payload as DesktopCommandPayload<"extension.ui.respond">;
				const pending = this.pendingUiRequests.get(input.requestId);
				if (!pending) throw new DesktopAppError("UI_REQUEST_NOT_FOUND", "This extension dialog has expired");
				this.pendingUiRequests.delete(input.requestId);
				const { key, requestId, generation } = pending;
				if (!this.workers.has(key) || this.workerGenerations.get(key) !== generation)
					throw new DesktopAppError("WORKER_NOT_RUNNING", "The extension session has closed");
				const value = input.value;
				if (value !== null && typeof value !== "string" && typeof value !== "boolean")
					throw new DesktopAppError(
						"INVALID_ARGUMENT",
						"Extension dialog response must be text or a confirmation",
					);
				await this.workers.request(key, "ui.resolve", { requestId, result: value });
				return { accepted: true };
			}
			case "capability.open":
				return { opened: false };
		}
	}

	private async projectView(project: StoredProject): Promise<DesktopProject> {
		try {
			const [branch, status] = await Promise.all([
				execFileAsync("git", ["-C", project.path, "branch", "--show-current"], { windowsHide: true }),
				execFileAsync("git", ["-C", project.path, "status", "--porcelain=v1"], { windowsHide: true }),
			]);
			return { ...project, branch: branch.stdout.trim() || "detached", dirty: status.stdout.length > 0 };
		} catch {
			return { ...project, branch: "non-git", dirty: false };
		}
	}

	private async requireActiveProject(): Promise<StoredProject> {
		const id = await this.registry.getActiveProjectId();
		const project = id ? await this.registry.getProject(id) : undefined;
		if (!project) throw new DesktopAppError("NO_PROJECT", "Open a project first");
		return project;
	}

	private requireTerminalService(): TerminalService {
		if (!this.terminalService)
			throw new DesktopAppError("UNSUPPORTED_CAPABILITY", "Interactive terminal is not available");
		return this.terminalService;
	}

	private async requireSession(id: string): Promise<StoredSession> {
		const session = await this.registry.getSession(id);
		if (!session) throw new DesktopAppError("SESSION_NOT_FOUND", `Unknown session ${id}`);
		return session;
	}

	private async requireTask(id: string): Promise<TeamTaskRecord> {
		const task = await this.team.getTask(id);
		if (!task) throw new DesktopAppError("TASK_NOT_FOUND", `Unknown task ${id}`);
		return task;
	}

	private async createSession(input: DesktopCommandPayload<"session.create">): Promise<DesktopSession> {
		const project = await this.registry.getProject(input.projectId);
		if (!project) throw new DesktopAppError("PROJECT_NOT_FOUND", `Unknown project ${input.projectId}`);
		const selectedModelName = input.model || (await this.readSettings()).defaultModel;
		const requestedModel = selectedModelName ? parseModelName(selectedModelName) : undefined;
		// Pi writes the session file on the first conversation message, so Orbit owns its stable ID meanwhile.
		const sessionId = randomUUID();
		const tempKey = `session:${randomUUID()}`;
		const init = workerInit(
			await this.startWorker(tempKey, {
				cwd: project.path,
				agentDir: this.agentDirectory,
				sessionId,
				...(requestedModel ? { model: requestedModel } : {}),
			}),
		);
		if (!init.sessionFile) {
			await this.workers.stop(tempKey);
			throw new DesktopAppError("NO_SESSION_FILE", "Pi did not create a persistent session file");
		}
		// Creating an empty Pi session does not itself append a model change entry.
		// Record the selected model before the temporary worker is stopped.
		try {
			if (requestedModel) await this.workers.request(tempKey, "model.select", { ...requestedModel, persist: false });
		} finally {
			await this.workers.stop(tempKey);
		}
		const session: StoredSession = {
			id: init.sessionId,
			projectId: project.id,
			file: init.sessionFile,
			title: "New session",
			updatedAt: new Date().toISOString(),
			model: selectedModelName || modelName(init.model),
			status: "idle",
		};
		await this.registry.upsertSession(session);
		await this.registry.selectSession(session.id);
		this.activeMessages = this.restoreMessages(init.messages);
		this.sessionMessageCache.set(session.id, this.activeMessages);
		await this.emitSnapshot();
		return sessionView(session);
	}

	private async selectSession(id: string): Promise<DesktopSession> {
		if ((await this.requireSession(id)).archived)
			throw new DesktopAppError("SESSION_ARCHIVED", "Restore the session before selecting it");
		const session = await this.registry.selectSession(id);
		const key = `session:${id}`;
		if (this.workers.has(key)) {
			await this.refreshSessionHistory(id, true);
			await this.refreshWorkerCatalog(key);
		} else await this.ensureSessionWorker(id);
		await this.emitSnapshot();
		return sessionView(session);
	}

	private async importSession(projectId: string): Promise<{ imported: boolean; session?: DesktopSession }> {
		const project = await this.registry.getProject(projectId);
		if (!project) throw new DesktopAppError("PROJECT_NOT_FOUND", "Unknown project");
		if (!this.chooseSessionFile)
			throw new DesktopAppError("DIALOG_UNAVAILABLE", "The session import picker is unavailable");
		const sessionFile = await this.chooseSessionFile();
		if (!sessionFile) return { imported: false };
		const source = await readFile(sessionFile, "utf8");
		const header = parseSessionEntries(source).find((entry) => entry.type === "session");
		if (!header || header.type !== "session")
			throw new DesktopAppError("INVALID_SESSION", "The selected file has no Pi session header");
		if (await this.registry.getSession(header.id))
			throw new DesktopAppError(
				"SESSION_EXISTS",
				"This session is already registered. Use Clone session to make another copy.",
			);
		const key = `session:${randomUUID()}`;
		// Pi opens files already in its session directory in place. Stage a private
		// copy elsewhere so importing always preserves the file the user selected.
		const stagedFile = join(this.dataDirectory, `import-${randomUUID()}.jsonl`);
		let imported: WorkerInit;
		try {
			await writeFile(stagedFile, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
			await this.startWorker(key, { cwd: project.path, agentDir: this.agentDirectory });
			const response = record(
				await this.workers.request(
					key,
					"session.import",
					{ sessionFile: stagedFile, cwdOverride: project.path },
					600_000,
				),
			);
			if (response?.cancelled === true) return { imported: false };
			imported = workerInit(response);
		} finally {
			try {
				await this.workers.stop(key);
			} finally {
				await rm(stagedFile, { force: true });
			}
		}
		if (!imported.sessionFile)
			throw new DesktopAppError("NO_SESSION_FILE", "Imported session has no persistent file");
		if (await this.registry.getSession(imported.sessionId))
			throw new DesktopAppError(
				"SESSION_EXISTS",
				"This session is already registered. Use Clone session to make another copy.",
			);
		const session: StoredSession = {
			id: imported.sessionId,
			projectId,
			file: imported.sessionFile,
			title: imported.sessionName || "Imported session",
			updatedAt: new Date().toISOString(),
			model: modelName(imported.model),
			status: "idle",
		};
		await this.registry.upsertSession(session);
		await this.selectSession(session.id);
		return { imported: true, session: sessionView(session) };
	}

	private async refreshSessionHistory(id: string, preserveLiveTools = false): Promise<void> {
		const history = workerInit(await this.workers.request(`session:${id}`, "history", {}));
		if (history.sessionId !== id)
			throw new DesktopAppError("SESSION_MISMATCH", "Worker belongs to a different session");
		const restored = this.restoreMessages(history.messages);
		// Durable entries contain tool calls/results already. Only retain synthetic
		// live tool events, which have their own IDs and richer execution details.
		const ids = new Set(restored.map((message) => message.id));
		const liveTools = preserveLiveTools
			? (this.sessionMessageCache.get(id) ?? []).filter(
					(message) => message.id.startsWith("tool:") && !ids.has(message.id),
				)
			: [];
		const messages = [...restored, ...liveTools];
		this.sessionMessageCache.set(id, messages);
		if ((await this.registry.getActiveSessionId()) === id) this.activeMessages = messages;
		const current = await this.requireSession(id);
		if (history.toolPolicy) {
			await this.db.run(
				"INSERT INTO desktop_preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				`session-tool-mode:${id}`,
				history.toolPolicy.mode,
			);
		}
		await this.registry.upsertSession({
			...current,
			model: modelName(history.model),
			updatedAt: new Date().toISOString(),
		});
	}

	private ensureSessionWorker(id: string): Promise<void> {
		const pending = this.sessionWorkerStarts.get(id);
		if (pending) return pending;
		const operation = this.initializeSessionWorker(id);
		this.sessionWorkerStarts.set(id, operation);
		return operation.finally(() => {
			if (this.sessionWorkerStarts.get(id) === operation) this.sessionWorkerStarts.delete(id);
		});
	}

	private async initializeSessionWorker(id: string): Promise<void> {
		const key = `session:${id}`;
		const session = await this.requireSession(id);
		if (session.archived) throw new DesktopAppError("SESSION_ARCHIVED", "Restore the session before using it");
		if (this.workers.has(key)) return;
		const project = await this.registry.getProject(session.projectId);
		if (!project) throw new DesktopAppError("PROJECT_NOT_FOUND", "Session project no longer exists");
		const savedMode = await this.db.get<SettingsRow>(
			"SELECT value FROM desktop_preferences WHERE key = ?",
			`session-tool-mode:${id}`,
		);
		const init = workerInit(
			await this.startWorker(key, {
				cwd: project.path,
				agentDir: this.agentDirectory,
				sessionFile: session.file,
				sessionId: session.id,
				...(session.model ? { model: parseModelName(session.model) } : {}),
				enableTeamTools: (await this.readSettings()).subagentsEnabled,
				...(savedMode?.value === "build" || savedMode?.value === "plan" ? { toolMode: savedMode.value } : {}),
			}),
		);
		if (init.sessionId !== id) {
			await this.workers.stop(key);
			throw new DesktopAppError("SESSION_MISMATCH", "Session file belongs to a different session");
		}
		if (init.sessionFile && init.sessionFile !== session.file) {
			// Recreating an unwritten Pi session preserves its ID but gives it a fresh file path.
			await this.registry.upsertSession({ ...session, file: init.sessionFile });
		}
		this.sessionMessageCache.set(id, this.restoreMessages(init.messages));
		if ((await this.registry.getActiveSessionId()) === id)
			this.activeMessages = this.sessionMessageCache.get(id) ?? [];
		await this.setSessionStatus(id, "idle");
		await this.refreshWorkerCatalog(key);
	}

	private async requestMcp(sessionId: string, type: string, payload: object, timeoutMs = 30_000): Promise<unknown> {
		await this.ensureSessionWorker(sessionId);
		return this.workers.request(`session:${sessionId}`, type, payload, timeoutMs);
	}

	private async forkSession(
		id: string,
		clone = false,
		entryId?: string,
		position: "before" | "at" = "at",
	): Promise<DesktopSession & { selectedText?: string }> {
		await this.ensureSessionWorker(id);
		const current = await this.requireSession(id);
		const history = workerInit(await this.workers.request(`session:${id}`, "history", {}));
		const lastEntryId = entryId ?? history.leafId ?? this.restoreMessages(history.messages).at(-1)?.id;
		if (!clone && !lastEntryId)
			throw new DesktopAppError("NO_FORK_POINT", "The session has no conversation entry to fork");
		const response = record(
			await this.workers.request(
				`session:${id}`,
				clone ? "clone" : "fork",
				clone ? {} : { entryId: lastEntryId, position },
			),
		);
		if (!response || response.cancelled === true)
			throw new DesktopAppError("FORK_CANCELLED", "Session fork was cancelled");
		const sessionId = requiredString(response.sessionId, "sessionId");
		const sessionFile = requiredString(response.sessionFile, "sessionFile");
		const forked: StoredSession = {
			id: sessionId,
			projectId: current.projectId,
			file: sessionFile,
			title: `${current.title} (${clone ? "clone" : "fork"})`,
			updatedAt: new Date().toISOString(),
			model: modelName(response.model),
			status: "idle",
		};
		await this.registry.upsertSession(forked);
		await this.registry.selectSession(sessionId);
		// The worker remains associated with the old key until the next selection.
		await this.workers.stop(`session:${id}`);
		this.sessionMessageCache.delete(id);
		this.activeMessages = [];
		await this.ensureSessionWorker(sessionId);
		await this.emitSnapshot();
		return {
			...sessionView(forked),
			...(typeof response.selectedText === "string" ? { selectedText: response.selectedText } : {}),
		};
	}

	private async setSessionStatus(id: string, status: StoredSession["status"]): Promise<void> {
		await this.registry.setSessionStatus(id, status);
	}

	private async activeSessionWorkerKey(): Promise<string | undefined> {
		const id = await this.registry.getActiveSessionId();
		if (!id || !this.workers.has(`session:${id}`)) return undefined;
		return `session:${id}`;
	}

	private startOAuthLogin(providerId: string): { flowId: string } {
		if (!this.providerCatalog.supportsOAuthLogin(providerId))
			throw new DesktopAppError("OAUTH_UNAVAILABLE", "This provider does not support OAuth sign-in");
		const flowId = randomUUID();
		const flow: PendingAuthFlow = { controller: new AbortController(), promptIds: new Set() };
		this.pendingAuthFlows.set(flowId, flow);
		this.publishAuthEvent({ flowId, type: "started" });
		void this.runOAuthLogin(providerId, flowId, flow);
		return { flowId };
	}

	private async runOAuthLogin(providerId: string, flowId: string, flow: PendingAuthFlow): Promise<void> {
		const interaction: AuthInteraction = {
			signal: flow.controller.signal,
			prompt: (prompt) => {
				const promptId = randomUUID();
				flow.promptIds.add(promptId);
				const safePrompt: DesktopAuthPrompt =
					prompt.type === "select"
						? {
								type: "select",
								message: prompt.message,
								options: prompt.options.map((option) => ({
									id: option.id,
									label: option.label,
									...(option.description === undefined ? {} : { description: option.description }),
								})),
							}
						: {
								type: prompt.type,
								message: prompt.message,
								...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
							};
				this.publishAuthEvent({
					flowId,
					type: "prompt",
					promptId,
					prompt: safePrompt,
				});
				return new Promise<string>((resolve, reject) => {
					const onAbort = () => {
						this.pendingAuthPrompts.delete(promptId);
						reject(new Error("Login cancelled"));
					};
					if (flow.controller.signal.aborted) {
						onAbort();
						return;
					}
					flow.controller.signal.addEventListener("abort", onAbort, { once: true });
					this.pendingAuthPrompts.set(promptId, {
						flowId,
						resolve: (value) => {
							flow.controller.signal.removeEventListener("abort", onAbort);
							resolve(value);
						},
						reject: (error) => {
							flow.controller.signal.removeEventListener("abort", onAbort);
							reject(error);
						},
					});
				});
			},
			notify: (event: AuthEvent) => this.publishAuthFlowUpdate(flowId, event),
		};
		try {
			await this.providerCatalog.login(providerId, interaction);
			await this.refreshProviderState(providerId);
			this.publishAuthEvent({ flowId, type: "complete" });
		} catch {
			this.publishAuthEvent(
				flow.controller.signal.aborted
					? { flowId, type: "cancelled" }
					: { flowId, type: "failed", message: "OAuth sign-in failed. Try again." },
			);
		} finally {
			this.pendingAuthFlows.delete(flowId);
			for (const promptId of flow.promptIds) this.pendingAuthPrompts.delete(promptId);
		}
	}

	private publishAuthFlowUpdate(flowId: string, event: AuthEvent): void {
		switch (event.type) {
			case "info":
				this.publishAuthEvent({
					flowId,
					type: "info",
					message: event.message,
					...(event.links ? { links: [...event.links] } : {}),
				});
				break;
			case "auth_url":
				this.publishAuthEvent({
					flowId,
					type: "auth_url",
					url: event.url,
					...(event.instructions ? { instructions: event.instructions } : {}),
				});
				break;
			case "device_code":
				this.publishAuthEvent({ flowId, ...event });
				break;
			case "progress":
				this.publishAuthEvent({ flowId, type: "progress", message: event.message });
				break;
		}
	}

	private publishAuthEvent(event: DesktopAuthEvent): void {
		this.onAuthEvent?.(event);
	}

	private async requireIdleProviderWorkers(): Promise<void> {
		const sessions = await this.registry.listSessions();
		const tasks = (await this.team.snapshot()).tasks;
		if (sessions.some((session) => session.status === "running") || tasks.some((task) => task.status === "running"))
			throw new DesktopAppError(
				"PROVIDER_BUSY",
				"Wait for running sessions and tasks to finish before changing providers",
			);
	}

	private async refreshProviderState(providerId: string, allWorkers = false): Promise<void> {
		this.providerCache = await this.providerCatalog.list();
		if (allWorkers) {
			const settings = await this.readSettings();
			if (
				settings.defaultModel.startsWith(`${providerId}/`) &&
				!this.providerCache.some((provider) => provider.models.includes(settings.defaultModel))
			)
				await this.storeSettings({ ...settings, defaultModel: "" });
		}
		const key = await this.activeSessionWorkerKey();
		const keys = allWorkers
			? [...this.workerGenerations.keys()].filter((workerKey) => this.workers.has(workerKey))
			: key
				? [key]
				: [];
		for (const workerKey of keys) await this.workers.request(workerKey, "auth.refresh", { provider: providerId });
		if (key) await this.refreshWorkerCatalog(key);
		await this.emitSnapshot();
	}

	private async refreshWorkerCatalog(key: string): Promise<void> {
		const models = await this.workers.request(key, "model.list", { availableOnly: false });
		const providers = new Map<string, DesktopProvider>(
			this.providerCache.map((provider) => [provider.id, { ...provider, models: [...provider.models] }]),
		);
		if (Array.isArray(models)) {
			for (const item of models) {
				const model = record(item);
				if (!model || typeof model.provider !== "string" || typeof model.id !== "string") continue;
				const existing = providers.get(model.provider) ?? {
					id: model.provider,
					name: model.provider,
					configured: false,
					apiKeyLogin: false,
					oauthLogin: false,
					models: [],
				};
				const name = `${model.provider}/${model.id}`;
				if (!existing.models.includes(name)) existing.models.push(name);
				providers.set(model.provider, existing);
			}
		}
		const available = await this.workers.request(key, "model.list", { availableOnly: true });
		if (Array.isArray(available))
			for (const item of available) {
				const model = record(item);
				if (model && typeof model.provider === "string") {
					const provider = providers.get(model.provider);
					if (provider) provider.configured = true;
				}
			}
		const providerViews = [...providers.values()].sort((a, b) => a.name.localeCompare(b.name));
		const resources = record(await this.workers.request(key, "resources.list", {}));
		const entries = (value: unknown): DesktopCatalogEntry[] => {
			if (!Array.isArray(value)) return [];
			return value.flatMap((item): DesktopCatalogEntry[] => {
				const entry = record(item);
				if (
					!entry ||
					typeof entry.id !== "string" ||
					typeof entry.name !== "string" ||
					typeof entry.description !== "string" ||
					typeof entry.source !== "string" ||
					typeof entry.enabled !== "boolean"
				)
					return [];
				return [
					{
						id: entry.id,
						name: entry.name,
						description: entry.description,
						source: entry.source,
						enabled: entry.enabled,
					},
				];
			});
		};
		if ((await this.activeSessionWorkerKey()) !== key) return;
		this.providerCache = providerViews;
		this.catalogCache = {
			skills: entries(resources?.skills),
			templates: entries(resources?.templates),
			commands: entries(resources?.commands),
			extensions: entries(resources?.extensions),
		};
	}

	private restoreMessages(value: unknown): DesktopChatMessage[] {
		if (!Array.isArray(value)) return [];
		return value.flatMap((item, index): DesktopChatMessage[] => {
			const source = record(item);
			if (!source || source.type !== "message" || typeof source.text !== "string") return [];
			const role = source.role === "user" || source.role === "assistant" ? source.role : "system";
			return [
				{
					id: typeof source.entryId === "string" ? source.entryId : `restored:${index}`,
					role,
					createdAt: new Date(typeof source.timestamp === "number" ? source.timestamp : Date.now()).toISOString(),
					parts: chatParts(source.parts, source.text),
				},
			];
		});
	}

	private async createTask(input: DesktopCommandPayload<"task.create">): Promise<DesktopTask> {
		await this.requireSubagentsEnabled();
		const project = await this.registry.getProject(input.projectId);
		if (!project) throw new DesktopAppError("PROJECT_NOT_FOUND", "Unknown project");
		const role = (await this.roles.list(project.path)).find((item) => item.id === input.roleId);
		if (!role) throw new DesktopAppError("ROLE_NOT_FOUND", "Select a saved role");
		if (new Set(input.dependsOn).size !== input.dependsOn.length)
			throw new DesktopAppError("INVALID_DEPENDENCY", "Task dependencies must be unique");
		for (const dependencyId of input.dependsOn) {
			const dependency = await this.team.getTask(dependencyId);
			if (!dependency) throw new DesktopAppError("TASK_NOT_FOUND", `Dependency ${dependencyId} does not exist`);
			if (dependency.projectId !== project.id)
				throw new DesktopAppError("CROSS_PROJECT_DEPENDENCY", "Dependencies must belong to this project");
			if (dependency.status === "failed" || dependency.status === "cancelled")
				throw new DesktopAppError("INVALID_DEPENDENCY", `Dependency ${dependencyId} ended as ${dependency.status}`);
		}
		if (input.parentTaskId) {
			const parent = await this.team.getTask(input.parentTaskId);
			if (!parent || parent.projectId !== project.id)
				throw new DesktopAppError("INVALID_PARENT", "Parent task must belong to this project");
		}
		const taskId = randomUUID();
		const worktreePath = join(this.dataDirectory, "worktrees", project.id, taskId);
		const worktree = await createTaskWorktree({
			projectPath: project.path,
			worktreePath,
			allowedDirtyPaths: await this.roles.projectRolePaths(project.path),
		});
		const task = await this.team.createTask({
			id: taskId,
			projectId: project.id,
			parentTaskId: input.parentTaskId ?? null,
			roleId: input.roleId,
			prompt: input.prompt,
			dependsOn: input.dependsOn,
			baseCommit: worktree.baseCommit,
			worktreePath: worktree.worktreePath,
		});
		await this.publishCommitted();
		await this.scheduleTasks(project.id);
		return taskView(await this.requireTask(task.id), role.name, this.taskDetails.get(task.id));
	}

	private scheduleTasks(projectId: string): Promise<void> {
		const operation = (this.taskScheduleTails.get(projectId) ?? Promise.resolve())
			.catch(() => {})
			.then(() => this.runTaskScheduler(projectId));
		this.taskScheduleTails.set(projectId, operation);
		return operation.finally(() => {
			if (this.taskScheduleTails.get(projectId) === operation) this.taskScheduleTails.delete(projectId);
		});
	}

	private async runTaskScheduler(projectId: string): Promise<void> {
		while (!this.closing) {
			const started = await this.withTaskAdmission(async () => {
				const settings = await this.readSettings();
				if (this.closing || !settings.subagentsEnabled) return [];
				return this.team.startReadyTasks(projectId, settings.maxParallelTasks);
			});
			await this.publishCommitted();
			if (started.length === 0) return;
			let startFailed = false;
			await Promise.all(
				started.map((task) =>
					this.withTaskControl(task.id, async () => {
						if (this.closing) return;
						if ((await this.team.getTask(task.id))?.status !== "running") return;
						try {
							await this.startTask(task);
						} catch (error) {
							if (this.closing) return;
							if (this.taskCancellationRequests.has(task.id)) return;
							await this.workers.stop(`task:${task.id}`).catch((stopError: unknown) => {
								this.emitDiagnostic(
									"TASK_STOP_FAILED",
									stopError instanceof Error ? stopError.message : String(stopError),
								);
							});
							await this.team.transitionTask(task.id, "failed");
							await this.publishCommitted();
							this.emitDiagnostic("TASK_START_FAILED", error instanceof Error ? error.message : String(error));
							startFailed = true;
						}
					}),
				),
			);
			if (!startFailed) return;
		}
	}

	private async startTask(task: TeamTaskRecord): Promise<void> {
		const project = await this.registry.getProject(task.projectId);
		if (!project || !task.worktreePath) throw new DesktopAppError("TASK_INVALID", "Task has no project worktree");
		const role = (await this.roles.list(project.path)).find((item) => item.id === task.roleId);
		if (!role) throw new DesktopAppError("ROLE_NOT_FOUND", "Task role no longer exists");
		if (this.closing) throw new DesktopAppError("SHUTTING_DOWN", "Application is closing");
		const key = `task:${task.id}`;
		if (this.taskCancellationRequests.has(task.id)) throw new DesktopAppError("TASK_CANCELLED", "Task was cancelled");
		const init = workerInit(
			await this.startWorker(key, {
				cwd: task.worktreePath,
				agentDir: this.agentDirectory,
				...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
				...(role.model ? { model: parseModelName(role.model) } : {}),
				...(role.tools.length ? { tools: role.tools } : {}),
				systemPrompt: role.systemPrompt,
			}),
		);
		if (init.sessionFile) await this.team.updateTask(task.id, { sessionFile: init.sessionFile });
		if (this.taskCancellationRequests.has(task.id)) {
			await this.workers.stop(key);
			throw new DesktopAppError("TASK_CANCELLED", "Task was cancelled");
		}
		await this.publishCommitted();
		await this.promptTask(task.id, task.sessionFile ? "Continue this task from the last settled step." : task.prompt);
	}

	private async startWorker(key: string, payload: unknown): Promise<unknown> {
		if (this.workers.has(key)) throw new WorkerRequestError("ALREADY_RUNNING", `Worker ${key} is already running`);
		const generation = randomUUID();
		this.workerGenerations.set(key, generation);
		// Replacing a worker expires its dialogs before fresh requests can reach the UI.
		for (const [id, pending] of [...this.pendingUiRequests]) {
			if (pending.key === key) await this.dismissPendingUiRequest(id);
		}
		if (this.closing) throw new DesktopAppError("SHUTTING_DOWN", "Application is closing");
		if (this.workerGenerations.get(key) !== generation)
			throw new WorkerRequestError("ALREADY_RUNNING", `Worker ${key} was replaced while starting`);
		const confirmToolCalls = (await this.readSettings()).confirmToolCalls;
		if (this.closing) throw new DesktopAppError("SHUTTING_DOWN", "Application is closing");
		if (key.startsWith("task:") && this.taskCancellationRequests.has(key.slice(5)))
			throw new DesktopAppError("TASK_CANCELLED", "Task was cancelled");
		const result = await this.workers.start(key, { ...record(payload), confirmToolCalls });
		const currentConfirmation = (await this.readSettings()).confirmToolCalls;
		if (currentConfirmation !== confirmToolCalls)
			await this.workers.request(key, "tool.policy.set", { confirmToolCalls: currentConfirmation });
		return result;
	}

	private async promptTask(id: string, text: string): Promise<void> {
		if (this.closing) throw new DesktopAppError("SHUTTING_DOWN", "Application is closing");
		const runId = randomUUID();
		this.taskRunIds.set(id, runId);
		await this.workers.request(`task:${id}`, "prompt", { text, runId });
	}

	private withTaskControl<T>(id: string, action: () => Promise<T>): Promise<T> {
		const operation = (this.taskControlTails.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
		this.taskControlTails.set(id, operation);
		return operation.finally(() => {
			if (this.taskControlTails.get(id) === operation) this.taskControlTails.delete(id);
		});
	}

	private withSessionControl<T>(id: string, action: () => Promise<T>): Promise<T> {
		const operation = (this.sessionControlTails.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
		this.sessionControlTails.set(id, operation);
		return operation.finally(() => {
			if (this.sessionControlTails.get(id) === operation) this.sessionControlTails.delete(id);
		});
	}

	private withTaskAdmission<T>(action: () => Promise<T>): Promise<T> {
		const operation = this.taskAdmissionTail.catch(() => {}).then(action);
		this.taskAdmissionTail = operation;
		return operation;
	}

	private pauseTask(id: string): Promise<DesktopTask> {
		return this.withTaskControl(id, async () => {
			const task = await this.team.transitionTask(id, "paused");
			await this.publishCommitted();
			try {
				if (this.workers.has(`task:${id}`)) await this.workers.request(`task:${id}`, "abort", {});
			} finally {
				await this.scheduleTasks(task.projectId);
			}
			return taskView(task, this.rolesById.get(task.roleId) ?? task.roleId, this.taskDetails.get(id));
		});
	}

	private resumeTask(id: string): Promise<DesktopTask> {
		return this.withTaskControl(id, async () => {
			const task = await this.withTaskAdmission(async () => {
				const settings = await this.requireSubagentsEnabled();
				if (this.closing) throw new DesktopAppError("SHUTTING_DOWN", "Application is closing");
				return this.team.transitionTask(id, "running", {}, settings.maxParallelTasks);
			});
			await this.publishCommitted();
			try {
				if (this.workers.has(`task:${id}`))
					await this.promptTask(id, "Continue this task from the last settled step.");
				else await this.startTask(task);
			} catch (error) {
				if (this.taskCancellationRequests.has(id)) throw error;
				await this.workers.stop(`task:${id}`).catch((stopError: unknown) => {
					this.emitDiagnostic(
						"TASK_STOP_FAILED",
						stopError instanceof Error ? stopError.message : String(stopError),
					);
				});
				await this.team.transitionTask(id, "failed");
				await this.publishCommitted();
				await this.scheduleTasks(task.projectId);
				throw error;
			}
			return taskView(task, this.rolesById.get(task.roleId) ?? task.roleId, this.taskDetails.get(id));
		});
	}

	private async cancelTask(id: string): Promise<DesktopTask> {
		const current = await this.requireTask(id);
		if (!["queued", "running", "paused"].includes(current.status))
			throw new DesktopAppError("TASK_NOT_CANCELLABLE", "Only queued, running or paused tasks can be cancelled");
		// Publish cancellation intent before waiting for startup's control queue. Stopping
		// the worker rejects pending init/prompt requests and releases that queue promptly.
		this.taskCancellationRequests.add(id);
		try {
			await this.workers.stop(`task:${id}`).catch((error: unknown) => {
				this.emitDiagnostic("TASK_STOP_FAILED", error instanceof Error ? error.message : String(error));
			});
			return await this.withTaskControl(id, async () => {
				await this.workers.stop(`task:${id}`);
				const task = await this.team.transitionTask(id, "cancelled");
				this.taskRunIds.delete(id);
				if (task.worktreePath && task.baseCommit) {
					try {
						this.taskDetail(id).changes = [
							...(await inspectTaskWorktree({ worktreePath: task.worktreePath, baseCommit: task.baseCommit })),
						];
					} catch (error) {
						this.emitDiagnostic("TASK_DIFF_FAILED", error instanceof Error ? error.message : String(error));
					}
				}
				await this.refreshTaskHistory(task);
				await this.taskDetailStore.save(id, this.taskDetail(id));
				await this.publishCommitted();
				await this.scheduleTasks(task.projectId);
				await this.emitSnapshot();
				return taskView(task, this.rolesById.get(task.roleId) ?? task.roleId, this.taskDetails.get(id));
			});
		} finally {
			this.taskCancellationRequests.delete(id);
		}
	}

	private async mergeTask(id: string): Promise<{ merged: boolean; conflicts: string[] }> {
		const task = await this.requireTask(id);
		if (task.status === "merged") return { merged: true, conflicts: [] };
		if (task.status !== "completed" && task.status !== "review")
			throw new DesktopAppError("TASK_NOT_READY", "Task must finish before merging");
		if (!task.worktreePath || !task.baseCommit)
			throw new DesktopAppError("TASK_INVALID", "Task has no mergeable worktree");
		const project = await this.registry.getProject(task.projectId);
		if (!project) throw new DesktopAppError("PROJECT_NOT_FOUND", "Task project no longer exists");
		this.taskDetail(id).changes = [
			...(await inspectTaskWorktree({ worktreePath: task.worktreePath, baseCommit: task.baseCommit })),
		];
		await this.taskDetailStore.save(id, this.taskDetail(id));
		await this.emitSnapshot();
		const result = await mergeTaskWorktree({
			projectPath: project.path,
			worktreePath: task.worktreePath,
			baseCommit: task.baseCommit,
			taskId: task.id,
		});
		if (result.status === "blocked") return { merged: false, conflicts: result.files };
		await this.team.transitionTask(id, "merged");
		await this.publishCommitted();
		return { merged: true, conflicts: [] };
	}

	private async handleMainRequest(
		key: string,
		event: Extract<WorkerEvent["event"], { type: "main.request" }>,
	): Promise<void> {
		if (typeof event.requestId !== "string" || event.requestId.length === 0 || event.requestId.length > 128)
			throw new DesktopAppError("INVALID_REQUEST", "Worker team request ID is invalid");
		let payload:
			| { requestId: string; result: unknown }
			| { requestId: string; error: { code: string; message: string } };
		try {
			if (this.closing) throw new DesktopAppError("SHUTTING_DOWN", "Application is closing");
			if (!key.startsWith("session:"))
				throw new DesktopAppError("TEAM_TOOLS_UNAVAILABLE", "Only a main project session can delegate tasks");
			const request = { action: event.action, payload: event.payload };
			if (!isWorkerMainRequest(request))
				throw new DesktopAppError("INVALID_REQUEST", "Worker team request payload is invalid");
			const session = await this.requireSession(key.slice(8));
			const result = await this.runMainTeamAction(session, request);
			payload = { requestId: event.requestId, result };
		} catch (error) {
			payload = {
				requestId: event.requestId,
				error: {
					code:
						error instanceof DesktopAppError ||
						error instanceof TeamTaskError ||
						error instanceof WorkerRequestError
							? error.code
							: error instanceof GitWorkspaceDirtyError
								? "WORKSPACE_DIRTY"
								: "OPERATION_FAILED",
					message: error instanceof Error ? error.message : String(error),
				},
			};
		}
		if (this.workers.has(key)) await this.workers.request(key, "main.resolve", payload, 5_000);
	}

	private async runMainTeamAction(session: StoredSession, request: WorkerMainRequest): Promise<unknown> {
		if (request.action === "team.roles" || request.action === "task.create") await this.requireSubagentsEnabled();
		const project = await this.registry.getProject(session.projectId);
		if (!project) throw new DesktopAppError("PROJECT_NOT_FOUND", "Session project no longer exists");
		switch (request.action) {
			case "team.roles":
				return (await this.roles.list(project.path)).map((role) => ({
					id: role.id,
					name: role.name,
					description: role.description,
					model: role.model,
					tools: role.tools,
				}));
			case "task.create": {
				const task = await this.createTask({
					projectId: project.id,
					roleId: request.payload.roleId,
					prompt: request.payload.prompt,
					dependsOn: request.payload.dependsOn ?? [],
				});
				return { taskId: task.id, status: task.status, role: task.roleName, dependsOn: task.dependsOn };
			}
			case "task.message": {
				const task = await this.requireProjectTask(project.id, request.payload.taskId);
				if (task.status !== "running")
					throw new DesktopAppError("TASK_NOT_RUNNING", "Task must be running to receive a message");
				await this.workers.request(`task:${task.id}`, "message", {
					text: request.payload.text,
					deliverAs: "steer",
				});
				return { taskId: task.id, accepted: true };
			}
			case "task.cancel": {
				const task = await this.requireProjectTask(project.id, request.payload.taskId);
				const cancelled = await this.cancelTask(task.id);
				return this.teamActionResult(cancelled);
			}
			case "task.wait": {
				const task = await this.requireProjectTask(project.id, request.payload.taskId);
				if (task.status !== "running" && task.status !== "queued")
					return this.teamActionResult(taskView(task, task.roleId, this.taskDetails.get(task.id)));
				return this.waitForTask(task.id, request.payload.timeoutMs ?? 60_000);
			}
		}
	}

	private async requireProjectTask(projectId: string, taskId: string): Promise<TeamTaskRecord> {
		const task = await this.requireTask(taskId);
		if (task.projectId !== projectId)
			throw new DesktopAppError("CROSS_PROJECT_TASK", "Task belongs to another project");
		return task;
	}

	private teamActionResult(task: DesktopTask, timedOut = false): object {
		return {
			taskId: task.id,
			status: task.status,
			resultSummary: task.resultSummary?.slice(0, 3_000) ?? "",
			filesChanged: task.filesChanged,
			usage: task.usage ?? null,
			timedOut,
		};
	}

	private waitForTask(taskId: string, timeoutMs: number): Promise<object> {
		return (async () => {
			const afterSequence = await this.events.latestSequence();
			return new Promise((resolve, reject) => {
				let settled = false;
				let unsubscribe = () => {};
				let timer: NodeJS.Timeout | undefined;
				const cleanup = () => {
					if (timer) clearTimeout(timer);
					unsubscribe();
					this.pendingTaskWaits.delete(cancel);
				};
				const finish = (timedOut: boolean) => {
					if (settled) return;
					settled = true;
					cleanup();
					void this.requireTask(taskId)
						.then((task) =>
							resolve(
								this.teamActionResult(taskView(task, task.roleId, this.taskDetails.get(task.id)), timedOut),
							),
						)
						.catch(reject);
				};
				const cancel = () => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(new DesktopAppError("SHUTTING_DOWN", "Application is closing"));
				};
				this.pendingTaskWaits.add(cancel);
				timer = setTimeout(() => finish(true), timeoutMs);
				void this.subscribe(afterSequence, (event) => {
					if (
						event.type === "task" &&
						event.task.id === taskId &&
						event.task.status !== "running" &&
						event.task.status !== "queued"
					)
						finish(false);
				})
					.then(async (stop) => {
						unsubscribe = stop;
						if (settled) stop();
						else {
							const task = await this.requireTask(taskId);
							if (task.status !== "running" && task.status !== "queued") finish(false);
						}
					})
					.catch((error: unknown) => {
						if (settled) return;
						settled = true;
						cleanup();
						reject(error);
					});
			});
		})();
	}

	private async handleWorkerEvent(key: string, event: WorkerEvent["event"], generation: string): Promise<void> {
		if (this.closing || this.workerGenerations.get(key) !== generation) return;
		if (event.type === "queue.update" && key.startsWith("session:")) {
			const sessionId = key.slice(8);
			if ((await this.registry.getSession(sessionId))?.archived) return;
			const queue = sessionQueue(event);
			this.sessionQueues.set(sessionId, queue);
			await this.recordEvent("session.queue", { sessionId, queue });
			return;
		}
		if (event.type === "mcp.status") {
			const servers = mcpServerViews(event.servers);
			this.mcpServersByWorker.set(key, servers);
			await this.recordEvent("mcp.status", { workerKey: key, servers });
			return;
		}
		if (event.type === "mcp.auth_url") {
			if (!key.startsWith("session:") || event.url.length > 2048 || event.name.length > 256)
				throw new DesktopAppError("INVALID_WORKER_EVENT", "Invalid MCP authorization request");
			let url: URL;
			try {
				url = new URL(event.url);
			} catch {
				throw new DesktopAppError("INVALID_WORKER_EVENT", "Invalid MCP authorization URL");
			}
			if (url.protocol !== "https:" && url.protocol !== "http:")
				throw new DesktopAppError("INVALID_WORKER_EVENT", "MCP authorization requires a web URL");
			this.onMcpAuthEvent?.({ sessionId: key.slice(8), serverName: event.name, url: url.toString() });
			if (this.openExternal) {
				try {
					await this.openExternal(url.toString());
				} catch {
					this.emitDiagnostic("MCP_BROWSER_FAILED", "Could not open the MCP sign-in page");
				}
			}
			return;
		}
		if (event.type === "diagnostic") {
			this.emitDiagnostic("WORKER_DIAGNOSTIC", event.message);
			return;
		}
		if (event.type === "message") {
			await this.handleMessage(key, event);
			return;
		}
		if (event.type === "tool") {
			if (key.startsWith("session:")) {
				const sessionId = key.slice(8);
				const messages = this.sessionMessageCache.get(sessionId) ?? [];
				const id = `tool:${event.toolCallId}`;
				const previous = messages.find((item) => item.id === id);
				const message: DesktopChatMessage = {
					id,
					role: "system",
					createdAt: previous?.createdAt ?? new Date().toISOString(),
					parts: [
						{
							kind: "tool",
							name: event.toolName,
							status: event.phase === "end" ? (event.isError ? "error" : "complete") : "running",
							input: JSON.stringify(event.args).slice(0, 5000),
							...(event.phase === "end" ? { output: JSON.stringify(event.result ?? "").slice(0, 10_000) } : {}),
						},
					],
				};
				const index = messages.findIndex((item) => item.id === id);
				if (index < 0) messages.push(message);
				else messages[index] = message;
				this.sessionMessageCache.set(sessionId, messages);
				if ((await this.registry.getActiveSessionId()) === sessionId) {
					this.activeMessages = messages;
					await this.recordEvent("message", { message });
				}
			} else if (key.startsWith("task:")) {
				const id = key.slice(5);
				const detail = this.taskDetail(id);
				const index = detail.toolRecords.findIndex((item) => item.id === event.toolCallId);
				const record = {
					id: event.toolCallId,
					name: event.toolName,
					status: event.phase === "end" ? (event.isError ? "error" : "complete") : "running",
					summary: event.phase === "end" ? JSON.stringify(event.result ?? "").slice(0, 1500) : "Running",
					createdAt: new Date().toISOString(),
				};
				if (index < 0) detail.toolRecords.push(record);
				else detail.toolRecords[index] = record;
				await this.taskDetailStore.save(id, detail);
				await this.emitSnapshot();
			}
			return;
		}
		if (event.type === "state") {
			if (key.startsWith("task:") && (event.state === "idle" || event.state === "failed")) {
				const id = key.slice(5);
				await this.withTaskControl(id, async () => {
					if (this.taskCancellationRequests.has(id)) return;
					// Both the event and current task status must belong to this run. Pause,
					// resume and settlement share the same queue so the check stays valid.
					if (!event.runId || event.runId !== this.taskRunIds.get(id)) return;
					const task = await this.team.getTask(id);
					if (task?.status !== "running") return;
					if (event.state === "idle") {
						if (task.worktreePath && task.baseCommit) {
							try {
								this.taskDetail(id).changes = [
									...(await inspectTaskWorktree({
										worktreePath: task.worktreePath,
										baseCommit: task.baseCommit,
									})),
								];
							} catch (error) {
								this.emitDiagnostic("TASK_DIFF_FAILED", error instanceof Error ? error.message : String(error));
							}
						}
						await this.taskDetailStore.save(id, this.taskDetail(id));
						await this.refreshTaskHistory(task);
					}
					const status =
						event.state === "failed" ? "failed" : event.outcome === "completed" ? "completed" : "review";
					await this.team.transitionTask(id, status);
					this.taskRunIds.delete(id);
					await this.publishCommitted();
					await this.workers.stop(key).catch((error: unknown) => {
						this.emitDiagnostic("TASK_STOP_FAILED", error instanceof Error ? error.message : String(error));
					});
					await this.emitSnapshot();
					await this.scheduleTasks(task.projectId);
				});
				return;
			}
			if (key.startsWith("session:")) {
				const id = key.slice(8);
				const currentRun = this.sessionRunIds.get(id);
				if ((event.runId && event.runId !== currentRun) || (currentRun && event.runId !== currentRun)) return;
				if (event.state === "streaming") await this.setSessionStatus(id, "running");
				if (event.state === "idle") await this.setSessionStatus(id, "idle");
				if (event.state === "failed") await this.setSessionStatus(id, "error");
				if (event.state === "idle" || event.state === "failed") this.sessionRunIds.delete(id);
				if (event.state === "streaming" || event.state === "idle" || event.state === "failed")
					await this.emitSnapshot();
			}
			return;
		}
		if (event.type === "ui.request") {
			const id = `${key}:${generation}:${event.requestId}`;
			this.pendingUiRequests.set(id, { key, requestId: event.requestId, generation });
			const request = {
				id,
				extensionId: key,
				title: event.title,
				message: event.message,
				kind:
					event.kind === "confirm"
						? "confirm"
						: event.kind === "select"
							? "select"
							: event.kind === "editor"
								? "editor"
								: "text",
				options: event.options ? [...event.options] : undefined,
				placeholder: event.placeholder,
			};
			await this.recordEvent("extension.request", { request });
			return;
		}
		if (event.type === "ui.update") {
			if (event.update === "notify") {
				if (event.message) this.emitDiagnostic("EXTENSION_NOTICE", event.message);
				return;
			}
			const state = this.extensionUi.get(key) ?? {
				status: {},
				workingVisible: true,
				widgets: {},
				toolsExpanded: false,
			};
			const next: DesktopExtensionUiState = { ...state, status: { ...state.status }, widgets: { ...state.widgets } };
			switch (event.update) {
				case "status":
					if (event.key) {
						if (event.message === undefined) delete next.status[event.key];
						else next.status[event.key] = event.message;
					}
					break;
				case "working":
					next.workingMessage = event.message;
					break;
				case "workingVisible":
					next.workingVisible = event.visible ?? true;
					break;
				case "workingIndicator":
					next.workingIndicator = event.value === "[omitted]" ? undefined : event.value;
					break;
				case "hiddenThinkingLabel":
					next.hiddenThinkingLabel = event.message;
					break;
				case "widget": {
					if (!event.key) break;
					const value = event.value;
					if (value && typeof value === "object" && !Array.isArray(value) && "content" in value)
						next.widgets[event.key] = {
							content: value.content,
							...(value.options === undefined ? {} : { options: value.options }),
						};
					else delete next.widgets[event.key];
					break;
				}
				case "editor":
					next.editorText =
						event.mode === "append" ? (next.editorText ?? "") + (event.message ?? "") : (event.message ?? "");
					break;
				case "toolsExpanded":
					next.toolsExpanded = event.visible ?? false;
					break;
			}
			this.extensionUi.set(key, next);
			await this.recordEvent("extension.update", { workerKey: key, state: next });
			return;
		}
		if (event.type === "ui.dismiss") {
			const requestId = `${key}:${generation}:${event.requestId}`;
			if (!this.pendingUiRequests.delete(requestId)) return;
			await this.recordEvent("extension.dismiss", { requestId, reason: event.reason });
		}
	}

	private async handleMessage(key: string, event: WorkerMessage): Promise<void> {
		const messageKey = `${key}:${event.role}`;
		const provisionalId = this.messageIds.get(messageKey);
		const id = event.entryId ?? provisionalId ?? randomUUID();
		if (event.phase === "start" || !this.messageIds.has(messageKey)) this.messageIds.set(messageKey, id);
		const message: DesktopChatMessage = {
			id,
			role: event.role === "toolResult" ? "system" : event.role,
			createdAt: new Date(event.timestamp ?? Date.now()).toISOString(),
			parts: chatParts(event.parts, event.text),
		};
		if (key.startsWith("session:")) {
			const sessionId = key.slice(8);
			const messages = this.sessionMessageCache.get(sessionId) ?? [];
			const index = messages.findIndex((item) => item.id === id || (provisionalId && item.id === provisionalId));
			if (index < 0) messages.push(message);
			else messages[index] = message;
			this.sessionMessageCache.set(sessionId, messages);
			if ((await this.registry.getActiveSessionId()) === sessionId) {
				this.activeMessages = messages;
				await this.recordEvent("message", { message });
			}
		} else if (key.startsWith("task:")) {
			const taskId = key.slice(5);
			const detail = this.taskDetail(taskId);
			const index = detail.messages.findIndex(
				(item) => item.id === id || (provisionalId && item.id === provisionalId),
			);
			const entry = { id, author: event.role, text: event.text, createdAt: message.createdAt };
			if (index < 0) detail.messages.push(entry);
			else detail.messages[index] = entry;
			if (event.role === "assistant" && event.phase === "end") detail.resultSummary = event.text.slice(0, 3000);
			await this.taskDetailStore.save(taskId, detail);
			await this.emitSnapshot();
		}
		if (event.phase === "end") this.messageIds.delete(messageKey);
	}

	private taskDetail(id: string): TaskDetail {
		let detail = this.taskDetails.get(id);
		if (!detail) {
			detail = { messages: [], toolRecords: [], changes: [] };
			this.taskDetails.set(id, detail);
		}
		return detail;
	}

	private async refreshTaskHistory(task: TeamTaskRecord): Promise<void> {
		try {
			const recovered = recoverTaskDetail(task);
			const existing = this.taskDetail(task.id);
			const detail: TaskDetail = {
				messages: recovered.messages.length ? recovered.messages : existing.messages,
				toolRecords: recovered.toolRecords.length ? recovered.toolRecords : existing.toolRecords,
				changes: existing.changes,
				resultSummary: recovered.resultSummary ?? existing.resultSummary,
				usage: recovered.usage,
			};
			this.taskDetails.set(task.id, detail);
			await this.taskDetailStore.save(task.id, detail);
			if (recovered.lastSettledEntryId && recovered.lastSettledEntryId !== task.lastSettledEntryId)
				await this.team.updateTask(task.id, { lastSettledEntryId: recovered.lastSettledEntryId });
		} catch (error) {
			this.emitDiagnostic("TASK_HISTORY_FAILED", error instanceof Error ? error.message : String(error));
		}
	}

	private handleWorkerExit(key: string, code: number, generation: string): Promise<void> {
		return key.startsWith("task:")
			? this.withTaskControl(key.slice(5), () => this.cleanupWorkerExit(key, code, generation))
			: this.cleanupWorkerExit(key, code, generation);
	}

	private async cleanupWorkerExit(key: string, code: number, generation: string): Promise<void> {
		if (this.closing || this.workerGenerations.get(key) !== generation) return;
		await this.workerUiEventTail;
		if (this.workerGenerations.get(key) !== generation) return;
		for (const [requestId, pending] of [...this.pendingUiRequests]) {
			if (pending.key !== key || pending.generation !== generation) continue;
			await this.dismissPendingUiRequest(requestId);
		}
		if (this.workerGenerations.get(key) !== generation) return;
		this.mcpServersByWorker.delete(key);
		await this.recordEvent("mcp.status", { workerKey: key, servers: [] });
		if (key.startsWith("session:")) {
			this.sessionRunIds.delete(key.slice(8));
			this.sessionQueues.delete(key.slice(8));
			await this.setSessionStatus(key.slice(8), "error");
			await this.emitSnapshot();
		} else if (key.startsWith("task:")) {
			const task = await this.team.getTask(key.slice(5));
			if (task?.status === "running") {
				try {
					if (task.worktreePath && task.baseCommit) {
						this.taskDetail(task.id).changes = [
							...(await inspectTaskWorktree({
								worktreePath: task.worktreePath,
								baseCommit: task.baseCommit,
							})),
						];
					}
					await this.taskDetailStore.save(task.id, this.taskDetail(task.id));
				} catch (error) {
					this.emitDiagnostic("TASK_DIFF_FAILED", error instanceof Error ? error.message : String(error));
				}
				await this.team.transitionTask(task.id, "review");
				await this.publishCommitted();
				try {
					await this.scheduleTasks(task.projectId);
				} catch (error) {
					this.emitDiagnostic("TASK_SCHEDULER_FAILED", error instanceof Error ? error.message : String(error));
				}
				try {
					await this.emitSnapshot();
				} catch (error) {
					this.emitDiagnostic("SNAPSHOT_FAILED", error instanceof Error ? error.message : String(error));
				}
			}
		}
		this.emitDiagnostic("WORKER_EXITED", `${key} exited with code ${code}`);
	}

	private async dismissPendingUiRequest(requestId: string): Promise<void> {
		if (!this.pendingUiRequests.delete(requestId)) return;
		await this.recordEvent("extension.dismiss", { requestId, reason: "closed" });
	}

	private async readSettings(): Promise<Settings> {
		const stored = await this.db.get<SettingsRow>("SELECT value FROM desktop_preferences WHERE key = 'settings'");
		if (!stored) return { ...DEFAULT_SETTINGS };
		try {
			const saved = record(JSON.parse(stored.value));
			if (!saved) return { ...DEFAULT_SETTINGS };
			return {
				language: saved.language === "zh-CN" ? "zh-CN" : "en",
				theme: saved.theme === "dark" || saved.theme === "light" ? saved.theme : "system",
				defaultModel: typeof saved.defaultModel === "string" ? saved.defaultModel : "",
				confirmToolCalls: typeof saved.confirmToolCalls === "boolean" ? saved.confirmToolCalls : true,
				sendShortcut: saved.sendShortcut === "ctrlEnter" ? "ctrlEnter" : "enter",
				subagentsEnabled: saved.subagentsEnabled === true,
				maxParallelTasks:
					typeof saved.maxParallelTasks === "number" &&
					Number.isInteger(saved.maxParallelTasks) &&
					saved.maxParallelTasks >= 1 &&
					saved.maxParallelTasks <= 4
						? saved.maxParallelTasks
						: 4,
			};
		} catch {
			return { ...DEFAULT_SETTINGS };
		}
	}

	private async requireSubagentsEnabled(): Promise<Settings> {
		const settings = await this.readSettings();
		if (!settings.subagentsEnabled)
			throw new DesktopAppError(
				"SUBAGENTS_DISABLED",
				"Enable subagents in Settings before creating or resuming tasks",
			);
		return settings;
	}

	private async saveSettings(settings: Settings): Promise<Settings> {
		const previous = await this.readSettings();
		const changed = previous.subagentsEnabled !== settings.subagentsEnabled;
		if (changed) {
			if ((await this.registry.listSessions()).some((session) => session.status === "running"))
				throw new DesktopAppError(
					"SESSION_BUSY",
					"Wait for running sessions to finish before changing subagent settings",
				);
			// Recreate idle main sessions so both the model's tool list and the
			// runtime tool registry reflect the setting immediately.
			for (const key of this.workerGenerations.keys())
				if (key.startsWith("session:") && this.workers.has(key)) await this.workers.stop(key);
		}
		await this.withTaskAdmission(() => this.storeSettings(settings));
		if (previous.confirmToolCalls !== settings.confirmToolCalls) {
			const policyUpdates = await Promise.allSettled(
				[...this.workerGenerations.keys()]
					.filter((key) => this.workers.has(key))
					.map((key) =>
						this.workers.request(key, "tool.policy.set", { confirmToolCalls: settings.confirmToolCalls }),
					),
			);
			const failure = policyUpdates.find((update) => update.status === "rejected");
			if (failure?.status === "rejected") {
				await this.withTaskAdmission(() => this.storeSettings(previous));
				await Promise.allSettled(
					[...this.workerGenerations.keys()]
						.filter((key) => this.workers.has(key))
						.map((key) =>
							this.workers.request(key, "tool.policy.set", { confirmToolCalls: previous.confirmToolCalls }),
						),
				);
				throw failure.reason;
			}
		}
		if (changed) {
			const activeId = await this.registry.getActiveSessionId();
			if (activeId) {
				try {
					await this.ensureSessionWorker(activeId);
				} catch (error) {
					this.emitDiagnostic("SESSION_RESTART_FAILED", error instanceof Error ? error.message : String(error));
				}
			}
		}
		if (
			settings.subagentsEnabled &&
			(!previous.subagentsEnabled || settings.maxParallelTasks > previous.maxParallelTasks)
		) {
			for (const project of await this.registry.listProjects()) await this.scheduleTasks(project.id);
		}
		await this.emitSnapshot();
		return settings;
	}

	private async storeSettings(settings: Settings): Promise<void> {
		await this.db.run(
			"INSERT INTO desktop_preferences (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			JSON.stringify(settings),
		);
	}

	private async emitSnapshot(): Promise<void> {
		const snapshot = await this.snapshot();
		await this.recordEvent("state", { snapshot });
	}

	private emitDiagnostic(code: string, message: string): void {
		void this.recordEvent("diagnostic", { code, message }).catch((error: unknown) => {
			console.error("Pi Orbit could not persist a diagnostic:", error);
		});
	}

	private async recordEvent(kind: Exclude<StoredAppEvent["kind"], "team">, payload: unknown): Promise<void> {
		await this.events.append(kind, payload);
		await this.publishCommitted();
	}

	private publishCommitted(): Promise<void> {
		const publication = this.eventPublishTail.then(async () => {
			for (const stored of await this.events.eventsSince(this.lastPublished)) {
				this.lastPublished = stored.seq;
				const event = this.mapEvent(stored);
				for (const listener of this.listeners) listener(event);
			}
		});
		this.eventPublishTail = publication.catch(() => {});
		return publication;
	}

	private mapEvent(stored: StoredAppEvent): DesktopEvent {
		const payload = record(stored.payload);
		if (stored.kind === "team") {
			const task = record(payload?.task) as TeamTaskRecord | undefined;
			if (task)
				return {
					seq: stored.seq,
					type: "task",
					task: taskView(task, this.rolesById.get(task.roleId) ?? task.roleId, this.taskDetails.get(task.id)),
				};
		}
		if (stored.kind === "message" && record(payload?.message)) {
			return { seq: stored.seq, type: "message", message: payload?.message as DesktopChatMessage };
		}
		if (stored.kind === "session.queue" && typeof payload?.sessionId === "string") {
			return {
				seq: stored.seq,
				type: "session.queue",
				sessionId: payload.sessionId,
				queue: sessionQueue(payload.queue),
			};
		}
		if (stored.kind === "state" && record(payload?.snapshot)) {
			return {
				seq: stored.seq,
				type: "snapshot",
				snapshot: { ...(payload?.snapshot as DesktopSnapshot), lastEventSeq: stored.seq },
			};
		}
		if (stored.kind === "extension.request" && record(payload?.request)) {
			return {
				seq: stored.seq,
				type: "extension.request",
				request: payload?.request as Extract<DesktopEvent, { type: "extension.request" }>["request"],
			};
		}
		if (stored.kind === "extension.dismiss" && typeof payload?.requestId === "string") {
			return {
				seq: stored.seq,
				type: "extension.dismiss",
				requestId: payload.requestId,
				reason: payload.reason === "timeout" || payload.reason === "closed" ? payload.reason : "aborted",
			};
		}
		if (stored.kind === "extension.update" && typeof payload?.workerKey === "string" && record(payload.state)) {
			return {
				seq: stored.seq,
				type: "extension.update",
				workerKey: payload.workerKey,
				state: payload.state as DesktopExtensionUiState,
			};
		}
		if (stored.kind === "mcp.status" && typeof payload?.workerKey === "string") {
			return {
				seq: stored.seq,
				type: "mcp.status",
				workerKey: payload.workerKey,
				servers: mcpServerViews(payload.servers),
			};
		}
		if (
			stored.kind === "terminal.output" &&
			typeof payload?.terminalId === "string" &&
			typeof payload.text === "string"
		) {
			return { seq: stored.seq, type: "terminal.output", terminalId: payload.terminalId, text: payload.text };
		}
		return {
			seq: stored.seq,
			type: "diagnostic",
			code: typeof payload?.code === "string" ? payload.code : "UNKNOWN_EVENT",
			message: typeof payload?.message === "string" ? payload.message : "An unrecognized desktop event was stored",
		};
	}
}
