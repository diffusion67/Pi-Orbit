import { describe, expect, it } from "vitest";
import { filterProjectSessions, SessionComposer, shouldSendKey } from "../../src/shared/session-composer.ts";

function storage() {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
	};
}

describe("session composer", () => {
	it("restores independent text drafts after recreating the composer without persisting attachments", () => {
		const disk = storage();
		const composer = new SessionComposer(disk);
		composer.setText("one", "First draft");
		composer.setText("two", "第二个草稿");
		composer.addAttachments("one", [{ type: "text", name: "private.txt", text: "attachment-only-content" }]);
		expect(composer.get("one").text).toBe("First draft");
		expect(composer.get("two").attachments).toEqual([]);
		const restored = new SessionComposer(disk);
		expect(restored.get("one").text).toBe("First draft");
		expect(restored.get("two").text).toBe("第二个草稿");
		expect(restored.get("one").attachments).toEqual([]);
		expect([...disk.values.values()].join("")).not.toContain("attachment-only-content");
	});

	it("preserves new typing and newly attached files when an earlier send succeeds", () => {
		const composer = new SessionComposer(storage());
		composer.setText("one", "Send this");
		const oldFile = { type: "text" as const, name: "old.txt", text: "old" };
		const newFile = { type: "text" as const, name: "new.txt", text: "new" };
		composer.addAttachments("one", [oldFile]);
		const sent = composer.beginSend("one")!;
		expect(composer.beginSend("one")).toBeUndefined();
		composer.setText("one", "Next message");
		composer.addAttachments("one", [newFile]);
		composer.finishSend(sent, true);
		expect(composer.get("one").text).toBe("Next message");
		expect(composer.get("one").attachments).toEqual([newFile]);
		expect(composer.get("one").sending).toBe(false);
	});

	it("preserves a rewritten identical draft using revisions rather than text equality", () => {
		const composer = new SessionComposer(storage());
		composer.setText("one", "same");
		const sent = composer.beginSend("one")!;
		composer.setText("one", "changed");
		composer.setText("one", "same");
		composer.finishSend(sent, true);
		expect(composer.get("one").text).toBe("same");
	});

	it("retains failed sends, clears only unchanged successful drafts, and isolates sessions", () => {
		const disk = storage();
		const composer = new SessionComposer(disk);
		composer.setText("one", "retry");
		composer.setText("two", "unrelated");
		composer.finishSend(composer.beginSend("one")!, false);
		expect(new SessionComposer(disk).get("one").text).toBe("retry");
		composer.finishSend(composer.beginSend("one")!, true);
		expect(new SessionComposer(disk).get("one").text).toBe("");
		expect(composer.get("two").text).toBe("unrelated");
		expect(composer.beginSend("one")).toBeUndefined();
	});

	it("keeps drafts in memory and reports persistence failures", () => {
		const composer = new SessionComposer({
			getItem: () => {
				throw new Error("unavailable");
			},
			setItem: () => {
				throw new Error("full");
			},
			removeItem: () => {
				throw new Error("unavailable");
			},
		});
		composer.setText("one", "do not lose this");
		expect(composer.get("one").text).toBe("do not lose this");
		expect(composer.persistenceFailed).toBe(true);
	});

	it("rejects oversized drafts and invalid attachment batches without losing the current draft", () => {
		const composer = new SessionComposer(storage());
		composer.setText("one", "keep");
		expect(() => composer.setText("one", "x".repeat(100_001))).toThrow();
		expect(composer.get("one").text).toBe("keep");
		expect(() =>
			composer.addAttachments(
				"one",
				Array.from({ length: 6 }, () => ({ type: "text", name: "a.txt", text: "a" })),
			),
		).toThrow();
		expect(composer.get("one").attachments).toEqual([]);
	});

	it("filters titles case-insensitively within the selected project only", () => {
		const sessions = [
			{ id: "a", projectId: "one", title: "Release Notes" },
			{ id: "b", projectId: "two", title: "Release Notes" },
			{ id: "c", projectId: "one", title: "中文计划" },
		];
		expect(filterProjectSessions(sessions, "one", " RELEASE ").map((s) => s.id)).toEqual(["a"]);
		expect(filterProjectSessions(sessions, "one", "计划").map((s) => s.id)).toEqual(["c"]);
		expect(filterProjectSessions(sessions, undefined, "")).toEqual([]);
	});

	it("never sends while an IME composition is being confirmed", () => {
		const enter = {
			key: "Enter",
			shiftKey: false,
			ctrlKey: false,
			metaKey: false,
			altKey: false,
			isComposing: false,
			keyCode: 13,
		};
		expect(shouldSendKey(enter, "enter")).toBe(true);
		expect(shouldSendKey({ ...enter, isComposing: true }, "enter")).toBe(false);
		expect(shouldSendKey({ ...enter, keyCode: 229 }, "enter")).toBe(false);
		expect(shouldSendKey({ ...enter, ctrlKey: true }, "ctrlEnter")).toBe(true);
		expect(shouldSendKey({ ...enter, shiftKey: true }, "enter")).toBe(false);
	});
});
