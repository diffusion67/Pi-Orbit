import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type CustomToolCallEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionHandler,
	SessionManager,
	type ToolCallEvent,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DesktopToolPolicy } from "../../src/worker/tool-policy.ts";

type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;
type BeforeAgentStartHandler = ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
type PolicyHandlers = { tool_call?: ToolCallHandler; before_agent_start?: BeforeAgentStartHandler };

function bindHandlers(policy: DesktopToolPolicy): PolicyHandlers {
	const handlers: PolicyHandlers = {};
	const api = {
		on: <K extends keyof PolicyHandlers>(event: K, handler: NonNullable<PolicyHandlers[K]>) => {
			handlers[event] = handler;
			return () => undefined;
		},
	} as unknown as ExtensionAPI;
	policy.extensionFactory(api);
	return handlers;
}

function context(hasUI: boolean, confirm: (title: string, message: string) => Promise<boolean>): ExtensionContext {
	return { hasUI, signal: new AbortController().signal, ui: { confirm } } as unknown as ExtensionContext;
}

function toolCallHandler(handlers: PolicyHandlers): ToolCallHandler {
	const handler = handlers.tool_call;
	if (!handler) throw new Error("Tool policy did not register its tool_call handler");
	return handler;
}

function toolCall(toolName: string, input: Record<string, unknown>): CustomToolCallEvent {
	return { type: "tool_call", toolCallId: "test-call", toolName, input };
}

describe("desktop tool policy", () => {
	it("defaults to build mode with tool confirmations enabled and confirms safe bounded arguments", async () => {
		const policy = new DesktopToolPolicy();
		const handlers = bindHandlers(policy);
		expect(policy.getState()).toEqual({ confirmToolCalls: true, mode: "build" });
		let dialogMessage = "";
		let dialogTitle = "";
		const result = await toolCallHandler(handlers)(
			toolCall("read", { path: "C:/project/file.ts", password: "secret", note: "Bearer token-value" }),
			context(true, async (_title, message) => {
				dialogTitle = _title;
				dialogMessage = message;
				return true;
			}),
		);
		expect(result).toBeUndefined();
		expect(dialogTitle).toBe("Allow read?");
		expect(dialogMessage).toContain('"password":"[REDACTED]"');
		expect(dialogMessage).toContain("Bearer [REDACTED]");
	});

	it("blocks denied and unavailable confirmations and skips dialogs when disabled", async () => {
		const policy = new DesktopToolPolicy();
		const handler = toolCallHandler(bindHandlers(policy));
		await expect(
			handler(
				toolCall("bash", { command: "rm -rf ." }),
				context(true, async () => false),
			),
		).resolves.toMatchObject({ block: true });
		await expect(
			handler(
				toolCall("bash", { command: "echo hi" }),
				context(false, async () => true),
			),
		).resolves.toMatchObject({ block: true });

		policy.setConfirmToolCalls(false);
		await expect(
			handler(
				toolCall("bash", { command: "echo hi" }),
				context(false, async () => true),
			),
		).resolves.toBeUndefined();
	});

	it("adds plan instructions and blocks every tool outside its explicit read-only allowlist", async () => {
		const policy = new DesktopToolPolicy(false);
		policy.bindSessionManager({ getBranch: () => [], appendCustomEntry: () => "entry-1" });
		policy.setMode("plan");
		const handlers = bindHandlers(policy);
		const beforeStart = handlers.before_agent_start;
		if (!beforeStart) throw new Error("Tool policy did not register its before_agent_start handler");
		const promptGuidelines: string[] = [];
		await beforeStart(
			{
				type: "before_agent_start",
				prompt: "Review this project",
				systemPrompt: "System prompt",
				systemPromptOptions: {
					cwd: process.cwd(),
					selectedTools: [],
					toolSnippets: {},
					toolGuidelines: {},
					promptGuidelines,
					appendSystemPrompt: "",
					sections: {},
					contextFiles: [],
					skills: [],
				},
			},
			context(false, async () => true),
		);
		expect(promptGuidelines.join(" ")).toContain("in plan mode");

		const handler = toolCallHandler(handlers);
		for (const toolName of ["write", "edit", "bash", "powershell", "codemode", "unknown_tool"]) {
			await expect(
				handler(
					toolCall(toolName, {}),
					context(false, async () => true),
				),
			).resolves.toMatchObject({ block: true });
		}
		for (const toolName of ["read", "grep", "find", "ls", "tool_search", "team_roles"]) {
			await expect(
				handler(
					toolCall(toolName, {}),
					context(false, async () => true),
				),
			).resolves.toBeUndefined();
		}
	});

	it("restores plan mode from a native session entry after reopening", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-tool-policy-"));
		try {
			const first = SessionManager.create(directory, join(directory, "sessions"));
			first.appendMessage({ role: "user", content: "existing conversation", timestamp: Date.now() });
			const policy = new DesktopToolPolicy(false);
			policy.bindSessionManager(first);
			policy.setMode("plan");
			const sessionFile = first.getSessionFile();
			expect(sessionFile).toBeDefined();

			const reopened = SessionManager.open(sessionFile!, undefined, directory);
			expect(reopened.getBranch()).toContainEqual(
				expect.objectContaining({ type: "custom", customType: "pi-orbit-tool-policy", data: { mode: "plan" } }),
			);
			const restoredPolicy = new DesktopToolPolicy(false);
			restoredPolicy.bindSessionManager(reopened);
			expect(restoredPolicy.getState()).toEqual({ confirmToolCalls: false, mode: "plan" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
