import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

export type TeamTaskStatus =
	| "queued"
	| "running"
	| "paused"
	| "review"
	| "completed"
	| "failed"
	| "cancelled"
	| "merged";

export type TeamTaskRecord = {
	readonly id: string;
	readonly projectId: string;
	readonly parentTaskId: string | null;
	readonly roleId: string;
	readonly prompt: string;
	readonly dependsOn: readonly string[];
	readonly status: TeamTaskStatus;
	readonly blockedReason?: string;
	readonly baseCommit: string | null;
	readonly worktreePath: string | null;
	readonly sessionFile: string | null;
	readonly lastSettledEntryId: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type NewTeamTask = Pick<
	TeamTaskRecord,
	"id" | "projectId" | "parentTaskId" | "roleId" | "prompt" | "dependsOn"
> &
	Partial<Pick<TeamTaskRecord, "baseCommit" | "worktreePath" | "sessionFile" | "lastSettledEntryId">>;

export type TeamTaskEvent = {
	readonly seq: number;
	readonly taskId: string;
	readonly projectId: string;
	readonly type: "created" | "status.changed" | "updated";
	readonly at: number;
	readonly task: TeamTaskRecord;
	readonly previousStatus?: TeamTaskStatus;
};

export type TeamTaskSnapshot = {
	readonly tasks: readonly TeamTaskRecord[];
	readonly eventSeq: number;
};

export type TeamTaskPatch = Partial<
	Pick<TeamTaskRecord, "baseCommit" | "worktreePath" | "sessionFile" | "lastSettledEntryId">
>;

export type TeamTaskStoreOptions = { readonly now?: () => number };

type TaskRow = { readonly record: string };
type EventRow = { readonly seq: number; readonly record: string };
type SeqRow = { readonly seq: number };

const statuses = new Set<TeamTaskStatus>([
	"queued",
	"running",
	"paused",
	"review",
	"completed",
	"failed",
	"cancelled",
	"merged",
]);

const succeeded = new Set<TeamTaskStatus>(["completed", "merged"]);
const transitions: Readonly<Record<TeamTaskStatus, ReadonlySet<TeamTaskStatus>>> = {
	queued: new Set(["running", "cancelled", "failed"]),
	running: new Set(["paused", "review", "completed", "failed", "cancelled"]),
	paused: new Set(["running", "cancelled"]),
	review: new Set(["running", "completed", "failed", "cancelled", "merged"]),
	completed: new Set(["merged"]),
	failed: new Set(),
	cancelled: new Set(),
	merged: new Set(),
};

export type TeamTaskErrorCode =
	| "TASK_EXISTS"
	| "TASK_NOT_FOUND"
	| "CROSS_PROJECT_DEPENDENCY"
	| "DEPENDENCY_CYCLE"
	| "INVALID_TRANSITION"
	| "CONCURRENCY_LIMIT";

export class TeamTaskError extends Error {
	readonly code: TeamTaskErrorCode;

	constructor(code: TeamTaskErrorCode, message: string) {
		super(message);
		this.name = "TeamTaskError";
		this.code = code;
	}
}

/**
 * Durable task/event store for the desktop main process. Keep one instance as the
 * sole writer for its database; every mutation commits the task row and event together.
 */
export class TeamTaskStore {
	private readonly db: SqliteDatabase;
	private readonly now: () => number;
	private closed = false;

	private constructor(db: SqliteDatabase, options: TeamTaskStoreOptions) {
		this.db = db;
		this.now = options.now ?? Date.now;
	}

	static async open(path: string, options: TeamTaskStoreOptions = {}): Promise<TeamTaskStore> {
		const db = await openNodeSqliteDatabase(path);
		return TeamTaskStore.openDatabase(db, options);
	}

	static async openDatabase(db: SqliteDatabase, options: TeamTaskStoreOptions = {}): Promise<TeamTaskStore> {
		const store = new TeamTaskStore(db, options);
		try {
			await db.transaction(async (tx) => {
				await tx.exec(`CREATE TABLE IF NOT EXISTS desktop_team_tasks (
					id TEXT PRIMARY KEY,
					project_id TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('queued','running','paused','review','completed','failed','cancelled','merged')),
					record TEXT NOT NULL CHECK (json_valid(record))
				) STRICT`);
				await tx.exec(
					"CREATE INDEX IF NOT EXISTS desktop_team_tasks_by_project_status ON desktop_team_tasks (project_id, status, id)",
				);
				await tx.exec(`CREATE TABLE IF NOT EXISTS desktop_team_events (
					seq INTEGER PRIMARY KEY AUTOINCREMENT,
					task_id TEXT NOT NULL,
					project_id TEXT NOT NULL,
					record TEXT NOT NULL CHECK (json_valid(record))
				) STRICT`);
				await tx.exec(
					"CREATE INDEX IF NOT EXISTS desktop_team_events_by_project_seq ON desktop_team_events (project_id, seq)",
				);
			});
			await store.recoverRunningTasks();
			await store.blockQueuedTasks();
			return store;
		} catch (error) {
			await db.close();
			throw error;
		}
	}

	async createTask(input: NewTeamTask): Promise<TeamTaskRecord> {
		this.assertOpen();
		return this.db.transaction(async (tx) => {
			if ((await this.readTask(tx, input.id)) !== undefined) {
				throw new TeamTaskError("TASK_EXISTS", `Task ${input.id} already exists`);
			}
			const deps = [...new Set(input.dependsOn)];
			if (deps.length !== input.dependsOn.length) throw new Error("Task dependencies must be unique");
			for (const id of deps) {
				if (id === input.id)
					throw new TeamTaskError("DEPENDENCY_CYCLE", `Task ${input.id} cannot depend on itself`);
				const dependency = await this.readTask(tx, id);
				if (dependency === undefined)
					throw new TeamTaskError("TASK_NOT_FOUND", `Dependency task ${id} does not exist`);
				if (dependency.projectId !== input.projectId) {
					throw new TeamTaskError("CROSS_PROJECT_DEPENDENCY", `Dependency task ${id} belongs to another project`);
				}
			}
			const timestamp = this.now();
			const task: TeamTaskRecord = {
				...input,
				dependsOn: deps,
				status: "queued",
				baseCommit: input.baseCommit ?? null,
				worktreePath: input.worktreePath ?? null,
				sessionFile: input.sessionFile ?? null,
				lastSettledEntryId: input.lastSettledEntryId ?? null,
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			await this.assertNoCycle(tx, task);
			await this.writeTask(tx, task);
			await this.writeEvent(tx, task, "created");
			await this.blockQueuedTasksInTransaction(tx, input.projectId);
			return (await this.readTask(tx, input.id)) ?? task;
		});
	}

	async transitionTask(id: string, status: TeamTaskStatus, patch: TeamTaskPatch = {}): Promise<TeamTaskRecord> {
		this.assertOpen();
		if (!statuses.has(status)) throw new Error(`Unknown task status: ${status}`);
		return this.db.transaction(async (tx) => {
			const current = await this.readTask(tx, id);
			if (current === undefined) throw new TeamTaskError("TASK_NOT_FOUND", `Task ${id} does not exist`);
			if (!transitions[current.status].has(status)) {
				throw new TeamTaskError(
					"INVALID_TRANSITION",
					`Cannot change task ${id} from ${current.status} to ${status}`,
				);
			}
			if (status === "running" && (current.status === "paused" || current.status === "review")) {
				if (!(await this.dependenciesSucceeded(tx, current))) {
					throw new Error(`Task ${id} cannot resume before its dependencies complete`);
				}
				const runningCount = (await this.readProjectTasks(tx, current.projectId)).filter(
					(task) => task.status === "running",
				).length;
				if (runningCount >= 4) {
					throw new TeamTaskError(
						"CONCURRENCY_LIMIT",
						`Project ${current.projectId} already has four running tasks`,
					);
				}
			}
			const task = { ...current, ...patch, status, updatedAt: this.now() };
			await this.writeTask(tx, task);
			await this.writeEvent(tx, task, "status.changed", current.status);
			if (status === "failed" || status === "cancelled")
				await this.blockQueuedTasksInTransaction(tx, current.projectId);
			return task;
		});
	}

	async updateTask(id: string, patch: TeamTaskPatch): Promise<TeamTaskRecord> {
		this.assertOpen();
		return this.db.transaction(async (tx) => {
			const current = await this.readTask(tx, id);
			if (current === undefined) throw new TeamTaskError("TASK_NOT_FOUND", `Task ${id} does not exist`);
			const task = { ...current, ...patch, updatedAt: this.now() };
			await this.writeTask(tx, task);
			await this.writeEvent(tx, task, "updated");
			return task;
		});
	}

	/** Persist queued tasks as running up to the per-project limit. Dependencies must have succeeded. */
	async startReadyTasks(projectId: string, limit = 4): Promise<readonly TeamTaskRecord[]> {
		this.assertOpen();
		if (!Number.isInteger(limit) || limit < 1)
			throw new RangeError("Task concurrency limit must be a positive integer");
		return this.db.transaction(async (tx) => {
			const tasks = await this.readProjectTasks(tx, projectId);
			let available = Math.max(0, limit - tasks.filter((task) => task.status === "running").length);
			const started: TeamTaskRecord[] = [];
			for (const current of tasks) {
				if (available === 0) break;
				if (current.status !== "queued" || !(await this.dependenciesSucceeded(tx, current))) continue;
				const task: TeamTaskRecord = { ...current, status: "running", updatedAt: this.now() };
				await this.writeTask(tx, task);
				await this.writeEvent(tx, task, "status.changed", current.status);
				started.push(task);
				available--;
			}
			return started;
		});
	}

	async getTask(id: string): Promise<TeamTaskRecord | undefined> {
		this.assertOpen();
		return this.readTask(this.db, id);
	}

	async snapshot(projectId?: string): Promise<TeamTaskSnapshot> {
		this.assertOpen();
		return this.db.transaction(async (tx) => {
			const tasks =
				projectId === undefined ? await this.readAllTasks(tx) : await this.readProjectTasks(tx, projectId);
			const row =
				projectId === undefined
					? await tx.get<SeqRow>("SELECT COALESCE(MAX(seq), 0) AS seq FROM desktop_team_events")
					: await tx.get<SeqRow>(
							"SELECT COALESCE(MAX(seq), 0) AS seq FROM desktop_team_events WHERE project_id = ?",
							projectId,
						);
			return { tasks, eventSeq: row?.seq ?? 0 };
		});
	}

	async eventsSince(sequence: number, projectId?: string): Promise<readonly TeamTaskEvent[]> {
		this.assertOpen();
		if (!Number.isSafeInteger(sequence) || sequence < 0)
			throw new RangeError("Event sequence must be a non-negative safe integer");
		const rows =
			projectId === undefined
				? await this.db.all<EventRow>(
						"SELECT seq, record FROM desktop_team_events WHERE seq > ? ORDER BY seq",
						sequence,
					)
				: await this.db.all<EventRow>(
						"SELECT seq, record FROM desktop_team_events WHERE seq > ? AND project_id = ? ORDER BY seq",
						sequence,
						projectId,
					);
		return rows.map((row) => JSON.parse(row.record) as TeamTaskEvent);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.db.close();
	}

	private async recoverRunningTasks(): Promise<void> {
		await this.db.transaction(async (tx) => {
			for (const task of await this.readAllTasks(tx)) {
				if (task.status !== "running") continue;
				const recovered: TeamTaskRecord = { ...task, status: "review", updatedAt: this.now() };
				await this.writeTask(tx, recovered);
				await this.writeEvent(tx, recovered, "status.changed", "running");
			}
		});
	}

	private async blockQueuedTasks(projectId?: string): Promise<void> {
		this.assertOpen();
		await this.db.transaction((tx) => this.blockQueuedTasksInTransaction(tx, projectId));
	}

	private async blockQueuedTasksInTransaction(tx: SqliteExecutor, projectId?: string): Promise<void> {
		let changed: boolean;
		do {
			changed = false;
			const tasks =
				projectId === undefined ? await this.readAllTasks(tx) : await this.readProjectTasks(tx, projectId);
			for (const current of tasks) {
				if (current.status !== "queued") continue;
				const dependencies = await Promise.all(current.dependsOn.map((id) => this.readTask(tx, id)));
				const dependency = dependencies.find((item) => item?.status === "failed" || item?.status === "cancelled");
				if (!dependency) continue;
				const blockedReason = `Blocked because prerequisite ${dependency.id} ended as ${dependency.status}.`;
				const blocked: TeamTaskRecord = {
					...current,
					status: "failed",
					blockedReason,
					updatedAt: this.now(),
				};
				await this.writeTask(tx, blocked);
				await this.writeEvent(tx, blocked, "status.changed", current.status);
				changed = true;
			}
		} while (changed);
	}

	private async assertNoCycle(tx: SqliteExecutor, candidate: TeamTaskRecord): Promise<void> {
		const visited = new Set<string>();
		const visit = async (id: string): Promise<void> => {
			if (id === candidate.id)
				throw new TeamTaskError("DEPENDENCY_CYCLE", `Task ${candidate.id} would create a dependency cycle`);
			if (visited.has(id)) return;
			visited.add(id);
			const dependency = await this.readTask(tx, id);
			if (dependency !== undefined) for (const nested of dependency.dependsOn) await visit(nested);
		};
		for (const id of candidate.dependsOn) await visit(id);
	}

	private async dependenciesSucceeded(tx: SqliteExecutor, task: TeamTaskRecord): Promise<boolean> {
		for (const id of task.dependsOn) {
			const dependency = await this.readTask(tx, id);
			if (dependency === undefined || !succeeded.has(dependency.status)) return false;
		}
		return true;
	}

	private async readTask(executor: SqliteExecutor, id: string): Promise<TeamTaskRecord | undefined> {
		const row = await executor.get<TaskRow>("SELECT record FROM desktop_team_tasks WHERE id = ?", id);
		return row === undefined ? undefined : (JSON.parse(row.record) as TeamTaskRecord);
	}

	private async readProjectTasks(executor: SqliteExecutor, projectId: string): Promise<TeamTaskRecord[]> {
		return (
			await executor.all<TaskRow>(
				"SELECT record FROM desktop_team_tasks WHERE project_id = ? ORDER BY rowid",
				projectId,
			)
		).map((row) => JSON.parse(row.record) as TeamTaskRecord);
	}

	private async readAllTasks(executor: SqliteExecutor): Promise<TeamTaskRecord[]> {
		return (await executor.all<TaskRow>("SELECT record FROM desktop_team_tasks ORDER BY rowid")).map(
			(row) => JSON.parse(row.record) as TeamTaskRecord,
		);
	}

	private async writeTask(executor: SqliteExecutor, task: TeamTaskRecord): Promise<void> {
		await executor.run(
			`INSERT INTO desktop_team_tasks (id, project_id, status, record) VALUES (?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, status = excluded.status, record = excluded.record`,
			task.id,
			task.projectId,
			task.status,
			JSON.stringify(task),
		);
	}

	private async writeEvent(
		executor: SqliteExecutor,
		task: TeamTaskRecord,
		type: TeamTaskEvent["type"],
		previousStatus?: TeamTaskStatus,
	): Promise<void> {
		const row = await executor.get<SeqRow>(
			"INSERT INTO desktop_team_events (task_id, project_id, record) VALUES (?, ?, '{}') RETURNING seq",
			task.id,
			task.projectId,
		);
		if (row === undefined) throw new Error("Failed to allocate task event sequence");
		const event: TeamTaskEvent = {
			seq: row.seq,
			taskId: task.id,
			projectId: task.projectId,
			type,
			at: this.now(),
			task,
			...(previousStatus === undefined ? {} : { previousStatus }),
		};
		await executor.run("UPDATE desktop_team_events SET record = ? WHERE seq = ?", JSON.stringify(event), row.seq);
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("TeamTaskStore is closed");
	}
}
