import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";

export type StoredProject = { readonly id: string; readonly name: string; readonly path: string };
export type StoredSession = {
	readonly id: string;
	readonly projectId: string;
	readonly file: string;
	readonly title: string;
	readonly updatedAt: string;
	readonly model: string;
	readonly status: "idle" | "running" | "error";
};

type ProjectRow = { readonly id: string; readonly name: string; readonly path: string };
type SessionRow = {
	readonly id: string;
	readonly project_id: string;
	readonly file: string;
	readonly title: string;
	readonly updated_at: string;
	readonly model: string;
	readonly status: StoredSession["status"];
};
type MetaRow = { readonly value: string };

function fromSessionRow(row: SessionRow): StoredSession {
	return {
		id: row.id,
		projectId: row.project_id,
		file: row.file,
		title: row.title,
		updatedAt: row.updated_at,
		model: row.model,
		status: row.status,
	};
}

/** One main-process writer for project and Pi session metadata. */
export class ProjectRegistry {
	private readonly db: SqliteDatabase;

	private constructor(db: SqliteDatabase) {
		this.db = db;
	}

	static async open(db: SqliteDatabase): Promise<ProjectRegistry> {
		const registry = new ProjectRegistry(db);
		await db.transaction(async (tx) => {
			await tx.exec(`CREATE TABLE IF NOT EXISTS desktop_projects (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			path TEXT NOT NULL UNIQUE
		) STRICT`);
			await tx.exec(`CREATE TABLE IF NOT EXISTS desktop_sessions (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL REFERENCES desktop_projects(id),
			file TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			model TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('idle','running','error'))
		) STRICT`);
			await tx.exec(
				"CREATE INDEX IF NOT EXISTS desktop_sessions_by_project ON desktop_sessions (project_id, updated_at)",
			);
			await tx.exec("CREATE TABLE IF NOT EXISTS desktop_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
			// An interrupted session is selectable; the user decides whether to resume.
			await tx.run("UPDATE desktop_sessions SET status = 'error' WHERE status = 'running'");
		});
		return registry;
	}

	async openProject(path: string): Promise<StoredProject> {
		const canonical = await realpath(resolve(path));
		if (!(await stat(canonical)).isDirectory()) throw new TypeError("Project path is not a directory");
		return this.db.transaction(async (tx) => {
			const previousProjectId = await this.getMeta(tx, "activeProjectId");
			const current = await tx.get<ProjectRow>(
				"SELECT id, name, path FROM desktop_projects WHERE path = ?",
				canonical,
			);
			if (current !== undefined) {
				await this.setMeta(tx, "activeProjectId", current.id);
				if (previousProjectId !== current.id) await this.deleteMeta(tx, "activeSessionId");
				return current;
			}
			const project = { id: randomUUID(), name: basename(canonical), path: canonical };
			await tx.run(
				"INSERT INTO desktop_projects (id, name, path) VALUES (?, ?, ?)",
				project.id,
				project.name,
				project.path,
			);
			await this.setMeta(tx, "activeProjectId", project.id);
			await this.deleteMeta(tx, "activeSessionId");
			return project;
		});
	}

	async createProject(path: string, name: string): Promise<StoredProject> {
		const absolute = resolve(path);
		await mkdir(absolute, { recursive: false });
		const project = await this.openProject(absolute);
		await this.db.run("UPDATE desktop_projects SET name = ? WHERE id = ?", name, project.id);
		return { ...project, name };
	}

	listProjects(): Promise<readonly StoredProject[]> {
		return this.db.all<ProjectRow>("SELECT id, name, path FROM desktop_projects ORDER BY name COLLATE NOCASE");
	}

	getProject(id: string): Promise<StoredProject | undefined> {
		return this.db.get<ProjectRow>("SELECT id, name, path FROM desktop_projects WHERE id = ?", id);
	}

	async upsertSession(session: StoredSession): Promise<void> {
		await this.db.run(
			`INSERT INTO desktop_sessions (id, project_id, file, title, updated_at, model, status)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, file=excluded.file,
				title=excluded.title, updated_at=excluded.updated_at, model=excluded.model, status=excluded.status`,
			session.id,
			session.projectId,
			session.file,
			session.title,
			session.updatedAt,
			session.model,
			session.status,
		);
	}

	async getSession(id: string): Promise<StoredSession | undefined> {
		const row = await this.db.get<SessionRow>("SELECT * FROM desktop_sessions WHERE id = ?", id);
		return row === undefined ? undefined : fromSessionRow(row);
	}

	async listSessions(projectId?: string): Promise<readonly StoredSession[]> {
		const rows =
			projectId === undefined
				? await this.db.all<SessionRow>("SELECT * FROM desktop_sessions ORDER BY updated_at DESC")
				: await this.db.all<SessionRow>(
						"SELECT * FROM desktop_sessions WHERE project_id = ? ORDER BY updated_at DESC",
						projectId,
					);
		return rows.map(fromSessionRow);
	}

	async selectSession(id: string): Promise<StoredSession> {
		return this.db.transaction(async (tx) => {
			const row = await tx.get<SessionRow>("SELECT * FROM desktop_sessions WHERE id = ?", id);
			if (row === undefined) throw new Error(`Unknown session ${id}`);
			await this.setMeta(tx, "activeSessionId", id);
			await this.setMeta(tx, "activeProjectId", row.project_id);
			return fromSessionRow(row);
		});
	}

	getActiveProjectId(): Promise<string | undefined> {
		return this.getMeta(this.db, "activeProjectId");
	}
	getActiveSessionId(): Promise<string | undefined> {
		return this.getMeta(this.db, "activeSessionId");
	}

	private async getMeta(executor: SqliteExecutor, key: string): Promise<string | undefined> {
		return (await executor.get<MetaRow>("SELECT value FROM desktop_meta WHERE key = ?", key))?.value;
	}

	private async setMeta(executor: SqliteExecutor, key: string, value: string): Promise<void> {
		await executor.run(
			"INSERT INTO desktop_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			key,
			value,
		);
	}

	private async deleteMeta(executor: SqliteExecutor, key: string): Promise<void> {
		await executor.run("DELETE FROM desktop_meta WHERE key = ?", key);
	}
}
