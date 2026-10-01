import { type DesktopAttachment, validateAttachments } from "./attachments.ts";

type DraftStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};
export type PendingSend = {
	readonly sessionId: string;
	readonly text: string;
	readonly revision: number;
	readonly attachments: readonly DesktopAttachment[];
};
type ComposerState = { text: string; revision: number; attachments: DesktopAttachment[]; pending?: PendingSend };
const maxDraftLength = 100_000;

/** Text stays in the local application profile; attachments and in-flight sends stay in memory. */
export class SessionComposer {
	private readonly storage: DraftStorage;
	private readonly sessions = new Map<string, ComposerState>();
	persistenceFailed = false;

	constructor(storage: DraftStorage) {
		this.storage = storage;
	}

	private state(sessionId: string): ComposerState {
		let state = this.sessions.get(sessionId);
		if (state) return state;
		let text = "";
		try {
			const saved = this.storage.getItem(`pi-orbit:draft:${sessionId}`);
			if (saved !== null && saved.length <= maxDraftLength) text = saved;
			else if (saved !== null) this.persistenceFailed = true;
		} catch {
			this.persistenceFailed = true;
		}
		state = { text, revision: 0, attachments: [] };
		this.sessions.set(sessionId, state);
		return state;
	}

	get(sessionId: string): {
		readonly text: string;
		readonly attachments: readonly DesktopAttachment[];
		readonly sending: boolean;
	} {
		const state = this.state(sessionId);
		return { text: state.text, attachments: state.attachments, sending: state.pending !== undefined };
	}

	setText(sessionId: string, text: string): void {
		if (text.length > maxDraftLength) throw new Error("Drafts must be under 100,000 characters.");
		const state = this.state(sessionId);
		state.text = text;
		state.revision++;
		try {
			if (text) this.storage.setItem(`pi-orbit:draft:${sessionId}`, text);
			else this.storage.removeItem(`pi-orbit:draft:${sessionId}`);
		} catch {
			this.persistenceFailed = true;
		}
	}

	addAttachments(sessionId: string, attachments: readonly DesktopAttachment[]): void {
		const state = this.state(sessionId);
		const next = [...state.attachments, ...attachments];
		validateAttachments(next);
		state.attachments = next;
	}

	removeAttachment(sessionId: string, index: number): void {
		const state = this.state(sessionId);
		state.attachments = state.attachments.filter((_, current) => current !== index);
	}

	beginSend(sessionId: string): PendingSend | undefined {
		const state = this.state(sessionId);
		if (state.pending || (!state.text.trim() && state.attachments.length === 0)) return undefined;
		const pending = { sessionId, text: state.text, revision: state.revision, attachments: [...state.attachments] };
		state.pending = pending;
		return pending;
	}

	finishSend(pending: PendingSend, success: boolean): void {
		const state = this.state(pending.sessionId);
		if (state.pending !== pending) return;
		if (success) {
			if (state.revision === pending.revision) this.setText(pending.sessionId, "");
			state.attachments = state.attachments.filter((attachment) => !pending.attachments.includes(attachment));
		}
		state.pending = undefined;
	}
}

export function filterProjectSessions<T extends { projectId: string; title: string }>(
	sessions: readonly T[],
	projectId: string | undefined,
	query: string,
): T[] {
	const search = query.trim().toLocaleLowerCase();
	return sessions.filter(
		(session) => session.projectId === projectId && session.title.toLocaleLowerCase().includes(search),
	);
}

export function shouldSendKey(
	event: {
		key: string;
		shiftKey: boolean;
		ctrlKey: boolean;
		metaKey: boolean;
		altKey: boolean;
		isComposing: boolean;
		keyCode: number;
	},
	shortcut: "enter" | "ctrlEnter",
): boolean {
	if (event.isComposing || event.keyCode === 229 || event.key !== "Enter" || event.shiftKey || event.altKey)
		return false;
	return shortcut === "enter" ? !event.ctrlKey && !event.metaKey : event.ctrlKey || event.metaKey;
}
