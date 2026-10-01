import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { DesktopTask } from "../shared/desktop-types.ts";
import type { TeamTaskRecord } from "./task-store.ts";

export type TaskDetail = Pick<DesktopTask, "messages" | "toolRecords" | "changes"> & {
	resultSummary?: string;
	usage?: DesktopTask["usage"];
};

type DetailRow = { readonly detail: string };
const MAX_RECOVERED_MESSAGES = 500;
const MAX_RECOVERED_TEXT = 20_000;

/** Persisted task detail projection. Pi's JSONL session remains authoritative for conversation history. */
export class TaskDetailStore {
	private readonly db: SqliteDatabase;

	private constructor(db: SqliteDatabase) {
		this.db = db;
	}

	static async open(db: SqliteDatabase): Promise<TaskDetailStore> {
		const store = new TaskDetailStore(db);
		await db.exec(`CREATE TABLE IF NOT EXISTS desktop_task_details (
			task_id TEXT PRIMARY KEY,
			detail TEXT NOT NULL CHECK (json_valid(detail))
		) STRICT`);
		return store;
	}

	async get(taskId: string): Promise<TaskDetail | undefined> {
		const row = await this.db.get<DetailRow>("SELECT detail FROM desktop_task_details WHERE task_id = ?", taskId);
		return row === undefined ? undefined : (JSON.parse(row.detail) as TaskDetail);
	}

	async save(taskId: string, detail: TaskDetail): Promise<void> {
		await this.db.run(
			`INSERT INTO desktop_task_details (task_id, detail) VALUES (?, ?)
			ON CONFLICT(task_id) DO UPDATE SET detail = excluded.detail`,
			taskId,
			JSON.stringify(detail),
		);
	}
}

function messageText(message: AgentMessage): string {
	if (message.role === "user") return typeof message.content === "string" ? redactText(message.content) : "";
	if (message.role === "assistant" || message.role === "toolResult") {
		return message.content
			.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [redactText(part.text)] : []))
			.join("")
			.slice(0, MAX_RECOVERED_TEXT);
	}
	return "";
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

function usageFromEntries(entries: readonly SessionEntry[]): { input: number; output: number } {
	let input = 0;
	let output = 0;
	const add = (usage: { readonly input: number; readonly output: number } | undefined): void => {
		if (!usage) return;
		input += usage.input;
		output += usage.output;
	};
	for (const entry of entries) {
		if (entry.type === "usage") add(entry.usage);
		else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) add(entry.usage);
		else if (entry.type === "message") {
			if (entry.message.role === "assistant" || entry.message.role === "toolResult") add(entry.message.usage);
		}
	}
	return { input, output };
}

function recoverMessages(entries: readonly SessionEntry[]): TaskDetail["messages"] {
	return entries
		.flatMap((entry) => {
			if (entry.type !== "message") return [];
			const role = entry.message.role;
			if (role !== "user" && role !== "assistant" && role !== "toolResult") return [];
			return [
				{
					id: entry.id,
					author: role,
					text: messageText(entry.message),
					createdAt: new Date(entry.message.timestamp).toISOString(),
				},
			];
		})
		.slice(-MAX_RECOVERED_MESSAGES);
}

function recoverTools(entries: readonly SessionEntry[]): TaskDetail["toolRecords"] {
	const records = new Map<string, TaskDetail["toolRecords"][number]>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				records.set(part.id, {
					id: part.id,
					name: part.name,
					status: "interrupted",
					summary: "Tool call has no recorded result",
					createdAt: new Date(message.timestamp).toISOString(),
				});
			}
		} else if (message.role === "toolResult") {
			const summary = message.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("")
				.slice(0, 1500);
			records.set(message.toolCallId, {
				id: message.toolCallId,
				name: message.toolName,
				status: message.isError ? "error" : "complete",
				summary,
				createdAt: new Date(message.timestamp).toISOString(),
			});
		}
	}
	return [...records.values()];
}

/** Rebuild a task detail snapshot without starting an agent or replaying tools. */
export function recoverTaskDetail(task: TeamTaskRecord): TaskDetail & { readonly lastSettledEntryId: string | null } {
	if (!task.sessionFile) {
		return {
			messages: [],
			toolRecords: [],
			changes: [],
			lastSettledEntryId: task.lastSettledEntryId,
		};
	}
	const manager = SessionManager.open(task.sessionFile, undefined, task.worktreePath ?? undefined);
	const branch = manager.getBranch();
	const messages = recoverMessages(branch);
	let lastSettledEntryId: string | null = null;
	let resultSummary: string | undefined;
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (
			entry.message.stopReason !== "toolUse" &&
			entry.message.stopReason !== "error" &&
			entry.message.stopReason !== "aborted"
		) {
			lastSettledEntryId = entry.id;
			const text = messageText(entry.message).trim();
			if (text) resultSummary = text.slice(0, 3000);
		}
	}
	return {
		messages,
		toolRecords: recoverTools(branch),
		changes: [],
		...(resultSummary === undefined ? {} : { resultSummary }),
		usage: usageFromEntries(manager.getEntries()),
		lastSettledEntryId: lastSettledEntryId ?? task.lastSettledEntryId,
	};
}
