import type { DesktopSessionQueue } from "./contract.ts";

export function filterSessionArchiveState<T extends { archived: boolean }>(sessions: readonly T[], showArchived: boolean): T[] {
	return sessions.filter((session) => session.archived === showArchived);
}

export function queuedMessagesForDraft(queue: DesktopSessionQueue): string {
	return [...queue.steering, ...queue.followUp].filter(Boolean).join("\n\n");
}

export function queuePreviewIsTruncated(queue: DesktopSessionQueue): boolean {
	return queue.truncated === true;
}
