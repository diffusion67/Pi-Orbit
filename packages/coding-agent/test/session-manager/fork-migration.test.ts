import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../src/core/session-manager.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-fork-migration-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionManager.forkFrom legacy migrations", () => {
	// PR #5 review: replacing the legacy header before migration loses the entry tree.
	it.each([undefined, 1])("preserves a v1 transcript with header version %s", (version) => {
		const dir = createTempDir();
		const sourcePath = join(dir, "source.jsonl");
		const targetCwd = join(dir, "target");
		const timestamp = "2025-01-01T00:00:00Z";
		const messages = [
			{ role: "user", content: "first message", timestamp: 1 },
			{ role: "user", content: "second message", timestamp: 2 },
		];
		const sourceContent = `${[
			{ type: "session", version, id: "legacy", timestamp, cwd: dir },
			...messages.map((message) => ({ type: "message", timestamp, message })),
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		writeFileSync(sourcePath, sourceContent);

		const fork = SessionManager.forkFrom(sourcePath, targetCwd, dir, { id: "forked" });
		const entries = fork.getEntries();
		expect(fork.buildSessionContext().messages).toEqual(messages);
		expect(fork.getEntryCount()).toBe(2);
		expect(fork.getBranch()).toEqual(entries);
		expect(entries[0].id).toEqual(expect.any(String));
		expect(entries[0].parentId).toBeNull();
		expect(entries[1].id).not.toBe(entries[0].id);
		expect(entries[1].parentId).toBe(entries[0].id);
		expect(fork.getHeader()).toMatchObject({
			version: CURRENT_SESSION_VERSION,
			id: "forked",
			cwd: targetCwd,
			parentSession: sourcePath,
		});

		const reopened = SessionManager.open(fork.getSessionFile()!, dir);
		expect(reopened.getEntries()).toEqual(entries);
		expect(reopened.buildSessionContext().messages).toEqual(messages);
		const continued = { role: "user" as const, content: "continued", timestamp: 3 };
		const continuedId = reopened.appendMessage(continued);
		expect(reopened.getEntry(continuedId)?.parentId).toBe(entries[1].id);
		expect(reopened.buildSessionContext().messages).toEqual([...messages, continued]);
		expect(readFileSync(sourcePath, "utf8")).toBe(sourceContent);
	});

	it("migrates v1 compaction indices while preserving the source", () => {
		const dir = createTempDir();
		const sourcePath = join(dir, "source.jsonl");
		const timestamp = "2025-01-01T00:00:00Z";
		const keptMessage = { role: "user", content: "kept", timestamp: 2 };
		const sourceContent = `${[
			{ type: "session", id: "legacy", timestamp, cwd: dir },
			{ type: "message", timestamp, message: { role: "user", content: "compacted", timestamp: 1 } },
			{ type: "message", timestamp, message: keptMessage },
			{ type: "compaction", timestamp, summary: "summary", firstKeptEntryIndex: 2, tokensBefore: 100 },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		writeFileSync(sourcePath, sourceContent);

		const fork = SessionManager.forkFrom(sourcePath, dir, dir);
		const entries = fork.getEntries();
		expect(entries[2]).toMatchObject({ type: "compaction", firstKeptEntryId: entries[1].id });
		expect(entries[2]).not.toHaveProperty("firstKeptEntryIndex");
		const expectedMessages = [
			{ role: "compactionSummary", summary: "summary", tokensBefore: 100, timestamp: Date.parse(timestamp) },
			keptMessage,
		];
		expect(fork.buildSessionContext().messages).toEqual(expectedMessages);
		expect(SessionManager.open(fork.getSessionFile()!, dir).buildSessionContext().messages).toEqual(expectedMessages);
		expect(readFileSync(sourcePath, "utf8")).toBe(sourceContent);
	});

	it("migrates v2 hook messages without changing existing entry IDs or the source", () => {
		const dir = createTempDir();
		const sourcePath = join(dir, "source.jsonl");
		const timestamp = "2025-01-01T00:00:00Z";
		const message = { role: "hookMessage", customType: "test", content: "from a hook", display: true, timestamp: 1 };
		const sourceContent = `${[
			{ type: "session", version: 2, id: "legacy", timestamp, cwd: dir },
			{ type: "message", id: "entry-1", parentId: null, timestamp, message },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		writeFileSync(sourcePath, sourceContent);

		const fork = SessionManager.forkFrom(sourcePath, dir, dir);
		expect(fork.buildSessionContext().messages).toEqual([{ ...message, role: "custom" }]);
		expect(fork.getEntries()[0]).toMatchObject({ id: "entry-1", parentId: null });
		const reopened = SessionManager.open(fork.getSessionFile()!, dir);
		expect(reopened.getEntries()).toEqual(fork.getEntries());
		expect(reopened.buildSessionContext().messages).toEqual([{ ...message, role: "custom" }]);
		expect(readFileSync(sourcePath, "utf8")).toBe(sourceContent);
	});
});
