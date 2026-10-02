import type { TaskStatus } from "./contract.ts";

export function canResumeTask(status: TaskStatus): boolean {
	return status === "paused" || status === "review";
}
