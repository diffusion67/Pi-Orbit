import Type, { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { DesktopAttachmentSchema, MAX_ATTACHMENT_COUNT } from "./attachments.ts";

const object = <const T extends Parameters<typeof Type.Object>[0]>(fields: T) =>
	Type.Object(fields, { additionalProperties: false });
const identifier = Type.String({ minLength: 1, maxLength: 256 });
const text = Type.String({ minLength: 1, maxLength: 100_000 });
const path = Type.String({ minLength: 1, maxLength: 4096 });
const empty = Type.Undefined();

export const desktopCommandSchemas = {
	"app.snapshot": empty,
	"app.quit": empty,
	"project.open": object({ path }),
	"project.create": object({ path, name: Type.String({ minLength: 1, maxLength: 200 }) }),
	"session.select": object({ sessionId: identifier }),
	"session.rename": object({ sessionId: identifier, title: Type.String({ minLength: 1, maxLength: 200 }) }),
	"session.create": object({ projectId: identifier, model: Type.Optional(identifier) }),
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
	"session.fork": object({ sessionId: identifier }),
	"session.compact": object({ sessionId: identifier }),
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
