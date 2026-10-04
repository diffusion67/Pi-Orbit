import type { TaskStatus } from "./contract.ts";

export function canResumeTask(status: TaskStatus, subagentsEnabled = true): boolean {
	return subagentsEnabled && (status === "paused" || status === "review");
}

export function shouldAutoScrollTranscript(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
	return scrollHeight - (scrollTop + clientHeight) <= 48;
}

export function taskReplyAfterSend(currentDraft: string, submittedText: string, accepted: boolean, sameTask: boolean): string {
	return accepted && sameTask && currentDraft === submittedText ? "" : currentDraft;
}

export function canApplySnapshot(incomingSeq: number, currentSeq: number, latestEventSeq: number): boolean {
	return incomingSeq >= currentSeq && incomingSeq >= latestEventSeq;
}

export function matchesSessionSelection(requestId: number, latestRequestId: number, activeSessionId: string | undefined, requestedSessionId: string): boolean {
	return requestId === latestRequestId && activeSessionId === requestedSessionId;
}
