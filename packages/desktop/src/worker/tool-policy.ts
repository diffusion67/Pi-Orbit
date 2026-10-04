import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";

export type DesktopToolMode = "build" | "plan";

export type DesktopToolPolicyState = {
	readonly confirmToolCalls: boolean;
	readonly mode: DesktopToolMode;
};

const POLICY_ENTRY_TYPE = "pi-orbit-tool-policy";
const PLAN_MODE_GUIDELINE =
	"You are in plan mode. Inspect the project and prepare a plan. Do not modify files or run commands that can change state.";
const PLAN_ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "tool_search", "team_roles"]);
const MAX_TOOL_ARGUMENTS_TEXT = 3_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactText(value: string): string {
	return value
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|sk_[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
		.replace(
			/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
			"$1[REDACTED]",
		);
}

function safeArguments(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") return redactText(value).slice(0, MAX_TOOL_ARGUMENTS_TEXT);
	if (typeof value !== "object" || depth >= 4 || seen.has(value)) return "[omitted]";
	seen.add(value);
	if (Array.isArray(value)) return value.slice(0, 32).map((item) => safeArguments(item, depth + 1, seen));
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value).slice(0, 64)) {
		result[key] = /(?:api.?key|token|secret|password|credential|authorization)/i.test(key)
			? "[REDACTED]"
			: safeArguments(item, depth + 1, seen);
	}
	return result;
}

function formatToolArguments(value: unknown): string {
	try {
		return JSON.stringify(safeArguments(value)).slice(0, MAX_TOOL_ARGUMENTS_TEXT);
	} catch {
		return "[omitted]";
	}
}

function readMode(sessionManager: Pick<SessionManager, "getBranch">): DesktopToolMode {
	for (const entry of [...sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== POLICY_ENTRY_TYPE || !isRecord(entry.data)) continue;
		if (entry.data.mode === "build" || entry.data.mode === "plan") return entry.data.mode;
	}
	return "build";
}

/** Mutable worker policy shared by the built-in extension and typed worker commands. */
export class DesktopToolPolicy {
	private confirmToolCalls: boolean;
	private mode: DesktopToolMode;
	private sessionManager?: Pick<SessionManager, "getBranch" | "appendCustomEntry">;

	constructor(confirmToolCalls = true) {
		this.confirmToolCalls = confirmToolCalls;
		this.mode = "build";
	}

	bindSessionManager(
		sessionManager: Pick<SessionManager, "getBranch" | "appendCustomEntry">,
		modeOverride?: DesktopToolMode,
	): void {
		this.sessionManager = sessionManager;
		this.mode = readMode(sessionManager);
		if (modeOverride !== undefined) this.setMode(modeOverride);
	}

	getState(): DesktopToolPolicyState {
		return { confirmToolCalls: this.confirmToolCalls, mode: this.mode };
	}

	setConfirmToolCalls(enabled: boolean): void {
		this.confirmToolCalls = enabled;
	}

	setMode(mode: DesktopToolMode): void {
		if (mode === this.mode) return;
		if (!this.sessionManager) throw new Error("Tool policy cannot be persisted before the session is ready");
		this.sessionManager.appendCustomEntry(POLICY_ENTRY_TYPE, { mode });
		this.mode = mode;
	}

	readonly extensionFactory = (pi: ExtensionAPI): void => {
		pi.on("before_agent_start", (event) => {
			if (this.mode === "plan") event.systemPromptOptions.promptGuidelines.push(PLAN_MODE_GUIDELINE);
		});

		pi.on("tool_call", async (event, ctx) => {
			if (this.mode === "plan" && !PLAN_ALLOWED_TOOLS.has(event.toolName)) {
				return { block: true, reason: `${event.toolName} is blocked while Plan mode is active.` };
			}
			if (!this.confirmToolCalls) return undefined;
			if (!ctx.hasUI) return { block: true, reason: "Tool call blocked because confirmation UI is unavailable." };

			const approved = await ctx.ui.confirm(
				`Allow ${event.toolName}?`,
				`Tool: ${event.toolName}\nArguments: ${formatToolArguments(event.input)}`,
				{ signal: ctx.signal },
			);
			return approved ? undefined : { block: true, reason: "Tool call was not approved." };
		});
	};
}
