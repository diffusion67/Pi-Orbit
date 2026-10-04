import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";
import { ProjectRegistry } from "../../src/main/project-registry.ts";

describe("ProjectRegistry", () => {
	it("persists archive state, clears active selection, restores selection, and ignores stale archive values", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-session-archive-"));
		const database = join(directory, "app.sqlite");
		let db = await openNodeSqliteDatabase(database);
		try {
			let registry = await ProjectRegistry.open(db);
			const project = await registry.openProject(directory);
			const session = {
				id: "session",
				projectId: project.id,
				file: join(directory, "session.jsonl"),
				title: "Conversation",
				updatedAt: new Date().toISOString(),
				model: "provider/model",
				status: "idle" as const,
			};
			await registry.upsertSession(session);
			await registry.selectSession(session.id);
			await registry.setSessionArchived(session.id, true);
			expect(await registry.getActiveSessionId()).toBeUndefined();
			expect((await registry.getSession(session.id))?.archived).toBe(true);

			await registry.upsertSession({ ...session, status: "error" });
			expect((await registry.getSession(session.id))?.archived).toBe(true);
			await db.close();
			db = await openNodeSqliteDatabase(database);
			registry = await ProjectRegistry.open(db);
			expect((await registry.listSessions(project.id))[0]?.archived).toBe(true);
			await expect(registry.selectSession(session.id)).rejects.toThrow(/archived session must be restored/);
			await registry.setSessionArchived(session.id, false);
			expect((await registry.getSession(session.id))?.archived).toBe(false);
			await registry.selectSession(session.id);
			expect(await registry.getActiveSessionId()).toBe(session.id);
		} finally {
			await db.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("migrates an existing session table without the archived column", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-session-migration-"));
		const db = await openNodeSqliteDatabase(join(directory, "app.sqlite"));
		try {
			await db.exec(`CREATE TABLE desktop_projects (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				path TEXT NOT NULL UNIQUE
			) STRICT`);
			await db.exec(`CREATE TABLE desktop_sessions (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES desktop_projects(id),
				file TEXT NOT NULL UNIQUE,
				title TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				model TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('idle','running','error'))
			) STRICT`);
			await db.run(
				"INSERT INTO desktop_projects (id, name, path) VALUES (?, ?, ?)",
				"project",
				"Project",
				directory,
			);
			await db.run(
				"INSERT INTO desktop_sessions (id, project_id, file, title, updated_at, model, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
				"session",
				"project",
				join(directory, "session.jsonl"),
				"Conversation",
				new Date().toISOString(),
				"",
				"idle",
			);

			const registry = await ProjectRegistry.open(db);

			expect((await registry.getSession("session"))?.archived).toBe(false);
			await registry.setSessionArchived("session", true);
			expect((await registry.getSession("session"))?.archived).toBe(true);
		} finally {
			await db.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects archiving a running session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-session-running-archive-"));
		const db = await openNodeSqliteDatabase(join(directory, "app.sqlite"));
		try {
			const registry = await ProjectRegistry.open(db);
			const project = await registry.openProject(directory);
			await registry.upsertSession({
				id: "running-session",
				projectId: project.id,
				file: join(directory, "session.jsonl"),
				title: "Running",
				updatedAt: new Date().toISOString(),
				model: "",
				status: "running",
			});

			await expect(registry.setSessionArchived("running-session", true)).rejects.toThrow(
				/running session cannot be archived/,
			);
			expect((await registry.getSession("running-session"))?.archived).toBe(false);
		} finally {
			await db.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("ignores a stale worker status update after a session is archived", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-session-archive-status-"));
		const db = await openNodeSqliteDatabase(join(directory, "app.sqlite"));
		try {
			const registry = await ProjectRegistry.open(db);
			const project = await registry.openProject(directory);
			await registry.upsertSession({
				id: "archived-session",
				projectId: project.id,
				file: join(directory, "session.jsonl"),
				title: "Archived",
				updatedAt: new Date().toISOString(),
				model: "",
				status: "idle",
			});

			await registry.setSessionArchived("archived-session", true);
			await registry.setSessionStatus("archived-session", "error");

			expect(await registry.getSession("archived-session")).toMatchObject({
				status: "idle",
				archived: true,
			});
		} finally {
			await db.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("persists a renamed session and protects its title from stale worker updates", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-session-name-"));
		const database = join(directory, "app.sqlite");
		let db = await openNodeSqliteDatabase(database);
		try {
			let registry = await ProjectRegistry.open(db);
			const project = await registry.openProject(directory);
			const stale = {
				id: "session",
				projectId: project.id,
				file: join(directory, "session.jsonl"),
				title: "New session",
				updatedAt: new Date().toISOString(),
				model: "",
				status: "idle" as const,
			};
			await registry.upsertSession(stale);
			await registry.renameSession("session", "Release notes");
			await registry.upsertSession({ ...stale, status: "running" });
			expect((await registry.getSession("session"))?.title).toBe("Release notes");
			await db.close();
			db = await openNodeSqliteDatabase(database);
			registry = await ProjectRegistry.open(db);
			expect((await registry.listSessions(project.id))[0]?.title).toBe("Release notes");
		} finally {
			await db.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

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
