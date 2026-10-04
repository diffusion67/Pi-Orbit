import { describe, expect, it } from "vitest";
import {
	filterSessionArchiveState,
	queuedMessagesForDraft,
	queuePreviewIsTruncated,
} from "../../renderer/src/session-view-controls.ts";

describe("session archive list", () => {
	it("shows only active sessions by default and archived sessions on request", () => {
		const sessions = [
			{ id: "active", archived: false },
			{ id: "archived", archived: true },
		];
		expect(filterSessionArchiveState(sessions, false).map((session) => session.id)).toEqual(["active"]);
		expect(filterSessionArchiveState(sessions, true).map((session) => session.id)).toEqual(["archived"]);
	});
});

describe("cleared session queue", () => {
	it("restores steering entries followed by follow-up entries without changing their text", () => {
		expect(
			queuedMessagesForDraft({
				steering: ["Stop and inspect", "Use the project config"],
				followUp: ["Then summarize"],
				pendingCount: 3,
			}),
		).toBe("Stop and inspect\n\nUse the project config\n\nThen summarize");
	});

	it("returns no draft for an empty queue", () => {
		expect(queuedMessagesForDraft({ steering: [], followUp: [], pendingCount: 0 })).toBe("");
	});

	it("reports when the preview omits queued text but not for a complete queue", () => {
		expect(queuePreviewIsTruncated({ steering: ["preview"], followUp: [], pendingCount: 51, truncated: true })).toBe(
			true,
		);
		expect(queuePreviewIsTruncated({ steering: ["all entries"], followUp: [], pendingCount: 1 })).toBe(false);
	});
});
