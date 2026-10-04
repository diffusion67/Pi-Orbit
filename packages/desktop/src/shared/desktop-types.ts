import type { JsonValue } from "@earendil-works/chord";
import type { DesktopAttachment } from "./attachments.ts";

export type DesktopResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

export type DesktopProject = { id: string; name: string; path: string; branch: string; dirty: boolean };
export type DesktopSession = {
	id: string;
	projectId: string;
	title: string;
	updatedAt: string;
	model: string;
	status: "idle" | "running" | "error";
	archived: boolean;
};
export type DesktopSessionQueue = { steering: string[]; followUp: string[]; pendingCount: number; truncated?: boolean };
export type DesktopSessionPolicy = { confirmToolCalls: boolean; mode: "build" | "plan" };
export type DesktopThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type DesktopThinkingState = { level: DesktopThinkingLevel; availableLevels: DesktopThinkingLevel[] };
export type DesktopSessionTree = {
	entries: Array<{
		id: string;
		parentId: string | null;
		type: string;
		label: string;
		role?: string;
		timestamp?: number;
	}>;
	leafId: string | null;
};
export type DesktopSessionStats = {
	sessionId: string;
	sessionFile?: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
};
export type DesktopChatPart =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "image"; mimeType: string }
	| { kind: "tool"; name: string; status: "running" | "complete" | "error"; input?: string; output?: string };
export type DesktopChatMessage = {
	id: string;
	role: "user" | "assistant" | "system";
	createdAt: string;
	parts: DesktopChatPart[];
};
export type { DesktopAttachment };
export type DesktopTask = {
	id: string;
	projectId: string;
	parentTaskId?: string;
	roleId: string;
	roleName: string;
	prompt: string;
	dependsOn: string[];
	status: "queued" | "running" | "paused" | "review" | "completed" | "failed" | "cancelled" | "merged";
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
export type DesktopRole = {
	id: string;
	name: string;
	description: string;
	systemPrompt: string;
	model: string;
	tools: string[];
	scope: "user" | "project";
};
export type DesktopCatalogEntry = { id: string; name: string; description: string; source: string; enabled: boolean };
export type DesktopProviderApi =
	| "anthropic-messages"
	| "openai-completions"
	| "openai-responses"
	| "openai-codex-responses";
export type DesktopCustomModel = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
};
/** Only public connection metadata crosses back to the renderer. */
export type DesktopCustomProvider = {
	id: string;
	name: string;
	api: DesktopProviderApi;
	baseUrl: string;
	models: DesktopCustomModel[];
};
export type DesktopProvider = {
	id: string;
	name: string;
	configured: boolean;
	credentialType?: "api_key" | "oauth";
	apiKeyLogin: boolean;
	oauthLogin: boolean;
	models: string[];
	custom?: DesktopCustomProvider;
};
export type DesktopMcpServer = {
	name: string;
	scope?: "global" | "project" | "extension";
	enabled: boolean;
	exposure: "codemode" | "deferred" | "direct" | "hidden";
	state: "disabled" | "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";
	toolCount: number;
	resourceCount: number;
	usesOAuth: boolean;
};
export type DesktopExtensionUiState = {
	status: Record<string, string>;
	workingMessage?: string;
	workingVisible: boolean;
	workingIndicator?: JsonValue;
	hiddenThinkingLabel?: string;
	widgets: Record<string, { content: JsonValue; options?: JsonValue }>;
	editorText?: string;
	toolsExpanded: boolean;
};
export type DesktopSnapshot = {
	lastEventSeq: number;
	projects: DesktopProject[];
	activeProjectId?: string;
	sessions: DesktopSession[];
	activeSessionId?: string;
	sessionQueues?: Record<string, DesktopSessionQueue>;
	messages: DesktopChatMessage[];
	tasks: DesktopTask[];
	roles: DesktopRole[];
	catalog: {
		skills: DesktopCatalogEntry[];
		templates: DesktopCatalogEntry[];
		commands: DesktopCatalogEntry[];
		extensions: DesktopCatalogEntry[];
	};
	providers: DesktopProvider[];
	mcpServers: DesktopMcpServer[];
	extensionUi: Record<string, DesktopExtensionUiState>;
	settings: {
		language: "en" | "zh-CN";
		theme: "dark" | "light" | "system";
		defaultModel: string;
		confirmToolCalls: boolean;
		sendShortcut: "enter" | "ctrlEnter";
		subagentsEnabled: boolean;
		maxParallelTasks: number;
	};
	features: { terminal: boolean; desktopExtensions: boolean };
	terminal?: {
		id: string;
		title: string;
		state: "starting" | "running" | "exited";
		output: string;
		outputOffset?: number;
	};
	capabilities: Record<string, { available: boolean; diagnostic?: string }>;
};
export type DesktopEvent =
	| { seq: number; type: "snapshot"; snapshot: DesktopSnapshot }
	| { seq: number; type: "message"; message: DesktopChatMessage }
	| { seq: number; type: "task"; task: DesktopTask }
	| { seq: number; type: "session.queue"; sessionId: string; queue: DesktopSessionQueue }
	| { seq: number; type: "diagnostic"; code: string; message: string }
	| {
			seq: number;
			type: "extension.request";
			request: {
				id: string;
				extensionId: string;
				title: string;
				message?: string;
				kind: "text" | "confirm" | "select" | "editor";
				options?: string[];
				placeholder?: string;
			};
	  }
	| { seq: number; type: "extension.update"; workerKey: string; state: DesktopExtensionUiState }
	| { seq: number; type: "extension.dismiss"; requestId: string; reason: "aborted" | "timeout" | "closed" }
	| { seq: number; type: "terminal.output"; terminalId: string; text: string }
	| { seq: number; type: "mcp.status"; workerKey: string; servers: DesktopMcpServer[] };

/** Transient authorization URL; never written to the desktop event log. */
export type DesktopMcpAuthEvent = { sessionId: string; serverName: string; url: string };

/** Ephemeral OAuth interaction data. Never included in the durable app event log. */
export type DesktopAuthPrompt =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| {
			type: "select";
			message: string;
			options: readonly { id: string; label: string; description?: string }[];
	  };

export type DesktopAuthEvent =
	| { flowId: string; type: "started" }
	| { flowId: string; type: "progress"; message: string }
	| { flowId: string; type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
	| { flowId: string; type: "auth_url"; url: string; instructions?: string }
	| {
			flowId: string;
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| {
			flowId: string;
			type: "prompt";
			promptId: string;
			prompt: DesktopAuthPrompt;
	  }
	| { flowId: string; type: "complete" }
	| { flowId: string; type: "failed"; message: string }
	| { flowId: string; type: "cancelled" };
