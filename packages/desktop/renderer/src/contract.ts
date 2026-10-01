import type { JsonValue } from "@earendil-works/chord";
import type { DesktopAttachment } from "../../src/shared/attachments.ts";
import type { DesktopAuthEvent, DesktopMcpAuthEvent, DesktopMcpServer } from "../../src/shared/desktop-types.ts";

export type { DesktopAttachment };

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

export type Project = { id: string; name: string; path: string; branch: string; dirty: boolean };
export type Session = { id: string; projectId: string; title: string; updatedAt: string; model: string; status: "idle" | "running" | "error" };
export type ChatPart =
	| { kind: "text"; text: string }
	| { kind: "image"; mimeType: string }
	| { kind: "tool"; name: string; status: "running" | "complete" | "error"; input?: string; output?: string }
	| { kind: "thinking"; text: string };
export type ChatMessage = { id: string; role: "user" | "assistant" | "system"; createdAt: string; parts: ChatPart[] };
export type TaskStatus = "queued" | "running" | "paused" | "review" | "completed" | "failed" | "cancelled" | "merged";
export type Task = {
	id: string;
	projectId: string;
	parentTaskId?: string;
	roleId: string;
	roleName: string;
	prompt: string;
	dependsOn: string[];
	status: TaskStatus;
	baseCommit?: string;
	worktreePath?: string;
	sessionFile?: string;
	lastSettledEntryId?: string;
	updatedAt: string;
	resultSummary?: string;
	filesChanged: number;
	usage?: { input: number; output: number };
	messages: Array<{ id: string; author: string; text: string; createdAt: string }>;
	toolRecords: Array<{ id: string; name: string; status: string; summary: string; createdAt: string }>;
	changes: Array<{ path: string; status: "added" | "modified" | "deleted"; diff: string }>;
};
export type Role = { id: string; name: string; description: string; systemPrompt: string; model: string; tools: string[]; scope: "user" | "project" };
export type CatalogEntry = { id: string; name: string; description: string; source: string; enabled: boolean };
export type Provider = {
	id: string;
	name: string;
	configured: boolean;
	credentialType?: "api_key" | "oauth";
	apiKeyLogin: boolean;
	oauthLogin: boolean;
	models: string[];
};
export type McpServer = DesktopMcpServer;
export type ExtensionUiState = {
	status: Record<string, string>;
	workingMessage?: string;
	workingVisible: boolean;
	workingIndicator?: JsonValue;
	hiddenThinkingLabel?: string;
	widgets: Record<string, { content: JsonValue; options?: JsonValue }>;
	editorText?: string;
	toolsExpanded: boolean;
};
export type AppSnapshot = {
	lastEventSeq: number;
	projects: Project[];
	activeProjectId?: string;
	sessions: Session[];
	activeSessionId?: string;
	messages: ChatMessage[];
	tasks: Task[];
	roles: Role[];
	catalog: { skills: CatalogEntry[]; templates: CatalogEntry[]; commands: CatalogEntry[]; extensions: CatalogEntry[] };
	providers: Provider[];
	mcpServers: McpServer[];
	extensionUi: Record<string, ExtensionUiState>;
	settings: {
		language: "en" | "zh-CN";
		theme: "dark" | "light" | "system";
		defaultModel: string;
		confirmToolCalls: boolean;
		sendShortcut: "enter" | "ctrlEnter";
	};
	features: { terminal: boolean; desktopExtensions: boolean };
	terminal?: { id: string; title: string; state: "starting" | "running" | "exited"; output: string };
	capabilities: Record<string, { available: boolean; diagnostic?: string }>;
};
export type DesktopEvent =
	| { seq: number; type: "snapshot"; snapshot: AppSnapshot }
	| { seq: number; type: "message"; message: ChatMessage }
	| { seq: number; type: "task"; task: Task }
	| { seq: number; type: "diagnostic"; code: string; message: string }
	| { seq: number; type: "extension.request"; request: { id: string; extensionId: string; title: string; message?: string; kind: "text" | "confirm" | "select" | "editor"; options?: string[]; placeholder?: string } }
	| { seq: number; type: "extension.update"; workerKey: string; state: ExtensionUiState }
	| { seq: number; type: "extension.dismiss"; requestId: string; reason: "aborted" | "timeout" | "closed" }
	| { seq: number; type: "terminal.output"; terminalId: string; text: string }
	| { seq: number; type: "mcp.status"; workerKey: string; servers: McpServer[] };

export type AuthFlowEvent = DesktopAuthEvent;
export type McpAuthEvent = DesktopMcpAuthEvent;

export type CommandMap = {
	"app.snapshot": { payload: undefined; data: AppSnapshot };
	"app.quit": { payload: undefined; data: { closing: true } };
	"project.open": { payload: { path: string }; data: Project };
	"project.create": { payload: { path: string; name: string }; data: Project };
	"session.select": { payload: { sessionId: string }; data: Session };
	"session.create": { payload: { projectId: string; model?: string }; data: Session };
	"session.prompt": { payload: { sessionId: string; text: string; attachments?: DesktopAttachment[] }; data: { accepted: true } };
	"session.message": { payload: { sessionId: string; text: string; deliverAs: "steer" | "followUp"; attachments?: DesktopAttachment[] }; data: { accepted: true; delivery: "steer" | "followUp" } };
	"session.abort": { payload: { sessionId: string }; data: { aborted: boolean } };
	"session.fork": { payload: { sessionId: string }; data: Session };
	"session.compact": { payload: { sessionId: string }; data: { compacted: boolean } };
	"model.select": { payload: { sessionId: string; model: string }; data: { model: string } };
	"mcp.list": { payload: { sessionId: string }; data: McpServer[] };
	"mcp.sign-in": { payload: { sessionId: string; name: string }; data: { changed?: boolean; reloadRequired?: boolean } };
	"mcp.sign-out": { payload: { sessionId: string; name: string }; data: { changed?: boolean; reloadRequired?: boolean } };
	"mcp.reconnect": { payload: { sessionId: string; name: string }; data: { changed?: boolean; reloadRequired?: boolean } };
	"mcp.set-enabled": { payload: { sessionId: string; name: string; enabled: boolean }; data: { changed?: boolean; reloadRequired?: boolean } };
	"mcp.set-exposure": { payload: { sessionId: string; name: string; exposure: McpServer["exposure"] }; data: { changed?: boolean; reloadRequired?: boolean } };
	"mcp.add": { payload: { sessionId: string; name: string; scope: "global" | "project"; configJson: string }; data: { changed?: boolean; reloadRequired?: boolean } };
	"mcp.update": { payload: { sessionId: string; name: string; configJson: string }; data: { changed?: boolean; reloadRequired?: boolean } };
	"mcp.remove": { payload: { sessionId: string; name: string }; data: { changed?: boolean; reloadRequired?: boolean } };
	"mcp.reload": { payload: { sessionId: string }; data: { reloaded: true } };
	"auth.configure": { payload: { providerId: string; credential: string }; data: { configured: true } };
	"auth.clear": { payload: { providerId: string }; data: { cleared: true } };
	"auth.login": { payload: { providerId: string }; data: { flowId: string } };
	"auth.logout": { payload: { providerId: string }; data: { cleared: true } };
	"auth.respond": { payload: { flowId: string; promptId: string; value: string }; data: { accepted: true } };
	"auth.cancel": { payload: { flowId: string }; data: { cancelled: boolean } };
	"auth.open-url": { payload: { url: string }; data: { opened: boolean } };
	"settings.save": { payload: AppSnapshot["settings"]; data: AppSnapshot["settings"] };
	"role.save": { payload: Role; data: Role };
	"catalog.toggle": { payload: { kind: "skill" | "template" | "command" | "extension"; id: string; enabled: boolean }; data: { enabled: boolean } };
	"catalog.run": { payload: { kind: "skill" | "template" | "command" | "extension"; id: string }; data: { insertedText?: string; started?: boolean } };
	"task.create": { payload: { projectId: string; parentTaskId?: string; roleId: string; prompt: string; dependsOn: string[] }; data: Task };
	"task.message": { payload: { taskId: string; text: string }; data: { accepted: true } };
	"task.pause": { payload: { taskId: string }; data: Task };
	"task.resume": { payload: { taskId: string }; data: Task };
	"task.cancel": { payload: { taskId: string }; data: Task };
	"task.merge": { payload: { taskId: string }; data: { merged: boolean; conflicts: string[] } };
	"terminal.start": { payload: { projectId: string; command?: string }; data: NonNullable<AppSnapshot["terminal"]> };
	"terminal.input": { payload: { terminalId: string; text: string }; data: { accepted: true } };
	"terminal.resize": { payload: { terminalId: string; cols: number; rows: number }; data: { resized: true } };
	"terminal.stop": { payload: { terminalId: string }; data: { stopped: true } };
	"extension.ui.respond": { payload: { requestId: string; value: unknown }; data: { accepted: true } };
	"capability.open": { payload: { capability: string }; data: { opened: boolean } };
};

export type Command = keyof CommandMap;
export type DesktopApi = {
	invoke<K extends Command>(command: K, payload: CommandMap[K]["payload"]): Promise<Result<CommandMap[K]["data"]>>;
	subscribe(afterSeq: number, listener: (event: DesktopEvent) => void): () => void;
	subscribeAuth(listener: (event: AuthFlowEvent) => void): () => void;
	subscribeMcpAuth(listener: (event: McpAuthEvent) => void): () => void;
};

declare global {
	interface Window {
		piOrbit?: DesktopApi;
	}
}
