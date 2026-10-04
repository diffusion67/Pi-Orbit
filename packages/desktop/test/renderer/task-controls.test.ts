import { describe, expect, it } from "vitest";
import type { TaskStatus } from "../../renderer/src/contract.ts";
import {
	canApplySnapshot,
	canResumeTask,
	matchesSessionSelection,
	shouldAutoScrollTranscript,
	taskReplyAfterSend,
} from "../../renderer/src/task-controls.ts";

describe("task resume control", () => {
	it.each(["paused", "review"] satisfies TaskStatus[])("offers Resume for a %s task", (status) => {
		expect(canResumeTask(status)).toBe(true);
		expect(canResumeTask(status, false)).toBe(false);
	});

	it.each(["queued", "running", "completed", "failed", "cancelled", "merged"] satisfies TaskStatus[])(
		"does not offer Resume for a %s task",
		(status) => {
			expect(canResumeTask(status)).toBe(false);
		},
	);
});

describe("transcript scrolling", () => {
	it("sticks to the bottom only when the reader is already near it", () => {
		expect(shouldAutoScrollTranscript(700, 300, 1000)).toBe(true);
		expect(shouldAutoScrollTranscript(100, 300, 1000)).toBe(false);
		expect(shouldAutoScrollTranscript(652, 300, 1000)).toBe(true);
	});
});

describe("task reply drafts", () => {
	it("clears a draft only after the unchanged submission succeeds", () => {
		expect(taskReplyAfterSend("Please continue", "Please continue", true, true)).toBe("");
		expect(taskReplyAfterSend(" Please continue ", " Please continue ", true, true)).toBe("");
		expect(taskReplyAfterSend("Please continue", "Please continue", false, true)).toBe("Please continue");
		expect(taskReplyAfterSend("New text", "Please continue", true, true)).toBe("New text");
		expect(taskReplyAfterSend("Please continue", "Please continue", true, false)).toBe("Please continue");
	});
});

describe("asynchronous snapshot updates", () => {
	it("rejects snapshots older than current state or a received event", () => {
		expect(canApplySnapshot(12, 11, 12)).toBe(true);
		expect(canApplySnapshot(10, 11, 9)).toBe(false);
		expect(canApplySnapshot(11, 9, 12)).toBe(false);
	});

	it("accepts only the latest selection when its snapshot names that session", () => {
		expect(matchesSessionSelection(3, 3, "session-c", "session-c")).toBe(true);
		expect(matchesSessionSelection(2, 3, "session-b", "session-b")).toBe(false);
		expect(matchesSessionSelection(3, 3, "session-a", "session-c")).toBe(false);
	});
});
