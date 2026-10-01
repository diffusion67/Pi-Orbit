import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";

export type StoredAppEvent = {
	readonly seq: number;
	readonly kind:
		| "state"
		| "team"
		| "message"
		| "diagnostic"
		| "extension.request"
		| "extension.dismiss"
		| "extension.update"
		| "mcp.status"
		| "terminal.output";
	readonly payload: unknown;
};

type EventRow = { readonly seq: number; readonly kind: StoredAppEvent["kind"]; readonly payload: string };
type SeqRow = { readonly seq: number };

/** The Electron main process alone writes this log and publishes committed rows. */
export class AppEventLog {
	private readonly db: SqliteDatabase;

	private constructor(db: SqliteDatabase) {
		this.db = db;
	}

	static async open(db: SqliteDatabase): Promise<AppEventLog> {
		const log = new AppEventLog(db);
		await db.transaction(async (tx) => {
			await tx.exec(`CREATE TABLE IF NOT EXISTS desktop_app_events (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			kind TEXT NOT NULL,
			payload TEXT NOT NULL CHECK (json_valid(payload))
		) STRICT`);
			// TeamTaskStore updates the event record in the same transaction as its task.
			// The trigger copies the settled record to the app-wide replay stream.
			await tx.exec(`CREATE TRIGGER IF NOT EXISTS desktop_team_event_publish
			AFTER UPDATE OF record ON desktop_team_events
			BEGIN
				INSERT INTO desktop_app_events (kind, payload) VALUES ('team', NEW.record);
			END`);
		});
		return log;
	}

	async append(kind: Exclude<StoredAppEvent["kind"], "team">, payload: unknown): Promise<StoredAppEvent> {
		const encoded = JSON.stringify(payload);
		if (encoded === undefined) throw new TypeError("App event payload must be serializable");
		const row = await this.db.get<SeqRow>(
			"INSERT INTO desktop_app_events (kind, payload) VALUES (?, ?) RETURNING seq",
			kind,
			encoded,
		);
		if (row === undefined) throw new Error("Could not allocate desktop event sequence");
		return { seq: row.seq, kind, payload };
	}

	async latestSequence(): Promise<number> {
		return (await this.db.get<SeqRow>("SELECT COALESCE(MAX(seq), 0) AS seq FROM desktop_app_events"))?.seq ?? 0;
	}

	async eventsSince(sequence: number): Promise<readonly StoredAppEvent[]> {
		if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError("Invalid app event sequence");
		return (
			await this.db.all<EventRow>(
				"SELECT seq, kind, payload FROM desktop_app_events WHERE seq > ? ORDER BY seq",
				sequence,
			)
		).map((row) => ({ seq: row.seq, kind: row.kind, payload: JSON.parse(row.payload) as unknown }));
	}
}
