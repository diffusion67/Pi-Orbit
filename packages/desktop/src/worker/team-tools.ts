import type { JsonValue } from "@earendil-works/chord";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import Type, { type Static, type TSchema } from "typebox";
import type { WorkerMainRequest } from "../shared/worker-protocol.ts";

type MainTeamRequest = Extract<WorkerMainRequest, { readonly action: string }>;
type MainTeamCall = (request: MainTeamRequest, signal?: AbortSignal) => Promise<JsonValue>;

const noParameters = Type.Object({}, { additionalProperties: false });
const createTaskParameters = Type.Object(
	{
		roleId: Type.String({ minLength: 1, maxLength: 256 }),
		prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
		dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 })),
	},
	{ additionalProperties: false },
);
const taskMessageParameters = Type.Object(
	{
		taskId: Type.String({ minLength: 1, maxLength: 128 }),
		text: Type.String({ minLength: 1, maxLength: 100_000 }),
	},
	{ additionalProperties: false },
);
const taskParameters = Type.Object(
	{ taskId: Type.String({ minLength: 1, maxLength: 128 }) },
	{ additionalProperties: false },
);
const waitParameters = Type.Object(
	{
		taskId: Type.String({ minLength: 1, maxLength: 128 }),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })),
	},
	{ additionalProperties: false },
);

function tool<TParams extends TSchema>(
	name: string,
	label: string,
	description: string,
	parameters: TParams,
	call: (params: Static<TParams>, signal?: AbortSignal) => Promise<JsonValue>,
): ToolDefinition<TSchema, unknown> {
	return {
		name,
		label,
		description,
		promptSnippet: description,
		parameters,
		execute: async (_toolCallId, params, signal) => {
			const details = await call(params as Static<TParams>, signal);
			const serialized = JSON.stringify(details).slice(0, 8_000);
			return {
				content: [{ type: "text", text: serialized }],
				details: serialized,
			};
		},
	};
}

/** Tools exposed only to a main project session, with every team action delegated to Electron main. */
export function createDesktopTeamTools(callMain: MainTeamCall): ToolDefinition<TSchema, unknown>[] {
	return [
		tool(
			"team_roles",
			"Roles",
			"List the available agent roles for delegated tasks.",
			noParameters,
			(_params, signal) => callMain({ action: "team.roles", payload: {} }, signal),
		),
		tool(
			"task_create",
			"Create task",
			"Create a delegated task using an available role. Tasks use an isolated Git worktree.",
			createTaskParameters,
			(params, signal) => callMain({ action: "task.create", payload: params }, signal),
		),
		tool(
			"task_message",
			"Message task",
			"Send a follow-up instruction to a delegated task.",
			taskMessageParameters,
			(params, signal) => callMain({ action: "task.message", payload: params }, signal),
		),
		tool(
			"task_wait",
			"Wait for task",
			"Wait up to one minute for a delegated task to change state and return its summary.",
			waitParameters,
			(params, signal) => callMain({ action: "task.wait", payload: params }, signal),
		),
		tool(
			"task_cancel",
			"Cancel task",
			"Cancel a delegated task and stop its worker.",
			taskParameters,
			(params, signal) => callMain({ action: "task.cancel", payload: params }, signal),
		),
	];
}
