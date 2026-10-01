import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import { recoverTaskDetail, TaskDetailStore } from "../../src/team/task-details.ts";

const directories = new Set<string>();
afterEach(async () => {
	for (const directory of directories)
		await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
	directories.clear();
});

const usage: Usage = {
	input: 12,
	output: 7,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 19,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage,
		stopReason,
		timestamp: Date.UTC(2026, 0, 1),
	};
}

describe("TaskDetailStore and recovery", () => {
	it("rebuilds transcript, usage, completed tools, and the last settled checkpoint from Pi history", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-desktop-task-history-"));
		directories.add(directory);
		const session = SessionManager.create(directory, join(directory, "sessions"));
		session.appendMessage({ role: "user", content: "Implement it", timestamp: Date.UTC(2026, 0, 1) });
		const checkpointId = session.appendMessage(assistant("Done"));
		session.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
			api: "openai-completions",
			provider: "openai",
			model: "test-model",
			usage,
			stopReason: "toolUse",
			timestamp: Date.UTC(2026, 0, 1, 0, 1),
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: Date.UTC(2026, 0, 1, 0, 1),
		});
		const task = {
			id: "task-1",
			projectId: "project-1",
			parentTaskId: null,
			roleId: "role-1",
			prompt: "Implement it",
			dependsOn: [],
			status: "review" as const,
			baseCommit: "base",
			worktreePath: directory,
			sessionFile: session.getSessionFile() ?? null,
			lastSettledEntryId: null,
			createdAt: 0,
			updatedAt: 0,
		};

		const recovered = recoverTaskDetail(task);
		expect(recovered.messages.map((message) => message.text)).toEqual(["Implement it", "Done", "", "file contents"]);
		expect(recovered.lastSettledEntryId).toBe(checkpointId);
		expect(recovered.resultSummary).toBe("Done");
		expect(recovered.usage).toEqual({ input: 24, output: 14 });
		expect(recovered.toolRecords).toEqual([
			{
				id: "call-1",
				name: "read",
				status: "complete",
				summary: "file contents",
				createdAt: new Date(Date.UTC(2026, 0, 1, 0, 1)).toISOString(),
			},
		]);

		const db = await openNodeSqliteDatabase(join(directory, "orbit.sqlite"));
		const store = await TaskDetailStore.open(db);
		await store.save(task.id, recovered);
		expect(await store.get(task.id)).toEqual(recovered);
		await db.close();
	});

	it("marks a tool call without a result interrupted and never advances the checkpoint to it", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-desktop-task-interrupted-"));
		directories.add(directory);
		const session = SessionManager.create(directory, join(directory, "sessions"));
		const checkpointId = session.appendMessage(assistant("Previous settled answer"));
		session.appendMessage({
			...assistant("", "toolUse"),
			content: [{ type: "toolCall", id: "call-pending", name: "write", arguments: {} }],
		});
		const file = session.getSessionFile();
		if (!file) throw new Error("Test session was not persisted");
		const recovered = recoverTaskDetail({
			id: "task-2",
			projectId: "project-1",
			parentTaskId: null,
			roleId: "role-1",
			prompt: "Continue",
			dependsOn: [],
			status: "review",
			baseCommit: "base",
			worktreePath: directory,
			sessionFile: file,
			lastSettledEntryId: null,
			createdAt: 0,
			updatedAt: 0,
		});
		expect(recovered.lastSettledEntryId).toBe(checkpointId);
		expect(recovered.toolRecords[0]).toMatchObject({
			id: "call-pending",
			status: "interrupted",
			summary: "Tool call has no recorded result",
		});
	});
});
