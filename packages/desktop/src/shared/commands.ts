import Type, { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { DesktopAttachmentSchema, MAX_ATTACHMENT_COUNT } from "./attachments.ts";

const object = <const T extends Parameters<typeof Type.Object>[0]>(fields: T) =>
	Type.Object(fields, { additionalProperties: false });
const identifier = Type.String({ minLength: 1, maxLength: 256 });
const text = Type.String({ minLength: 1, maxLength: 100_000 });
const path = Type.String({ minLength: 1, maxLength: 4096 });
const empty = Type.Undefined();
const thinkingLevel = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

export const desktopCommandSchemas = {
	"app.snapshot": empty,
	"app.quit": empty,
	"project.open": object({ path }),
	"project.browse": object({ path: Type.Optional(path) }),
	"project.create": object({ path, name: Type.String({ minLength: 1, maxLength: 200 }) }),
	"project.changes": object({
		projectId: identifier,
		mode: Type.Optional(
			Type.Union([Type.Literal("workingTree"), Type.Literal("baseBranch"), Type.Literal("commit")]),
		),
		ref: Type.Optional(identifier),
	}),
	"session.select": object({ sessionId: identifier }),
	"session.archive": object({ sessionId: identifier }),
	"session.restore": object({ sessionId: identifier }),
	"session.policy.get": object({ sessionId: identifier }),
	"session.policy.set": object({
		sessionId: identifier,
		mode: Type.Union([Type.Literal("build"), Type.Literal("plan")]),
	}),
	"session.queue.get": object({ sessionId: identifier }),
	"session.queue.clear": object({ sessionId: identifier }),
	"session.rename": object({ sessionId: identifier, title: Type.String({ minLength: 1, maxLength: 200 }) }),
	"session.create": object({ projectId: identifier, model: Type.Optional(identifier) }),
	"session.import": object({ projectId: identifier }),
	"session.export": object({
		sessionId: identifier,
		format: Type.Optional(Type.Union([Type.Literal("html"), Type.Literal("jsonl")])),
	}),
	"session.prompt": object({
		sessionId: identifier,
		text: Type.String({ maxLength: 100_000 }),
		attachments: Type.Optional(Type.Array(DesktopAttachmentSchema, { maxItems: MAX_ATTACHMENT_COUNT })),
	}),
	"session.message": object({
		sessionId: identifier,
		text: Type.String({ maxLength: 100_000 }),
		deliverAs: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
		attachments: Type.Optional(Type.Array(DesktopAttachmentSchema, { maxItems: MAX_ATTACHMENT_COUNT })),
	}),
	"session.abort": object({ sessionId: identifier }),
	"session.fork": object({
		sessionId: identifier,
		entryId: Type.Optional(identifier),
		position: Type.Optional(Type.Union([Type.Literal("before"), Type.Literal("at")])),
	}),
	"session.clone": object({ sessionId: identifier }),
	"session.tree": object({ sessionId: identifier }),
	"session.navigate": object({ sessionId: identifier, entryId: identifier }),
	"session.stats": object({ sessionId: identifier }),
	"session.thinking.get": object({ sessionId: identifier }),
	"session.thinking.set": object({ sessionId: identifier, level: thinkingLevel }),
	"session.reload": object({ sessionId: identifier }),
	"session.compact": object({
		sessionId: identifier,
		instructions: Type.Optional(Type.String({ maxLength: 20_000 })),
	}),
	"model.select": object({ sessionId: identifier, model: identifier }),
	"mcp.list": object({ sessionId: identifier }),
	"mcp.sign-in": object({ sessionId: identifier, name: identifier }),
	"mcp.sign-out": object({ sessionId: identifier, name: identifier }),
	"mcp.reconnect": object({ sessionId: identifier, name: identifier }),
	"mcp.set-enabled": object({ sessionId: identifier, name: identifier, enabled: Type.Boolean() }),
	"mcp.set-exposure": object({
		sessionId: identifier,
		name: identifier,
		exposure: Type.Union([
			Type.Literal("codemode"),
			Type.Literal("deferred"),
			Type.Literal("direct"),
			Type.Literal("hidden"),
		]),
	}),
	"mcp.add": object({
		sessionId: identifier,
		name: identifier,
		scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
		configJson: Type.String({ minLength: 2, maxLength: 32_768 }),
	}),
	"mcp.update": object({
		sessionId: identifier,
		name: identifier,
		configJson: Type.String({ minLength: 2, maxLength: 32_768 }),
	}),
	"mcp.remove": object({ sessionId: identifier, name: identifier }),
	"mcp.reload": object({ sessionId: identifier }),
	"auth.configure": object({ providerId: identifier, credential: Type.String({ minLength: 1, maxLength: 16_384 }) }),
	"provider.save": object({
		id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" }),
		name: Type.String({ minLength: 1, maxLength: 200 }),
		api: Type.Union([
			Type.Literal("anthropic-messages"),
			Type.Literal("openai-completions"),
			Type.Literal("openai-responses"),
			Type.Literal("openai-codex-responses"),
		]),
		baseUrl: Type.String({ minLength: 1, maxLength: 2048 }),
		credential: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
		models: Type.Array(
			object({
				id: identifier,
				name: Type.String({ minLength: 1, maxLength: 200 }),
				reasoning: Type.Boolean(),
				input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
					minItems: 1,
					maxItems: 2,
					uniqueItems: true,
				}),
				contextWindow: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
				maxTokens: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
			}),
			{ minItems: 1, maxItems: 100 },
		),
	}),
	"provider.remove": object({ providerId: identifier }),
	"auth.clear": object({ providerId: identifier }),
	"auth.login": object({ providerId: identifier }),
	"auth.logout": object({ providerId: identifier }),
	"auth.respond": object({ flowId: identifier, promptId: identifier, value: Type.String({ maxLength: 16_384 }) }),
	"auth.cancel": object({ flowId: identifier }),
	"auth.open-url": object({ url: Type.String({ minLength: 1, maxLength: 2048 }) }),
	"settings.save": object({
		language: Type.Union([Type.Literal("en"), Type.Literal("zh-CN")]),
		theme: Type.Union([Type.Literal("dark"), Type.Literal("light"), Type.Literal("system")]),
		defaultModel: Type.String({ maxLength: 256 }),
		confirmToolCalls: Type.Boolean(),
		sendShortcut: Type.Union([Type.Literal("enter"), Type.Literal("ctrlEnter")]),
		subagentsEnabled: Type.Boolean(),
		maxParallelTasks: Type.Integer({ minimum: 1, maximum: 4 }),
	}),
	"role.save": object({
		id: identifier,
		name: Type.String({ minLength: 1, maxLength: 200 }),
		description: Type.String({ maxLength: 2000 }),
		systemPrompt: Type.String({ maxLength: 100_000 }),
		model: Type.String({ maxLength: 256 }),
		tools: Type.Array(identifier, { maxItems: 64 }),
		scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
	}),
	"catalog.toggle": object({
		kind: Type.Union([
			Type.Literal("skill"),
			Type.Literal("template"),
			Type.Literal("command"),
			Type.Literal("extension"),
		]),
		id: identifier,
		enabled: Type.Boolean(),
	}),
	"catalog.run": object({
		kind: Type.Union([
			Type.Literal("skill"),
			Type.Literal("template"),
			Type.Literal("command"),
			Type.Literal("extension"),
		]),
		id: identifier,
	}),
	"task.create": object({
		projectId: identifier,
		parentTaskId: Type.Optional(identifier),
		roleId: identifier,
		prompt: text,
		dependsOn: Type.Array(identifier, { maxItems: 100 }),
	}),
	"task.message": object({ taskId: identifier, text }),
	"task.pause": object({ taskId: identifier }),
	"task.resume": object({ taskId: identifier }),
	"task.cancel": object({ taskId: identifier }),
	"task.merge": object({ taskId: identifier }),
	"terminal.start": object({ projectId: identifier, command: Type.Optional(Type.String({ maxLength: 512 })) }),
	"terminal.input": object({ terminalId: identifier, text: Type.String({ maxLength: 65_536 }) }),
	"terminal.resize": object({
		terminalId: identifier,
		cols: Type.Integer({ minimum: 1, maximum: 1000 }),
		rows: Type.Integer({ minimum: 1, maximum: 1000 }),
	}),
	"terminal.stop": object({ terminalId: identifier }),
	"extension.ui.respond": object({ requestId: identifier, value: Type.Unknown() }),
	"capability.open": object({ capability: identifier }),
} as const satisfies Record<string, TSchema>;

export type DesktopCommand = keyof typeof desktopCommandSchemas;
export type DesktopCommandPayload<K extends DesktopCommand> = Static<(typeof desktopCommandSchemas)[K]>;

export function isDesktopCommand(command: unknown): command is DesktopCommand {
	return typeof command === "string" && Object.hasOwn(desktopCommandSchemas, command);
}

export function isValidDesktopPayload(command: DesktopCommand, payload: unknown): boolean {
	return Check(desktopCommandSchemas[command], payload);
}
