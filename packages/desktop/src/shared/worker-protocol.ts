import type { JsonValue } from "@earendil-works/chord";
import type { McpManagerServer, McpServerConfig } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";
import { DesktopAttachmentSchema, MAX_ATTACHMENT_COUNT } from "./attachments.ts";

const strict = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const text = (maximum = 100_000) => Type.String({ minLength: 1, maxLength: maximum });
const modelRef = strict({ provider: text(256), modelId: text(512) });
const mainRequestId = text(128);
const mcpName = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
const mcpExposure = Type.Union([
	Type.Literal("codemode"),
	Type.Literal("deferred"),
	Type.Literal("direct"),
	Type.Literal("hidden"),
]);
const mcpConfigCommon = {
	exposure: Type.Optional(mcpExposure),
	description: Type.Optional(Type.String({ maxLength: 20_000 })),
	toolExposure: Type.Optional(Type.Record(Type.String({ maxLength: 512 }), mcpExposure)),
	enabled: Type.Optional(Type.Boolean()),
	timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
};
const mcpOAuthConfig = strict({
	clientId: Type.Optional(Type.String({ maxLength: 10_000 })),
	clientSecret: Type.Optional(Type.String({ maxLength: 10_000 })),
	callbackPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
	callbackUrl: Type.Optional(Type.String({ maxLength: 10_000 })),
	scope: Type.Optional(Type.String({ maxLength: 10_000 })),
	clientName: Type.Optional(Type.String({ maxLength: 10_000 })),
	clientRegistration: Type.Optional(Type.Union([Type.Literal("dcr"), Type.Literal("cimd")])),
	authServerMetadataUrl: Type.Optional(Type.String({ maxLength: 10_000 })),
});
const mcpServerConfig = Type.Union([
	strict({
		...mcpConfigCommon,
		type: Type.Optional(Type.Literal("stdio")),
		command: Type.String({ minLength: 1, maxLength: 32_768 }),
		args: Type.Optional(Type.Array(Type.String({ maxLength: 32_768 }), { maxItems: 256 })),
		env: Type.Optional(Type.Record(Type.String({ maxLength: 4_096 }), Type.String({ maxLength: 32_768 }))),
		cwd: Type.Optional(Type.String({ maxLength: 32_768 })),
	}),
	strict({
		...mcpConfigCommon,
		type: Type.Optional(Type.Literal("http")),
		url: Type.String({ minLength: 1, maxLength: 32_768 }),
		headers: Type.Optional(Type.Record(Type.String({ maxLength: 4_096 }), Type.String({ maxLength: 32_768 }))),
		oauth: Type.Optional(mcpOAuthConfig),
		auth: Type.Optional(strict({ provider: Type.String({ minLength: 1, maxLength: 256 }) })),
	}),
]);

const teamAction = Type.Union([
	strict({ action: Type.Literal("team.roles"), payload: strict({}) }),
	strict({
		action: Type.Literal("task.create"),
		payload: strict({
			roleId: text(256),
			prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
			dependsOn: Type.Optional(Type.Array(text(128), { maxItems: 32 })),
		}),
	}),
	strict({
		action: Type.Literal("task.message"),
		payload: strict({ taskId: text(128), text: Type.String({ minLength: 1, maxLength: 100_000 }) }),
	}),
	strict({ action: Type.Literal("task.cancel"), payload: strict({ taskId: text(128) }) }),
	strict({
		action: Type.Literal("task.wait"),
		payload: strict({ taskId: text(128), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })) }),
	}),
]);
export const WorkerMainRequestSchema = teamAction;
export type WorkerMainRequest = Static<typeof teamAction>;

const initPayload = strict({
	cwd: text(32_768),
	sessionFile: Type.Optional(text(32_768)),
	sessionId: Type.Optional(text(128)),
	agentDir: Type.Optional(text(32_768)),
	model: Type.Optional(modelRef),
	tools: Type.Optional(Type.Array(text(128), { maxItems: 128 })),
	systemPrompt: Type.Optional(Type.String({ maxLength: 100_000 })),
	enableTeamTools: Type.Optional(Type.Boolean()),
	confirmToolCalls: Type.Optional(Type.Boolean()),
	toolMode: Type.Optional(Type.Union([Type.Literal("build"), Type.Literal("plan")])),
});

export const WorkerRequestSchema = Type.Union([
	strict({ id: text(128), type: Type.Literal("init"), payload: initPayload }),
	strict({
		id: text(128),
		type: Type.Literal("prompt"),
		payload: strict({
			text: Type.String({ maxLength: 100_000 }),
			runId: Type.Optional(text(128)),
			attachments: Type.Optional(Type.Array(DesktopAttachmentSchema, { maxItems: MAX_ATTACHMENT_COUNT })),
		}),
	}),
	strict({
		id: text(128),
		type: Type.Literal("message"),
		payload: strict({
			text: Type.String({ maxLength: 100_000 }),
			deliverAs: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
			expectedRunId: Type.Optional(text(128)),
			attachments: Type.Optional(Type.Array(DesktopAttachmentSchema, { maxItems: MAX_ATTACHMENT_COUNT })),
		}),
	}),
	strict({ id: text(128), type: Type.Literal("queue.get"), payload: strict({}) }),
	strict({ id: text(128), type: Type.Literal("queue.clear"), payload: strict({}) }),
	strict({ id: text(128), type: Type.Literal("tool.policy.get"), payload: strict({}) }),
	strict({
		id: text(128),
		type: Type.Literal("tool.policy.set"),
		payload: strict({
			confirmToolCalls: Type.Optional(Type.Boolean()),
			mode: Type.Optional(Type.Union([Type.Literal("build"), Type.Literal("plan")])),
		}),
	}),
	strict({ id: text(128), type: Type.Literal("abort"), payload: Type.Optional(strict({})) }),
	strict({
		id: text(128),
		type: Type.Literal("compact"),
		payload: strict({ instructions: Type.Optional(Type.String({ maxLength: 20_000 })) }),
	}),
	strict({
		id: text(128),
		type: Type.Literal("fork"),
		payload: strict({
			entryId: text(512),
			position: Type.Optional(Type.Union([Type.Literal("before"), Type.Literal("at")])),
		}),
	}),
	strict({
		id: text(128),
		type: Type.Literal("new"),
		payload: strict({ parentSession: Type.Optional(text(32_768)) }),
	}),
	strict({ id: text(128), type: Type.Literal("switch"), payload: strict({ sessionFile: text(32_768) }) }),
	strict({ id: text(128), type: Type.Literal("history"), payload: Type.Optional(strict({})) }),
	strict({
		id: text(128),
		type: Type.Literal("session.rename"),
		payload: strict({ title: Type.String({ minLength: 1, maxLength: 200 }) }),
	}),
	strict({ id: text(128), type: Type.Literal("clone"), payload: strict({}) }),
	strict({ id: text(128), type: Type.Literal("tree.get"), payload: strict({}) }),
	strict({ id: text(128), type: Type.Literal("tree.navigate"), payload: strict({ entryId: text(512) }) }),
	strict({
		id: text(128),
		type: Type.Literal("session.import"),
		payload: strict({ sessionFile: text(32_768), cwdOverride: Type.Optional(text(32_768)) }),
	}),
	strict({
		id: text(128),
		type: Type.Literal("session.export"),
		payload: strict({ path: text(32_768), format: Type.Union([Type.Literal("html"), Type.Literal("jsonl")]) }),
	}),
	strict({
		id: text(128),
		type: Type.Literal("main.resolve"),
		payload: Type.Union([
			strict({ requestId: mainRequestId, result: Type.Unknown() }),
			strict({
				requestId: mainRequestId,
				error: strict({ code: text(128), message: Type.String({ maxLength: 10_000 }) }),
			}),
		]),
	}),
	strict({
		id: text(128),
		type: Type.Literal("model.list"),
		payload: Type.Optional(strict({ availableOnly: Type.Optional(Type.Boolean()) })),
	}),
	strict({
		id: text(128),
		type: Type.Literal("model.select"),
		payload: strict({ ...modelRef.properties, persist: Type.Optional(Type.Boolean()) }),
	}),
	strict({ id: text(128), type: Type.Literal("auth.refresh"), payload: strict({ provider: text(256) }) }),
	strict({
		id: text(128),
		type: Type.Literal("catalog.list"),
		payload: Type.Optional(strict({ provider: Type.Optional(text(256)) })),
	}),
	strict({ id: text(128), type: Type.Literal("resources.list"), payload: Type.Optional(strict({})) }),
	strict({
		id: text(128),
		type: Type.Literal("resources.run"),
		payload: strict({
			kind: Type.Union([
				Type.Literal("skill"),
				Type.Literal("template"),
				Type.Literal("command"),
				Type.Literal("extension"),
			]),
			id: text(4096),
		}),
	}),
	strict({ id: text(128), type: Type.Literal("settings.get"), payload: Type.Optional(strict({})) }),
	strict({
		id: text(128),
		type: Type.Literal("settings.update"),
		payload: strict({
			defaultModel: Type.Optional(modelRef),
			defaultThinkingLevel: Type.Optional(
				Type.Union([
					Type.Literal("off"),
					Type.Literal("minimal"),
					Type.Literal("low"),
					Type.Literal("medium"),
					Type.Literal("high"),
					Type.Literal("xhigh"),
					Type.Literal("max"),
				]),
			),
			steeringMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")])),
			followUpMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")])),
			compactionEnabled: Type.Optional(Type.Boolean()),
		}),
	}),
	strict({ id: text(128), type: Type.Literal("stats.get"), payload: Type.Optional(strict({})) }),
	strict({ id: text(128), type: Type.Literal("thinking.get"), payload: strict({}) }),
	strict({
		id: text(128),
		type: Type.Literal("thinking.set"),
		payload: strict({
			level: Type.Union([
				Type.Literal("off"),
				Type.Literal("minimal"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("xhigh"),
				Type.Literal("max"),
			]),
		}),
	}),
	strict({ id: text(128), type: Type.Literal("resources.reload"), payload: strict({}) }),
	strict({ id: text(128), type: Type.Literal("mcp.list"), payload: Type.Optional(strict({})) }),
	strict({ id: text(128), type: Type.Literal("mcp.reload"), payload: Type.Optional(strict({})) }),
	strict({ id: text(128), type: Type.Literal("mcp.sign-in"), payload: strict({ name: mcpName }) }),
	strict({ id: text(128), type: Type.Literal("mcp.sign-out"), payload: strict({ name: mcpName }) }),
	strict({ id: text(128), type: Type.Literal("mcp.reconnect"), payload: strict({ name: mcpName }) }),
	strict({
		id: text(128),
		type: Type.Literal("mcp.set-enabled"),
		payload: strict({ name: mcpName, enabled: Type.Boolean() }),
	}),
	strict({
		id: text(128),
		type: Type.Literal("mcp.set-exposure"),
		payload: strict({ name: mcpName, exposure: mcpExposure }),
	}),
	strict({
		id: text(128),
		type: Type.Literal("mcp.add"),
		payload: strict({
			name: mcpName,
			configJson: Type.String({ minLength: 2, maxLength: 64_000 }),
			scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
		}),
	}),
	strict({
		id: text(128),
		type: Type.Literal("mcp.update"),
		payload: strict({ name: mcpName, configJson: Type.String({ minLength: 2, maxLength: 64_000 }) }),
	}),
	strict({ id: text(128), type: Type.Literal("mcp.remove"), payload: strict({ name: mcpName }) }),
	strict({
		id: text(128),
		type: Type.Literal("ui.resolve"),
		payload: strict({
			requestId: text(128),
			result: Type.Optional(Type.Union([Type.String({ maxLength: 100_000 }), Type.Boolean(), Type.Null()])),
		}),
	}),
	strict({ id: text(128), type: Type.Literal("shutdown"), payload: Type.Optional(strict({})) }),
]);
export type WorkerRequest = Static<typeof WorkerRequestSchema>;

export type WorkerResponse =
	| { readonly id: string; readonly ok: true; readonly data: JsonValue }
	| {
			readonly id: string;
			readonly ok: false;
			readonly error: { readonly code: WorkerErrorCode; readonly message: string };
	  };

export type WorkerErrorCode =
	| "INVALID_REQUEST"
	| "NOT_INITIALIZED"
	| "ALREADY_INITIALIZED"
	| "UNSUPPORTED_OPERATION"
	| "INVALID_ARGUMENT"
	| "NOT_FOUND"
	| "OPERATION_FAILED"
	| "SHUTTING_DOWN";

export type WorkerEvent =
	| {
			readonly type: "event";
			readonly event: {
				readonly type: "state";
				readonly state: "ready" | "streaming" | "idle" | "failed" | "closed";
				readonly runId?: string;
				readonly outcome?: "completed" | "aborted";
				readonly sessionId?: string;
				readonly sessionFile?: string;
				readonly message?: string;
			};
	  }
	| {
			readonly type: "event";
			readonly event: {
				readonly type: "message";
				readonly phase: "start" | "update" | "end";
				readonly role: "user" | "assistant" | "toolResult";
				readonly text: string;
				readonly parts?: readonly JsonValue[];
				readonly timestamp?: number;
				readonly entryId?: string;
			};
	  }
	| {
			readonly type: "event";
			readonly event: {
				readonly type: "queue.update";
				readonly steering: readonly string[];
				readonly followUp: readonly string[];
				readonly pendingCount: number;
				readonly truncated: boolean;
			};
	  }
	| {
			readonly type: "event";
			readonly event: {
				readonly type: "tool";
				readonly phase: "start" | "update" | "end";
				readonly toolCallId: string;
				readonly toolName: string;
				readonly args: JsonValue;
				readonly result?: JsonValue;
				readonly isError?: boolean;
			};
	  }
	| {
			readonly type: "event";
			readonly event: {
				readonly type: "diagnostic";
				readonly level: "info" | "warning" | "error";
				readonly message: string;
				readonly code?: string;
				readonly operation?: string;
				readonly migration?: string;
			};
	  }
	| {
			readonly type: "event";
			readonly event: {
				readonly type: "ui.request";
				readonly requestId: string;
				readonly kind: "select" | "confirm" | "input" | "editor";
				readonly title: string;
				readonly message?: string;
				readonly placeholder?: string;
				readonly options?: readonly string[];
				readonly dialogOptions?: JsonValue;
			};
	  }
	| {
			readonly type: "event";
			readonly event: {
				readonly type: "ui.dismiss";
				readonly requestId: string;
				readonly reason: "aborted" | "timeout" | "closed";
			};
	  }
	| {
			readonly type: "event";
			readonly event: {
				readonly type: "ui.update";
				readonly update:
					| "notify"
					| "status"
					| "working"
					| "workingVisible"
					| "workingIndicator"
					| "hiddenThinkingLabel"
					| "widget"
					| "editor"
					| "toolsExpanded";
				readonly message?: string;
				readonly key?: string;
				readonly level?: "info" | "warning" | "error";
				readonly visible?: boolean;
				readonly mode?: "append" | "replace";
				readonly value?: JsonValue;
			};
	  }
	| {
			readonly type: "event";
			readonly event: { readonly type: "main.request" } & WorkerMainRequest & { readonly requestId: string };
	  }
	| {
			readonly type: "event";
			readonly event: { readonly type: "mcp.status"; readonly servers: readonly McpManagerServer[] };
	  }
	| {
			readonly type: "event";
			readonly event: { readonly type: "mcp.auth_url"; readonly name: string; readonly url: string };
	  };

export function isWorkerRequest(value: unknown): value is WorkerRequest {
	return Check(WorkerRequestSchema, value);
}

export function isWorkerMainRequest(value: unknown): value is WorkerMainRequest {
	return Check(WorkerMainRequestSchema, value);
}

export function parseMcpServerConfigJson(value: string): McpServerConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("MCP server config must be valid JSON");
	}
	if (!Check(mcpServerConfig, parsed)) {
		throw new Error("MCP server config must define a supported stdio or HTTP server");
	}
	return parsed as McpServerConfig;
}
