import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import { type NewTeamTask, TeamTaskError, TeamTaskStore } from "../../src/team/task-store.ts";

const directories = new Set<string>();
const stores = new Set<TeamTaskStore>();

afterEach(async () => {
	for (const store of stores) await store.close();
	stores.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function openStore() {
	const directory = await mkdtemp(join(tmpdir(), "pi-desktop-team-"));
	directories.add(directory);
	const store = await TeamTaskStore.open(join(directory, "tasks.sqlite"));
	stores.add(store);
	return { store, path: join(directory, "tasks.sqlite") };
}

function task(id: string, projectId = "project", dependsOn: readonly string[] = []): NewTeamTask {
	return { id, projectId, parentTaskId: null, roleId: "default", prompt: `Work on ${id}`, dependsOn };
}

describe("TeamTaskStore", () => {
	it("atomically limits simultaneous resumes to four running tasks", async () => {
		const { store } = await openStore();
		for (let index = 0; index < 5; index++) await store.createTask(task(`parallel-${index}`));
		await store.startReadyTasks("project");
		await store.transitionTask("parallel-0", "paused");
		await store.startReadyTasks("project");
		await store.transitionTask("parallel-1", "paused");
		const outcomes = await Promise.allSettled([
			store.transitionTask("parallel-0", "running"),
			store.transitionTask("parallel-1", "running"),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect((await store.snapshot("project")).tasks.filter((item) => item.status === "running")).toHaveLength(4);
	});

	it("persists task state and a matching, increasing event sequence", async () => {
		const { store } = await openStore();
		const created = await store.createTask(task("first"));
		const running = await store.startReadyTasks("project");
		const review = await store.transitionTask("first", "review");
		const snapshot = await store.snapshot("project");
		const events = await store.eventsSince(0, "project");

		expect(created.status).toBe("queued");
		expect(running.map((item) => item.id)).toEqual(["first"]);
		expect(review.status).toBe("review");
		expect(snapshot.tasks[0]?.status).toBe("review");
		expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
		expect(events.at(-1)?.task.status).toBe("review");
		expect((await store.eventsSince(2, "project")).map((event) => event.seq)).toEqual([3]);
	});

	it("starts only dependency-ready work and enforces the per-project concurrency limit", async () => {
		const { store } = await openStore();
		for (let index = 0; index < 6; index++) await store.createTask(task(`task-${index}`));
		await store.createTask(task("downstream", "project", ["task-0"]));

		expect((await store.startReadyTasks("project")).map((item) => item.id)).toEqual([
			"task-0",
			"task-1",
			"task-2",
			"task-3",
		]);
		await store.transitionTask("task-0", "failed");
		expect((await store.startReadyTasks("project")).map((item) => item.id)).toEqual(["task-4"]);
		expect(await store.getTask("downstream")).toMatchObject({
			status: "failed",
			blockedReason: "Blocked because prerequisite task-0 ended as failed.",
		});
	});

	it("rejects self cycles and cross-project dependencies", async () => {
		const { store } = await openStore();
		await expect(store.createTask(task("self", "project", ["self"]))).rejects.toMatchObject({
			code: "DEPENDENCY_CYCLE",
		});
		await store.createTask(task("other", "other-project"));
		await expect(store.createTask(task("cross", "project", ["other"]))).rejects.toBeInstanceOf(TeamTaskError);
	});

	it("moves interrupted running tasks to review on reopen without replay", async () => {
		const { store, path } = await openStore();
		await store.createTask(task("interrupted"));
		await store.startReadyTasks("project");
		await store.close();
		stores.delete(store);

		const reopened = await TeamTaskStore.open(path);
		stores.add(reopened);
		expect((await reopened.getTask("interrupted"))?.status).toBe("review");
		const events = await reopened.eventsSince(0, "project");
		expect(events.at(-1)).toMatchObject({
			type: "status.changed",
			previousStatus: "running",
			task: { status: "review" },
		});
		expect(await reopened.startReadyTasks("project")).toEqual([]);
	});

	it("does not release a dependent task until its prerequisite succeeds", async () => {
		const { store } = await openStore();
		await store.createTask(task("dependency"));
		await store.createTask(task("dependent", "project", ["dependency"]));
		expect((await store.startReadyTasks("project")).map((item) => item.id)).toEqual(["dependency"]);
		await store.transitionTask("dependency", "completed");
		expect((await store.startReadyTasks("project")).map((item) => item.id)).toEqual(["dependent"]);
	});

	it("fails queued descendants with a persisted explanation when a prerequisite fails", async () => {
		const { store, path } = await openStore();
		await store.createTask(task("root"));
		await store.createTask(task("child", "project", ["root"]));
		await store.createTask(task("leaf", "project", ["child"]));
		await store.startReadyTasks("project");

		await store.transitionTask("root", "failed");

		expect(await store.getTask("child")).toMatchObject({
			status: "failed",
			blockedReason: "Blocked because prerequisite root ended as failed.",
		});
		expect(await store.getTask("leaf")).toMatchObject({
			status: "failed",
			blockedReason: "Blocked because prerequisite child ended as failed.",
		});
		expect(await store.createTask(task("late", "project", ["root"]))).toMatchObject({
			status: "failed",
			blockedReason: "Blocked because prerequisite root ended as failed.",
		});
		await store.close();
		stores.delete(store);

		const reopened = await TeamTaskStore.open(path);
		stores.add(reopened);
		expect(await reopened.getTask("leaf")).toMatchObject({
			status: "failed",
			blockedReason: "Blocked because prerequisite child ended as failed.",
		});
		expect(await reopened.startReadyTasks("project")).toEqual([]);
	});

	it("fails a queued task with a reason when its prerequisite is cancelled", async () => {
		const { store } = await openStore();
		await store.createTask(task("root"));
		await store.createTask(task("child", "project", ["root"]));
		await store.startReadyTasks("project");

		await store.transitionTask("root", "cancelled");

		expect(await store.getTask("child")).toMatchObject({
			status: "failed",
			blockedReason: "Blocked because prerequisite root ended as cancelled.",
		});
	});

	it("reconciles a queued dependent task when reopening legacy failed task state", async () => {
		const { store, path } = await openStore();
		await store.createTask(task("root"));
		await store.createTask(task("child", "project", ["root"]));
		await store.close();
		stores.delete(store);

		const db = await openNodeSqliteDatabase(path);
		try {
			const row = await db.get<{ record: string }>("SELECT record FROM desktop_team_tasks WHERE id = ?", "root");
			expect(row).toBeDefined();
			const record = JSON.parse(row!.record) as Record<string, unknown>;
			record.status = "failed";
			await db.run(
				"UPDATE desktop_team_tasks SET status = 'failed', record = ? WHERE id = ?",
				JSON.stringify(record),
				"root",
			);
		} finally {
			await db.close();
		}

		const reopened = await TeamTaskStore.open(path);
		stores.add(reopened);
		expect(await reopened.getTask("child")).toMatchObject({
			status: "failed",
			blockedReason: "Blocked because prerequisite root ended as failed.",
		});
	});

	it("allows explicit recovery from review while preserving the four task limit", async () => {
		const { store } = await openStore();
		for (let index = 0; index < 5; index++) await store.createTask(task(`resume-${index}`));
		await store.createTask(task("recovered", "project"));
		await store.startReadyTasks("project");
		await store.transitionTask("resume-0", "review");
		await store.startReadyTasks("project");
		expect((await store.snapshot("project")).tasks.filter((item) => item.status === "running")).toHaveLength(4);
		await expect(store.transitionTask("resume-0", "running")).rejects.toMatchObject({ code: "CONCURRENCY_LIMIT" });

		await store.transitionTask("resume-1", "completed");
		expect((await store.transitionTask("resume-0", "running")).status).toBe("running");
	});
});
