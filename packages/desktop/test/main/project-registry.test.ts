import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";
import { ProjectRegistry } from "../../src/main/project-registry.ts";

describe("ProjectRegistry", () => {
	it("opens a project once and restores session selection without auto-running it", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-project-"));
		const database = join(directory, "app.sqlite");
		let db = await openNodeSqliteDatabase(database);
		try {
			let registry = await ProjectRegistry.open(db);
			const first = await registry.openProject(directory);
			expect((await registry.openProject(directory)).id).toBe(first.id);
			await registry.upsertSession({
				id: "session",
				projectId: first.id,
				file: join(directory, "session.jsonl"),
				title: "Conversation",
				updatedAt: new Date().toISOString(),
				model: "provider/model",
				status: "running",
			});
			await registry.selectSession("session");
			await db.close();
			db = await openNodeSqliteDatabase(database);
			registry = await ProjectRegistry.open(db);
			expect(await registry.getActiveSessionId()).toBe("session");
			expect((await registry.getSession("session"))?.status).toBe("error");
		} finally {
			await db.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("clears the selected session when opening a different project", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-project-switch-"));
		const other = join(directory, "other");
		await mkdir(other);
		const db = await openNodeSqliteDatabase(join(directory, "app.sqlite"));
		try {
			const registry = await ProjectRegistry.open(db);
			const first = await registry.openProject(directory);
			await registry.upsertSession({
				id: "first-session",
				projectId: first.id,
				file: join(directory, "first.jsonl"),
				title: "First",
				updatedAt: new Date().toISOString(),
				model: "",
				status: "idle",
			});
			await registry.selectSession("first-session");
			expect(await registry.getActiveSessionId()).toBe("first-session");
			const second = await registry.openProject(other);
			expect(await registry.getActiveProjectId()).toBe(second.id);
			expect(await registry.getActiveSessionId()).toBeUndefined();
			await registry.selectSession("first-session");
			expect(await registry.getActiveProjectId()).toBe(first.id);
		} finally {
			await db.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
