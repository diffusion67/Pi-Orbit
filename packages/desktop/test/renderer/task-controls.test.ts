import { describe, expect, it } from "vitest";
import type { TaskStatus } from "../../renderer/src/contract.ts";
import { canResumeTask } from "../../renderer/src/task-controls.ts";

describe("task resume control", () => {
	it.each(["paused", "review"] satisfies TaskStatus[])("offers Resume for a %s task", (status) => {
		expect(canResumeTask(status)).toBe(true);
	});

	it.each(["queued", "running", "completed", "failed", "cancelled", "merged"] satisfies TaskStatus[])(
		"does not offer Resume for a %s task",
		(status) => {
			expect(canResumeTask(status)).toBe(false);
		},
	);
});
