import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";
import { AppEventLog } from "../../src/main/event-log.ts";
import { TeamTaskStore } from "../../src/team/task-store.ts";

describe("AppEventLog", () => {
	it("replays committed task and other events after the snapshot sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-events-"));
		const db = await openNodeSqliteDatabase(join(directory, "app.sqlite"));
		const tasks = await TeamTaskStore.openDatabase(db);
		try {
			const events = await AppEventLog.open(db);
			const before = await events.latestSequence();
			await tasks.createTask({
				id: "task",
				projectId: "project",
				parentTaskId: null,
				roleId: "worker",
				prompt: "Test",
				dependsOn: [],
			});
			await events.append("diagnostic", { code: "CHECK", message: "Ready" });
			expect((await events.eventsSince(before)).map((event) => [event.seq, event.kind])).toEqual([
				[1, "team"],
				[2, "diagnostic"],
			]);
			expect(await events.eventsSince(1)).toEqual([
				{ seq: 2, kind: "diagnostic", payload: { code: "CHECK", message: "Ready" } },
			]);
		} finally {
			await tasks.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
