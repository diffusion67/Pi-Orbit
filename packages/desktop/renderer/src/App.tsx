import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AppSnapshot, AuthFlowEvent, CatalogEntry, Command, CommandMap, DesktopAttachment, DesktopEvent, DesktopSessionPolicy, DesktopSessionStats, DesktopSessionTree, DesktopThinkingState, ExtensionUiState, McpAuthEvent, Result, Role, Task } from "./contract";
import { createTranslator, type Language, type Translate } from "./i18n";
import { AttachmentBudget, MAX_ATTACHMENT_BYTES } from "../../src/shared/attachments.ts";
import { McpPanel } from "./McpPanel";
import { CustomProviderPanel } from "./CustomProviderPanel";
import { ProjectChangesPanel } from "./ProjectChangesPanel";
import { filterSessionArchiveState, queuePreviewIsTruncated, queuedMessagesForDraft } from "./session-view-controls.ts";
import { SessionComposer, filterProjectSessions, shouldSendKey } from "../../src/shared/session-composer.ts";
import { appendTerminalOutput, terminalOutputDelta } from "../../src/shared/terminal-output.ts";
import { extensionRequestQueue } from "./extension-request-queue.ts";
import { canApplySnapshot, canResumeTask, matchesSessionSelection, shouldAutoScrollTranscript, taskReplyAfterSend } from "./task-controls.ts";

type CatalogKind = "skills" | "templates" | "commands" | "extensions";
type Modal = "settings" | "roles" | "catalog" | "mcp" | "new-task" | "open-project" | "terminal" | "session-details" | null;
const emptySnapshot: AppSnapshot = {
	lastEventSeq: 0,
	projects: [],
	sessions: [],
	sessionQueues: {},
	messages: [],
	tasks: [],
	roles: [],
	catalog: { skills: [], templates: [], commands: [], extensions: [] },
	providers: [],
	mcpServers: [],
	extensionUi: {},
	settings: { theme: "system", defaultModel: "", confirmToolCalls: true, language: "en", sendShortcut: "enter", subagentsEnabled: false, maxParallelTasks: 4 },
	features: { terminal: false, desktopExtensions: false },
	capabilities: {},
};

const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const textFileExtensions = new Set([
	".txt", ".md", ".markdown", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".csv", ".tsv", ".log",
	".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".xml", ".py", ".rs", ".go", ".java", ".c", ".h",
	".cpp", ".hpp", ".cs", ".php", ".rb", ".sh", ".sql", ".env", ".diff", ".patch", ".ini", ".conf",
]);
type SessionPolicyState = { sessionId: string; policy: DesktopSessionPolicy };

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

function attachmentSize(attachment: DesktopAttachment): number {
	return attachment.type === "text"
		? new TextEncoder().encode(attachment.text).byteLength
		: Math.floor((attachment.data.length * 3) / 4) - (attachment.data.endsWith("==") ? 2 : attachment.data.endsWith("=") ? 1 : 0);
}

function formatFileSize(bytes: number): string {
	return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function App() {
	const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot);
	const [languagePreview, setLanguagePreview] = useState<Language>(emptySnapshot.settings.language);
	const [themePreview, setThemePreview] = useState<AppSnapshot["settings"]["theme"]>(emptySnapshot.settings.theme);
	const [shortcutPreview, setShortcutPreview] = useState<"enter" | "ctrlEnter">(emptySnapshot.settings.sendShortcut);
	const t = useMemo(() => createTranslator(languagePreview), [languagePreview]);
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [modal, setModal] = useState<Modal>(null);
	const [catalogKind, setCatalogKind] = useState<CatalogKind>("skills");
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [taskDetailOpen, setTaskDetailOpen] = useState(true);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [composer] = useState(() => new SessionComposer({
		getItem: (key) => window.localStorage.getItem(key),
		setItem: (key, value) => window.localStorage.setItem(key, value),
		removeItem: (key) => window.localStorage.removeItem(key),
	}));
	const [, renderComposer] = useState(0);
	const [sessionSearch, setSessionSearch] = useState("");
	const [showArchivedSessions, setShowArchivedSessions] = useState(false);
	const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null);
	const [projectChangesOpen, setProjectChangesOpen] = useState(false);
	const [sessionPolicy, setSessionPolicy] = useState<SessionPolicyState>();
	const [policySaving, setPolicySaving] = useState(false);
	const [queueClearing, setQueueClearing] = useState(false);
	const [renameTarget, setRenameTarget] = useState<{ sessionId: string; title: string } | null>(null);
	const [renaming, setRenaming] = useState(false);
	const [sessionDelivery, setSessionDelivery] = useState<"steer" | "followUp">("steer");
	const [taskReplyDraft, setTaskReplyDraft] = useState("");
	const [sendingTaskReplyFor, setSendingTaskReplyFor] = useState<string | null>(null);
	const [projectPath, setProjectPath] = useState("");
	const [eventRequests, dispatchExtensionRequest] = useReducer(extensionRequestQueue, []);
	const eventRequest = eventRequests[0];
	const [authFlow, setAuthFlow] = useState<AuthFlowEvent | null>(null);
	const [mcpAuthEvent, setMcpAuthEvent] = useState<McpAuthEvent>();
	const transcriptRef = useRef<HTMLDivElement>(null);
	const transcriptAtBottom = useRef(true);
	const attachmentInputRef = useRef<HTMLInputElement>(null);
	const composingRef = useRef(false);
	const attachmentBudgetRef = useRef(new AttachmentBudget());
	const syncedExtensionEditors = useRef(new Map<string, string>());
	const dismissedAuthFlows = useRef(new Set<string>());
	const lastEventSeq = useRef(0);
	const sessionSelectionRequest = useRef(0);
	const policyRequest = useRef(0);
	const queueRequest = useRef(0);
	const snapshotRequest = useRef(0);
	const snapshotRef = useRef(snapshot);
	snapshotRef.current = snapshot;
	const activeProject = snapshot.projects.find((project) => project.id === snapshot.activeProjectId);
	const activeSession = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId);
	const activeSessionPolicy = sessionPolicy && activeSession?.id === sessionPolicy.sessionId ? sessionPolicy.policy : undefined;
	const activeQueue = activeSession ? snapshot.sessionQueues?.[activeSession.id] : undefined;
	const { text: draft, attachments, sending } = activeSession ? composer.get(activeSession.id) : { text: "", attachments: [], sending: false };
	const visibleSessions = filterSessionArchiveState(filterProjectSessions(snapshot.sessions, activeProject?.id, sessionSearch), showArchivedSessions);
	const setDraft = (value: string | ((current: string) => string)) => {
		if (!activeSession) return;
		try {
			composer.setText(activeSession.id, typeof value === "function" ? value(composer.get(activeSession.id).text) : value);
			renderComposer((version) => version + 1);
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update draft."); }
	};
	const appendDraftToSession = (sessionId: string, text: string) => {
		try {
			const current = composer.get(sessionId).text;
			composer.setText(sessionId, `${current}${current ? "\n\n" : ""}${text}`);
			renderComposer((version) => version + 1);
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update draft."); }
	};
	const sessionExtensionUi = activeSession ? snapshot.extensionUi[`session:${activeSession.id}`] : undefined;
	const projectTasks = snapshot.tasks.filter((task) => task.projectId === snapshot.activeProjectId);
	const selectedTask = projectTasks.find((task) => task.id === selectedTaskId) ?? projectTasks.find((task) => task.status !== "merged");
	const selectedTaskIdRef = useRef<string | undefined>(selectedTask?.id);
	selectedTaskIdRef.current = selectedTask?.id;
	const activeTask = taskDetailOpen ? selectedTask : undefined;
	const sendingTaskReply = activeTask !== undefined && sendingTaskReplyFor === activeTask.id;
	const catalogItems = snapshot.catalog[catalogKind];
	useEffect(() => { setSessionSearch(""); }, [snapshot.activeProjectId]);
	useEffect(() => { setRenameTarget((current) => current && current.sessionId !== snapshot.activeSessionId ? null : current); composingRef.current = false; }, [snapshot.activeSessionId]);
	useEffect(() => { setTaskReplyDraft(""); }, [activeProject?.id, selectedTask?.id]);

	useEffect(() => {
		setLanguagePreview(snapshot.settings.language);
		setThemePreview(snapshot.settings.theme);
		setShortcutPreview(snapshot.settings.sendShortcut);
	}, [snapshot.settings.language, snapshot.settings.theme, snapshot.settings.sendShortcut]);
	useEffect(() => { document.documentElement.lang = languagePreview; }, [languagePreview]);
	useEffect(() => { document.documentElement.dataset.theme = themePreview; }, [themePreview]);

	const applyEvent = useCallback((event: DesktopEvent) => {
		if (event.seq <= lastEventSeq.current) return;
		lastEventSeq.current = event.seq;
		if (event.type === "diagnostic") setError(`${event.code}: ${event.message}`);
		if (event.type === "extension.request" || event.type === "extension.dismiss") dispatchExtensionRequest(event);
		setSnapshot((current) => {
			if (event.seq <= current.lastEventSeq) return current;
			if (event.type === "snapshot") return event.snapshot;
			if (event.type === "message") return { ...current, lastEventSeq: event.seq, messages: current.messages.some((item) => item.id === event.message.id) ? current.messages.map((item) => item.id === event.message.id ? event.message : item) : [...current.messages, event.message] };
			if (event.type === "task") return { ...current, lastEventSeq: event.seq, tasks: current.tasks.some((item) => item.id === event.task.id) ? current.tasks.map((item) => item.id === event.task.id ? event.task : item) : [...current.tasks, event.task] };
			if (event.type === "session.queue") return { ...current, lastEventSeq: event.seq, sessionQueues: { ...current.sessionQueues, [event.sessionId]: event.queue } };
			if (event.type === "extension.update") return { ...current, lastEventSeq: event.seq, extensionUi: { ...current.extensionUi, [event.workerKey]: event.state } };
			if (event.type === "mcp.status") return { ...current, lastEventSeq: event.seq, ...(event.workerKey === `session:${current.activeSessionId}` ? { mcpServers: event.servers } : {}) };
			if (event.type === "terminal.output" && current.terminal?.id === event.terminalId) return { ...current, lastEventSeq: event.seq, terminal: { ...current.terminal, ...appendTerminalOutput(current.terminal, event.text) } };
			return { ...current, lastEventSeq: event.seq };
		});
	}, []);
	const applySnapshot = useCallback((next: AppSnapshot, requestId: number, guard: () => boolean = () => true) => {
		if (requestId !== snapshotRequest.current || !guard() || !canApplySnapshot(next.lastEventSeq, snapshotRef.current.lastEventSeq, lastEventSeq.current)) return false;
		lastEventSeq.current = Math.max(lastEventSeq.current, next.lastEventSeq);
		setSnapshot((current) => canApplySnapshot(next.lastEventSeq, current.lastEventSeq, lastEventSeq.current) ? next : current);
		return true;
	}, []);

	useEffect(() => {
		const api = window.piOrbit;
		if (!api) {
			setReady(true);
			setError("Desktop bridge is unavailable. Start Pi Orbit through the Electron main process to connect commands and local data.");
			return;
		}
		let unsubscribe: (() => void) | undefined;
		let alive = true;
		const requestId = ++snapshotRequest.current;
		void api.invoke("app.snapshot", undefined).then((result) => {
			if (!alive) return;
			if (!result.ok) {
				setError(`${result.code}: ${result.message}`);
				setReady(true);
				return;
			}
			if (requestId === snapshotRequest.current) applySnapshot(result.data, requestId);
			setReady(true);
			unsubscribe = api.subscribe(Math.max(result.data.lastEventSeq, lastEventSeq.current), applyEvent);
		}).catch((cause: unknown) => {
			if (!alive) return;
			setError(cause instanceof Error ? cause.message : "Could not load the local application snapshot.");
			setReady(true);
		});
		return () => { alive = false; unsubscribe?.(); };
	}, [applyEvent, applySnapshot]);

	useEffect(() => window.piOrbit?.subscribeAuth((event) => {
		if (!dismissedAuthFlows.current.has(event.flowId)) setAuthFlow(event);
	}), []);
	useEffect(() => window.piOrbit?.subscribeMcpAuth((event) => setMcpAuthEvent(event)), []);

	useEffect(() => {
		const panel = transcriptRef.current;
		if (!panel) return;
		const updatePosition = () => {
			transcriptAtBottom.current = shouldAutoScrollTranscript(panel.scrollTop, panel.clientHeight, panel.scrollHeight);
		};
		panel.addEventListener("scroll", updatePosition, { passive: true });
		return () => panel.removeEventListener("scroll", updatePosition);
	}, []);
	useEffect(() => {
		const panel = transcriptRef.current;
		if (panel && transcriptAtBottom.current) panel.scrollTop = panel.scrollHeight;
	}, [snapshot.messages]);
	useEffect(() => {
		transcriptAtBottom.current = true;
		const panel = transcriptRef.current;
		if (panel) panel.scrollTop = panel.scrollHeight;
	}, [snapshot.activeSessionId]);

	useEffect(() => {
		if (!activeSession) return;
		const workerKey = `session:${activeSession.id}`;
		const editorText = snapshot.extensionUi[workerKey]?.editorText;
		if (editorText === undefined || syncedExtensionEditors.current.get(workerKey) === editorText) return;
		syncedExtensionEditors.current.set(workerKey, editorText);
		setDraft(editorText);
	}, [activeSession?.id, snapshot.extensionUi]);

	const call = useCallback(async <K extends Command>(command: K, payload: CommandMap[K]["payload"]): Promise<Result<CommandMap[K]["data"]>> => {
		if (!window.piOrbit) return { ok: false, code: "BRIDGE_UNAVAILABLE", message: "The desktop command bridge is unavailable." };
		try {
			const result = await window.piOrbit.invoke(command, payload);
			if (!result.ok) setError(`${result.code}: ${result.message}`);
			else setError(null);
			return result;
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : "The desktop command failed.";
			setError(message);
			return { ok: false, code: "COMMAND_FAILED", message };
		}
	}, []);
	const refreshSessionPolicy = useCallback(async (sessionId: string) => {
		const requestId = ++policyRequest.current;
		const selectionId = sessionSelectionRequest.current;
		const result = await call("session.policy.get", { sessionId });
		if (result.ok && requestId === policyRequest.current && selectionId === sessionSelectionRequest.current && snapshotRef.current.activeSessionId === sessionId) {
			setSessionPolicy({ sessionId, policy: result.data });
		}
	}, [call]);
	useEffect(() => {
		setSessionPolicy(undefined);
		if (activeSession?.id) void refreshSessionPolicy(activeSession.id);
	}, [activeSession?.id, refreshSessionPolicy]);
	useEffect(() => {
		const sessionId = activeSession?.id;
		const requestId = ++queueRequest.current;
		if (!sessionId || snapshot.sessionQueues?.[sessionId]) return;
		const observedSeq = lastEventSeq.current;
		void call("session.queue.get", { sessionId }).then((result) => {
			if (!result.ok || requestId !== queueRequest.current || snapshotRef.current.activeSessionId !== sessionId || lastEventSeq.current !== observedSeq) return;
			setSnapshot((current) => lastEventSeq.current === observedSeq ? { ...current, sessionQueues: { ...current.sessionQueues, [sessionId]: result.data } } : current);
		});
	}, [activeSession?.id, call, snapshot.sessionQueues]);
	const respondExtensionDialog = (requestId: string, value: unknown) => {
		void call("extension.ui.respond", { requestId, value }).then((result) => {
			dispatchExtensionRequest({ type: "extension.response", requestId, result });
		});
	};

	const selectSession = async (sessionId: string) => {
		const selectionId = ++sessionSelectionRequest.current;
		const selectionEventSeq = lastEventSeq.current;
		const result = await call("session.select", { sessionId });
		if (!result.ok || selectionId !== sessionSelectionRequest.current) return;
		const requestId = ++snapshotRequest.current;
		const refreshed = await call("app.snapshot", undefined);
		if (selectionId !== sessionSelectionRequest.current || requestId !== snapshotRequest.current) return;
		if (refreshed.ok) applySnapshot(refreshed.data, requestId, () => matchesSessionSelection(selectionId, sessionSelectionRequest.current, refreshed.data.activeSessionId, sessionId) && snapshotRef.current.activeProjectId === result.data.projectId);
		else if (selectionId === sessionSelectionRequest.current && requestId === snapshotRequest.current && snapshotRef.current.activeProjectId === result.data.projectId && lastEventSeq.current === selectionEventSeq) {
			setSnapshot((current) => selectionId === sessionSelectionRequest.current && requestId === snapshotRequest.current && current.lastEventSeq === selectionEventSeq ? { ...current, activeSessionId: sessionId, messages: [] } : current);
		}
	};
	const refreshSnapshot = async () => {
		const requestId = ++snapshotRequest.current;
		const result = await call("app.snapshot", undefined);
		if (!result.ok || !applySnapshot(result.data, requestId)) return;
		if (result.data.activeSessionId) void refreshSessionPolicy(result.data.activeSessionId);
		else {
			++policyRequest.current;
			setSessionPolicy(undefined);
		}
	};
	const setSessionArchived = async (sessionId: string, archived: boolean) => {
		if (archivingSessionId) return;
		const session = snapshotRef.current.sessions.find((item) => item.id === sessionId);
		if (!session || (archived && session.status === "running")) return;
		setArchivingSessionId(sessionId);
		try {
			const result = await call(archived ? "session.archive" : "session.restore", { sessionId });
			if (result.ok) await refreshSnapshot();
		} finally { setArchivingSessionId(null); }
	};
	const setSessionMode = async (mode: DesktopSessionPolicy["mode"]) => {
		if (!activeSession || activeSession.status !== "idle" || policySaving) return;
		const sessionId = activeSession.id;
		++policyRequest.current;
		setPolicySaving(true);
		try {
			const result = await call("session.policy.set", { sessionId, mode });
			if (result.ok && snapshotRef.current.activeSessionId === sessionId) setSessionPolicy({ sessionId, policy: result.data });
		} finally { setPolicySaving(false); }
	};
	const clearSessionQueue = async () => {
		if (!activeSession || queueClearing || !activeQueue || activeQueue.pendingCount === 0) return;
		const sessionId = activeSession.id;
		const projectId = activeSession.projectId;
		const observedSeq = lastEventSeq.current;
		setQueueClearing(true);
		try {
			const result = await call("session.queue.clear", { sessionId });
			if (!result.ok) return;
			setSnapshot((current) => lastEventSeq.current === observedSeq ? { ...current, sessionQueues: { ...current.sessionQueues, [sessionId]: result.data } } : current);
			const current = snapshotRef.current;
			if (current.activeSessionId !== sessionId || current.activeProjectId !== projectId || current.sessions.find((session) => session.id === sessionId)?.archived) return;
			const returnedText = queuedMessagesForDraft(result.data);
			if (returnedText) appendDraftToSession(sessionId, returnedText);
		} finally { setQueueClearing(false); }
	};
	const renameSession = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!renameTarget || renaming || !renameTarget.title.trim()) return;
		const target = renameTarget;
		setRenaming(true);
		try {
			const result = await call("session.rename", { sessionId: target.sessionId, title: target.title.trim() });
			if (result.ok) {
				setRenameTarget((current) => current === target ? null : current);
				await refreshSnapshot();
			}
		} finally { setRenaming(false); }
	};
	const openProject = async (path: string) => {
		const result = await call("project.open", { path });
		if (result.ok) await refreshSnapshot();
	};
	const createSession = async (projectId: string) => {
		const result = await call("session.create", { projectId });
		if (result.ok) await refreshSnapshot();
	};
	const importSession = async (projectId: string) => {
		const result = await call("session.import", { projectId });
		if (result.ok && result.data.imported) await refreshSnapshot();
	};
	const mergeTask = async (taskId: string) => {
		const result = await call("task.merge", { taskId });
		if (!result.ok) return;
		await refreshSnapshot();
		if (!result.data.merged) setError(result.data.conflicts.length ? `Merge needs attention: ${result.data.conflicts.join(", ")}` : "Merge was not applied. Review the task diff and try again.");
	};
	const addAttachments = async (event: ChangeEvent<HTMLInputElement>) => {
		const sessionId = activeSession?.id;
		const files = Array.from(event.target.files ?? []);
		event.target.value = "";
		if (!sessionId || files.length === 0) return;
		let releaseBudget: (() => void) | undefined;
		try {
			const emptyFile = files.find((file) => file.size === 0);
			if (emptyFile) throw new Error(`${emptyFile.name} is empty.`);
			const oversizedFile = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
			if (oversizedFile) throw new Error(`${oversizedFile.name} exceeds the 8 MiB attachment limit.`);
			releaseBudget = attachmentBudgetRef.current.reserve(files, composer.get(sessionId).attachments);
			const loaded: DesktopAttachment[] = [];
			for (const file of files) {
				const extension = /\.[^.]+$/.exec(file.name)?.[0]?.toLowerCase() ?? "";
				const mimeType = file.type.toLowerCase() || ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" } as Record<string, string>)[extension] || "";
				if (mimeType.startsWith("image/")) {
					if (!imageMimeTypes.has(mimeType)) throw new Error(`${file.name} uses an unsupported image format.`);
					loaded.push({ type: "image", name: file.name, mimeType, data: bytesToBase64(new Uint8Array(await file.arrayBuffer())) });
				} else if (mimeType.startsWith("text/") || textFileExtensions.has(extension)) {
					let text: string;
					try {
						text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
					} catch {
						throw new Error(`${file.name} is not valid UTF-8 text.`);
					}
					loaded.push({ type: "text", name: file.name, text });
				} else {
					throw new Error(`${file.name} is not a supported image or text file.`);
				}
			}
			composer.addAttachments(sessionId, loaded);
			renderComposer((version) => version + 1);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not read the selected file.");
		} finally {
			releaseBudget?.();
		}
	};
	const promptSession = async () => {
		if (!activeSession) return;
		const pending = composer.beginSend(activeSession.id);
		if (!pending) return;
		renderComposer((version) => version + 1);
		const payloadAttachments = pending.attachments.length ? [...pending.attachments] : undefined;
		const result = activeSession.status === "running"
			? await call("session.message", { sessionId: pending.sessionId, text: pending.text.trim(), deliverAs: sessionDelivery, ...(payloadAttachments ? { attachments: payloadAttachments } : {}) })
			: await call("session.prompt", { sessionId: pending.sessionId, text: pending.text.trim(), ...(payloadAttachments ? { attachments: payloadAttachments } : {}) });
		composer.finishSend(pending, result.ok);
		renderComposer((version) => version + 1);
	};
	const removeAttachment = (index: number) => {
		if (!activeSession) return;
		composer.removeAttachment(activeSession.id, index);
		renderComposer((version) => version + 1);
	};
	const openCatalog = (kind: CatalogKind) => { setCatalogKind(kind); setModal("catalog"); };
	const submitPrompt = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void promptSession(); };
	const submitTaskReply = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!activeTask || activeTask.status !== "running" || sendingTaskReplyFor === activeTask.id || !taskReplyDraft.trim()) return;
		const taskId = activeTask.id;
		const submittedDraft = taskReplyDraft;
		const text = taskReplyDraft.trim();
		setSendingTaskReplyFor(taskId);
		try {
			const result = await call("task.message", { taskId, text });
			setTaskReplyDraft((current) => taskReplyAfterSend(current, submittedDraft, result.ok, selectedTaskIdRef.current === taskId));
		} finally {
			setSendingTaskReplyFor((current) => current === taskId ? null : current);
		}
	};

	return <main className="app-shell">
		<header className="topbar">
			<div className="brand"><div className="brand-mark">π</div><span>Pi <b>Orbit</b></span></div>
			<div className="project-switcher">
				<span className="top-label">{t("WORKSPACE")}</span>
				<select aria-label={t("Active project")} value={activeProject?.id ?? ""} onChange={(event) => {
					const project = snapshot.projects.find((item) => item.id === event.target.value);
					if (project) void openProject(project.path);
				}}>
					<option value="" disabled>{t("Select a project")}</option>
					{snapshot.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
				</select>
				{activeProject && <span className="branch-chip"><span className="green-dot" />{activeProject.branch}</span>}
				{activeProject && <button className="project-review-trigger" type="button" onClick={() => setProjectChangesOpen(true)}>{t("Review project changes")}</button>}
			</div>
			<div className="top-actions">
				<div className="connection"><span className={ready ? "green-dot" : "amber-dot"} />{ready ? t("Local workspace") : t("Connecting")}</div>
				<button className="icon-button" aria-label={t("Open settings")} onClick={() => setModal("settings")}>⚙</button>
				<div className="avatar" aria-label="Pi Orbit">PO</div>
			</div>
		</header>

		{error && <div className="diagnostic" role="status"><span aria-hidden="true">!</span><div><b>{t("Desktop diagnostic")}</b><p>{translateDiagnostic(error, t)}</p></div><button className="close-diagnostic" aria-label={t("Dismiss diagnostic")} onClick={() => setError(null)}>×</button></div>}

		<div className="workspace-grid">
			<aside className="sidebar left-sidebar" aria-label={t("Projects and sessions")}>
				<div className="side-scroll">
					<div className="section-head"><span>{t("Projects")}</span><button className="tiny-icon" aria-label={t("Open project folder")} onClick={() => setModal("open-project")}>＋</button></div>
					{snapshot.projects.length === 0 ? <p className="empty-hint">{t("Open a local folder to start a workspace.")}</p> : snapshot.projects.map((project) => <button key={project.id} className={`project-row ${project.id === activeProject?.id ? "selected" : ""}`} onClick={() => void openProject(project.path)}><span className="folder-glyph">▱</span><span className="row-text">{project.name}</span>{project.dirty && <span className="dirty-mark" title={t("Uncommitted changes")}>●</span>}</button>)}
					{snapshot.projects.length === 0 && <form className="inline-open" onSubmit={(event) => { event.preventDefault(); if (projectPath.trim()) void openProject(projectPath.trim()); }}><label htmlFor="project-path">{t("Folder path")}</label><div><input id="project-path" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="C:\\work\\project" /><button type="submit" aria-label={t("Open folder")}>↵</button></div></form>}
					{activeProject && <>
						<div className="section-head session-heading"><span>{t(showArchivedSessions ? "Archived sessions" : "Sessions")}</span><div className="session-section-actions"><button className={`tiny-icon ${showArchivedSessions ? "session-archive-active" : ""}`} aria-label={t(showArchivedSessions ? "Show active sessions" : "Show archived sessions")} title={t(showArchivedSessions ? "Show active sessions" : "Show archived sessions")} onClick={() => setShowArchivedSessions((value) => !value)}>▤</button>{!showArchivedSessions && <><button className="tiny-icon" aria-label={t("Import session")} title={t("Import session")} onClick={() => void importSession(activeProject.id)}>↓</button><button className="tiny-icon" aria-label={t("New session")} title={t("New session")} onClick={() => void createSession(activeProject.id)}>＋</button></>}</div></div>
						<input className="session-search" type="search" aria-label={t("Search sessions")} placeholder={t("Search sessions…")} value={sessionSearch} onChange={(event) => setSessionSearch(event.target.value)} />
						{visibleSessions.map((session) => <div key={session.id} className={`session-row-wrap ${session.id === activeSession?.id ? "selected" : ""}`}><button className={`session-row ${session.id === activeSession?.id ? "selected" : ""}`} disabled={session.archived || session.id === activeSession?.id} onClick={() => void selectSession(session.id)}><span className="session-glyph">◷</span><span className="row-text">{session.title || t("Untitled session")}</span>{session.status === "running" && <span className="live-dot" />}</button>{session.archived ? <button className="session-row-action" type="button" disabled={archivingSessionId === session.id} aria-label={`${t("Restore session")} ${session.title}`} title={t("Restore session")} onClick={() => void setSessionArchived(session.id, false)}>↶</button> : <button className="session-row-action" type="button" disabled={archivingSessionId === session.id || session.status === "running"} aria-label={`${t("Archive session")} ${session.title}`} title={session.status === "running" ? t("Running sessions cannot be archived.") : t("Archive session")} onClick={() => void setSessionArchived(session.id, true)}>⌑</button>}</div>)}
						{visibleSessions.length === 0 && <p className="empty-hint">{t(sessionSearch.trim() ? "No matching sessions." : showArchivedSessions ? "No archived sessions." : "No sessions yet. Create one with ＋.")}</p>}
					</>}
					<div className="section-head tools-heading"><span>{t("Library")}</span></div>
					<button className="nav-row" onClick={() => openCatalog("skills")}><span>✳</span><span>{t("Skills")}</span><small>{snapshot.catalog.skills.length}</small></button>
					<button className="nav-row" onClick={() => openCatalog("templates")}><span>▤</span><span>{t("Templates")}</span><small>{snapshot.catalog.templates.length}</small></button>
					<button className="nav-row" onClick={() => openCatalog("commands")}><span>⌘</span><span>{t("Commands")}</span><small>{snapshot.catalog.commands.length}</small></button>
					<button className="nav-row" onClick={() => openCatalog("extensions")}><span>⬡</span><span>{t("Extensions")}</span><small>{snapshot.catalog.extensions.length}</small></button>
					<button className="nav-row" onClick={() => setModal("mcp")}><span>◇</span><span>{t("MCP servers")}</span><small>{snapshot.mcpServers?.length ?? 0}</small></button>
				</div>
				<div className="sidebar-footer"><button onClick={() => setModal("roles")}><span className="role-icon">◉</span><span>{t("Agent roles")}</span><span className="footer-chevron">↗</span></button><span className="version-label">{t("PI ORBIT · LOCAL")}</span></div>
			</aside>

			<section className="conversation" aria-label={t("Conversation")}>
			<div className="conversation-head"><div><div className="crumb">{activeProject?.name ?? t("No project selected")}<span>/</span>{activeSession?.title ?? t("New conversation")}</div><h1>{activeSession?.title || t("Pi workspace")}</h1></div><div className="conversation-actions"><button className="action-button rename-session-button" aria-label={t("Rename session")} disabled={!activeSession} onClick={() => activeSession && setRenameTarget({ sessionId: activeSession.id, title: activeSession.title })}>{t("Rename")}</button><span className={`status-pill ${activeSession?.status === "running" ? "is-running" : ""}`}><i />{activeSession?.status === "running" ? t("Running") : t("Ready")}</span><button className="action-button" disabled={!activeSession} onClick={() => activeSession && setModal("session-details")}>{t("Session details")}</button>{activeSession && <button className="action-button" disabled={activeSession.status === "running" || archivingSessionId === activeSession.id} onClick={() => void setSessionArchived(activeSession.id, true)} title={activeSession.status === "running" ? t("Running sessions cannot be archived.") : t("Archive session")}>{t("Archive")}</button>}<button className="action-button primary-action" disabled={!activeProject || !snapshot.settings.subagentsEnabled} title={!snapshot.settings.subagentsEnabled ? t("Enable subagents in Settings to create tasks.") : undefined} onClick={() => setModal("new-task")}>＋ {t("New task")}</button></div></div>
			{renameTarget && <form className="session-rename" onSubmit={(event) => void renameSession(event)}><label>{t("Session name")}<input autoFocus maxLength={200} required value={renameTarget.title} onChange={(event) => setRenameTarget({ ...renameTarget, title: event.target.value })} onKeyDown={(event) => { if (event.key === "Escape") setRenameTarget(null); }} /></label><button type="submit" className="primary-action" disabled={renaming || !renameTarget.title.trim()}>{t("Save name")}</button><button type="button" className="outline-button" onClick={() => setRenameTarget(null)}>{t("Cancel")}</button></form>}
			{activeSession && <div className="model-line"><span className="model-glyph">◈</span><select aria-label={t("Model")} value={activeSession.model || snapshot.settings.defaultModel} onChange={(event) => void call("model.select", { sessionId: activeSession.id, model: event.target.value })}><option value="">{t("Choose model")}</option>{snapshot.providers.flatMap((provider) => provider.models.map((model) => <option key={`${provider.id}:${model}`} value={model}>{model}</option>))}</select><span className="model-provider">{snapshot.providers.find((provider) => provider.models.includes(activeSession.model))?.name ?? (snapshot.providers.length ? t("Choose a model") : t("Configure a provider in Settings"))}</span>{snapshot.providers.length === 0 && <button type="button" className="text-button" onClick={() => setModal("settings")}>{t("Settings")}</button>}<label className="session-policy-control">{t("Mode")}<select aria-label={t("Session mode")} value={activeSessionPolicy?.mode ?? "build"} disabled={activeSession.status !== "idle" || policySaving || !activeSessionPolicy} onChange={(event) => void setSessionMode(event.target.value as DesktopSessionPolicy["mode"])}><option value="build">{t("Build")}</option><option value="plan">{t("Plan")}</option></select></label></div>}
			{activeSession && activeQueue && activeQueue.pendingCount > 0 && <section className="session-queue" aria-label={t("Queued messages")}><div className="session-queue-heading"><b>{t("Queued messages")} · {activeQueue.pendingCount}</b><button type="button" className="text-button" disabled={queueClearing} onClick={() => void clearSessionQueue()}>{t(queueClearing ? "Working…" : "Clear queue to draft")}</button></div>{queuePreviewIsTruncated(activeQueue) && <p className="session-queue-notice" role="status">{t("Some queued messages are omitted from this preview.")}</p>}{activeQueue.steering.length > 0 && <div><span>{t("Steering")}</span>{activeQueue.steering.map((text, index) => <p key={`s${index}`}>{text}</p>)}</div>}{activeQueue.followUp.length > 0 && <div><span>{t("Follow-up")}</span>{activeQueue.followUp.map((text, index) => <p key={`f${index}`}>{text}</p>)}</div>}</section>}
				<div className="transcript" ref={transcriptRef} aria-live="polite" aria-relevant="additions text">
					{!activeSession ? (
						<div className="welcome"><div className="welcome-orbit"><span>π</span><i /><b /></div><p className="eyebrow">{t("YOUR LOCAL AI WORKSPACE")}</p><h2>{t("Build something")}<br /><em>{t("thoughtful.")}</em></h2><p className="welcome-copy">{t("Choose a project and session, then work with Pi in a focused desktop workspace.")}</p><div className="welcome-cards"><button onClick={() => activeProject ? void createSession(activeProject.id) : setModal("open-project")}><span>✳</span><b>{t("Start a conversation")}</b><small>{t("Ask Pi to explore or change your code")}</small></button><button disabled={!snapshot.settings.subagentsEnabled} title={!snapshot.settings.subagentsEnabled ? t("Enable subagents in Settings to create tasks.") : undefined} onClick={() => activeProject ? setModal("new-task") : setModal("open-project")}><span>⌘</span><b>{t("Delegate a task")}</b><small>{t("Run a focused agent in its own worktree")}</small></button></div>{!snapshot.settings.subagentsEnabled && <button className="text-button welcome-settings-link" onClick={() => setModal("settings")}>{t("Enable subagents in Settings to create tasks.")}</button>}</div>
					) : snapshot.messages.length === 0 ? (
						<div className="conversation-empty"><div className="assistant-mark">π</div><b>{t("Ready when you are.")}</b><span>{t("Send a message to start working in")} {activeProject?.name}.</span></div>
					) : snapshot.messages.map((message) => (
						<article className={`message message-${message.role}`} key={message.id}>
							<div className="message-avatar">{message.role === "user" ? "Y" : message.role === "assistant" ? "π" : "i"}</div>
							<div className="message-body">
								<div className="message-meta"><b>{message.role === "user" ? t("You") : message.role === "assistant" ? "Pi" : t("System")}</b><time>{formatTime(message.createdAt, languagePreview)}</time></div>
								{message.parts.map((part, index) => {
									if (part.kind === "text") return <p className="message-text" key={index}>{part.text}</p>;
									if (part.kind === "image") return <div className="message-image-attachment" key={index}><span aria-hidden="true">▧</span><b>{t("Image attachment")}</b><small>{part.mimeType}</small></div>;
									if (part.kind === "thinking") return <details className="thinking-block" key={index}><summary>{t("Reasoning")}</summary><p>{part.text}</p></details>;
									return <details className={`tool-card tool-${part.status}`} open={sessionExtensionUi?.toolsExpanded || undefined} key={index}><summary><span className="tool-icon">⌘</span><b>{part.name}</b><span className="tool-state">{t(part.status)}</span></summary>{part.input && <pre>{part.input}</pre>}{part.output && <pre>{part.output}</pre>}</details>;
								})}
							</div>
						</article>
					))}
				</div>
				{activeSession && <ExtensionUiPanel state={sessionExtensionUi} t={t} onUseEditorText={(text) => setDraft(text)} />}
				<div className="composer-wrap">
					{activeSession && snapshot.catalog.skills.filter((skill) => skill.enabled).slice(0, 3).map((skill) => <button className="context-chip" key={skill.id} onClick={() => void call("catalog.run", { kind: "skill", id: skill.id }).then((result) => { if (result.ok && result.data.insertedText) setDraft((current) => `${current}${current ? "\n\n" : ""}${result.data.insertedText}`); })}>✳ {skill.name}</button>)}
					<form className="composer" onSubmit={submitPrompt}><input ref={attachmentInputRef} className="attachment-file-input" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,text/*,.md,.markdown,.json,.jsonc,.yaml,.yml,.toml,.csv,.tsv,.log,.js,.jsx,.ts,.tsx,.css,.html,.xml,.py,.rs,.go,.java,.c,.h,.cpp,.hpp,.cs,.php,.rb,.sh,.sql,.env,.diff,.patch,.ini,.conf" onChange={(event) => void addAttachments(event)} /><textarea aria-label={t("Message Pi")} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={100_000} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={(event) => { if (!composingRef.current && shouldSendKey(event.nativeEvent, shortcutPreview)) { event.preventDefault(); void promptSession(); } }} placeholder={activeSession ? t("Message Pi…") : t("Select or create a session to begin")} disabled={!activeSession} rows={3} />{attachments.length > 0 && <div className="attachment-previews" aria-label={t("Attachments")}>{attachments.map((attachment, index) => <div className="attachment-preview" key={`${attachment.name}-${index}`}>{attachment.type === "image" ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} /> : <span className="attachment-text-icon" aria-hidden="true">▤</span>}<span className="attachment-file-details"><b title={attachment.name}>{attachment.name}</b><small>{formatFileSize(attachmentSize(attachment))}</small></span><button type="button" aria-label={`${t("Remove attachment")} ${attachment.name}`} onClick={() => removeAttachment(index)}>×</button></div>)}</div>}<div className="composer-bottom"><div className="composer-tools"><button type="button" title={t("Attach or reference file")} aria-label={t("Attach files")} disabled={!activeSession} onClick={() => attachmentInputRef.current?.click()}>＋</button><button type="button" onClick={() => openCatalog("skills")}>✳ <span>{t("Skills")}</span></button><button type="button" onClick={() => openCatalog("templates")}>▤ <span>{t("Template")}</span></button><button type="button" onClick={() => setModal("terminal")}>⌘ <span>{t("Terminal")}</span></button></div><div className="send-group"><span>{shortcutPreview === "enter" ? t("↵ to send · ⇧↵ for newline") : t("Ctrl+↵ to send · ↵ for newline")}</span>{activeSession?.status === "running" && <label className="delivery-mode-label">{t("Send as")}<select aria-label={t("Send as")} className="delivery-mode" value={sessionDelivery} onChange={(event) => setSessionDelivery(event.target.value as "steer" | "followUp")}><option value="steer">{t("Steer now")}</option><option value="followUp">{t("Follow up")}</option></select></label>}{activeSession?.status === "running" && <button type="submit" className="send-button" aria-label={t("Queue message")} title={t("Queue message")} disabled={sending || (!draft.trim() && attachments.length === 0)}>↑</button>}{activeSession?.status === "running" && <button type="button" className="stop-button" onClick={() => void call("session.abort", { sessionId: activeSession.id })}>■ {t("Stop")}</button>}{activeSession && activeSession.status !== "running" && <button className="send-button" type="submit" aria-label={t("Send message")} disabled={sending || (!draft.trim() && attachments.length === 0)}>↑</button>}</div></div></form><div className="draft-status" role="status">{activeSession && (composer.persistenceFailed ? t("Draft kept in memory only. Local storage is unavailable.") : draft ? t("Text draft saved on this device") : "")}</div><div className="composer-disclaimer">{t("Pi can make mistakes. Review changes before merging.")}</div>
				</div>
			</section>

			<aside className="sidebar right-sidebar" aria-label={t("Task and file details")}>
				<div className="inspector-head"><div><span className="eyebrow">{t("ORCHESTRATION")}</span><h2>{t("Tasks")} <span className="task-count">{projectTasks.length}</span></h2></div><button className="tiny-icon" aria-label={t("Create task")} title={!snapshot.settings.subagentsEnabled ? t("Enable subagents in Settings to create tasks.") : undefined} disabled={!activeProject || !snapshot.settings.subagentsEnabled} onClick={() => setModal("new-task")}>＋</button></div>
				<div className="task-list" aria-label={t("Task list")}>{projectTasks.length === 0 ? <div className="task-empty"><div className="task-empty-icon">⑂</div><b>{t("No delegated tasks")}</b><p>{t("Delegate focused work to a role. Each task gets an isolated worktree and its own conversation.")}</p>{snapshot.settings.subagentsEnabled ? <button className="outline-button" disabled={!activeProject} onClick={() => setModal("new-task")}>{t("Create task")}</button> : <button className="text-button" onClick={() => setModal("settings")}>{t("Enable subagents in Settings")}</button>}</div> : projectTasks.map((task) => <button key={task.id} aria-pressed={task.id === selectedTask?.id && taskDetailOpen} className={`task-card ${task.id === selectedTask?.id && taskDetailOpen ? "task-selected" : ""}`} onClick={() => { setSelectedTaskId(task.id); setTaskDetailOpen(true); setSelectedFile(null); }}><div className="task-card-top"><span className={`task-status status-${task.status}`}>{statusLabel(task.status, t)}</span><span className="task-time">{relativeTime(task.updatedAt, languagePreview)}</span></div><b>{task.prompt}</b><div className="task-card-meta"><span className="task-avatar">{task.roleName.slice(0, 1).toUpperCase()}</span>{task.roleName}<span className="meta-sep">·</span>{task.filesChanged} {t("files")}</div>{task.dependsOn.length > 0 && <div className="dependency-line">↳ {t(" waits for ")}{task.dependsOn.map((id) => snapshot.tasks.find((candidate) => candidate.id === id)?.roleName ?? id.slice(0, 7)).join(", ")}</div>}</button>)}</div>
				{activeTask && <div className="task-detail"><div className="detail-title-row"><div><span className={`task-status status-${activeTask.status}`}>{statusLabel(activeTask.status, t)}</span><h3>{activeTask.roleName}</h3></div><button className="tiny-icon" aria-label={t("Close task details")} title={t("Close task details")} onClick={() => { setTaskDetailOpen(false); setSelectedFile(null); }}>×</button></div><p className="task-prompt">{activeTask.prompt}</p>{activeTask.resultSummary && <div className="task-result"><div className="detail-label">{t("LATEST RESULT")}</div><p>{activeTask.resultSummary}</p></div>}<ExtensionUiPanel state={snapshot.extensionUi[`task:${activeTask.id}`]} t={t} onUseEditorText={(text) => setDraft(text)} /><div className="task-actions">{activeTask.status === "running" && <button onClick={() => void call("task.pause", { taskId: activeTask.id })}>Ⅱ {t("Pause")}</button>}{canResumeTask(activeTask.status, snapshot.settings.subagentsEnabled) && <button onClick={() => void call("task.resume", { taskId: activeTask.id })}>▶ {t("Resume")}</button>}{canResumeTask(activeTask.status) && !snapshot.settings.subagentsEnabled && <button className="text-button" onClick={() => setModal("settings")}>{t("Enable subagents in Settings to create or resume tasks.")}</button>}{!["merged", "cancelled", "failed", "completed"].includes(activeTask.status) && <button className="danger-action" onClick={() => void call("task.cancel", { taskId: activeTask.id })}>{t("Cancel")}</button>}{["review", "completed"].includes(activeTask.status) && <button className="merge-button" onClick={() => void mergeTask(activeTask.id)}>{t("Merge changes")}</button>}</div>{activeTask.usage && <div className="task-usage"><span>{t("Usage")}</span><span>{t("In")} {activeTask.usage.input.toLocaleString()}</span><span>{t("Out")} {activeTask.usage.output.toLocaleString()}</span></div>}
					<div className="detail-tabs"><span>{t("Changes")} <b>{activeTask.changes.length}</b></span><span>{t("Activity")} <b>{activeTask.messages.length + activeTask.toolRecords.length}</b></span></div>
					<div className="change-list">{activeTask.changes.length ? activeTask.changes.map((change) => <button key={change.path} className={`change-row ${selectedFile === change.path ? "file-selected" : ""}`} onClick={() => setSelectedFile(selectedFile === change.path ? null : change.path)}><span className={`file-dot file-${change.status}`} />{change.path}<span className="change-kind">{change.status === "modified" ? "M" : change.status === "added" ? "A" : "D"}</span></button>) : <p className="empty-hint">{t("No changed files yet.")}</p>}{selectedFile && activeTask.changes.find((change) => change.path === selectedFile) && <pre className="diff-preview">{activeTask.changes.find((change) => change.path === selectedFile)?.diff || t("No diff content was provided.")}</pre>}</div>
					<div className="task-messages"><div className="detail-label">{t("TASK MESSAGES")}</div>{activeTask.messages.length > 0 ? activeTask.messages.slice(-3).map((message) => <div key={message.id} className="task-message"><b>{message.author}</b><p>{message.text}</p></div>) : <p className="empty-hint">{t("No task messages yet.")}</p>}</div>
					{activeTask.toolRecords.length > 0 && <details className="activity-details"><summary>{t("Tool activity")} · {activeTask.toolRecords.length}</summary>{activeTask.toolRecords.slice(-5).map((record) => <div className="activity-row" key={record.id}><span>{record.name}</span><small>{t(record.status)}</small><p>{record.summary}</p></div>)}</details>}
					<div className="task-reply"><form onSubmit={(event) => void submitTaskReply(event)}><input name="task-reply" aria-label={`${t("Send a message to")} ${activeTask.roleName}`} placeholder={activeTask.status === "running" ? t("Message this task…") : t("Task messages are available while running")} value={taskReplyDraft} onChange={(event) => setTaskReplyDraft(event.target.value)} disabled={activeTask.status !== "running" || sendingTaskReply} /><button type="submit" aria-label={t("Send task message")} disabled={activeTask.status !== "running" || sendingTaskReply || !taskReplyDraft.trim()}>↑</button></form></div>
				</div>}
				<div className="inspector-footer"><div><span className="green-dot" />{t("LOCAL ONLY")}</div><button onClick={() => setModal("terminal")}>⌘ {t("Terminal")}</button></div>
			</aside>
		</div>
		{modal && <ModalView modal={modal} snapshot={snapshot} t={t} onLanguageChange={setLanguagePreview} onThemeChange={setThemePreview} onSendShortcutChange={setShortcutPreview} onSettingsSaved={(settings) => setSnapshot((current) => ({ ...current, settings }))} catalogKind={catalogKind} catalogItems={catalogItems} activeProjectId={activeProject?.id} activeSessionId={activeSession?.id} mcpAuthEvent={mcpAuthEvent} onCatalogKindChange={setCatalogKind} onInsertDraft={(text) => setDraft((current) => `${current}${current ? "\n\n" : ""}${text}`)} onAppendDraftToSession={appendDraftToSession} onOpenRoles={() => setModal("roles")} onOpenSettings={() => setModal("settings")} onStartOAuth={(providerId) => { void call("auth.login", { providerId }).then((result) => { if (result.ok) setAuthFlow((current) => current ?? { flowId: result.data.flowId, type: "started" }); }); }} authFlowActive={authFlow !== null} onClose={() => { setLanguagePreview(snapshot.settings.language); setThemePreview(snapshot.settings.theme); setShortcutPreview(snapshot.settings.sendShortcut); setMcpAuthEvent(undefined); setModal(null); }} call={call} refresh={refreshSnapshot} />}
		{projectChangesOpen && activeProject && <ProjectChangesPanel key={activeProject.id} projectId={activeProject.id} projectName={activeProject.name} activeSessionId={activeSession?.id} t={t} call={call} onClose={() => setProjectChangesOpen(false)} onRequestReview={(projectId, sessionId, baseCommit, mode, ref, changes, truncated) => {
			const current = snapshotRef.current;
			const session = current.sessions.find((item) => item.id === sessionId);
			if (current.activeProjectId !== projectId || current.activeSessionId !== sessionId || session?.projectId !== projectId || session.archived) return;
			const target = mode === "workingTree" ? "the current working tree" : mode === "baseBranch" ? `branch ${ref}` : `commit ${ref}`;
			const fileList = changes.map((change) => `- ${change.status}: ${change.path}`).join("\n");
			appendDraftToSession(sessionId, `Review the project changes against ${target}. Base commit: ${baseCommit || "unknown"}. Check for correctness issues, regressions, and missing tests.${truncated ? " The displayed diff was truncated." : ""}\n\nChanged files:\n${fileList}`);
			setProjectChangesOpen(false);
		}} />}
		{eventRequest && <ExtensionDialog key={eventRequest.request.id} request={eventRequest.request} t={t} onSubmit={(value) => respondExtensionDialog(eventRequest.request.id, value)} onCancel={(value) => respondExtensionDialog(eventRequest.request.id, value)} />}
		{authFlow && <AuthFlowDialog key={`${authFlow.flowId}:${authFlow.type === "prompt" ? authFlow.promptId : authFlow.type}`} event={authFlow} t={t} call={call} onClose={() => { dismissedAuthFlows.current.add(authFlow.flowId); if (authFlow.type !== "complete" && authFlow.type !== "failed" && authFlow.type !== "cancelled") void call("auth.cancel", { flowId: authFlow.flowId }); setAuthFlow(null); }} />}
		<div className="app-bottomline"><span><i />{t("LOCAL DATA")}</span><span>{snapshot.tasks.filter((task) => task.status === "running").length} {snapshot.tasks.filter((task) => task.status === "running").length === 1 ? t("active agent") : t("active agents")}</span><button onClick={() => setModal("terminal")}>{t("Terminal panel")}</button></div>
	</main>;
}

function sessionTreeDepth(entryId: string, entries: DesktopSessionTree["entries"]): number {
	const byId = new Map<string, DesktopSessionTree["entries"][number]>();
	for (const entry of entries) byId.set(entry.id, entry);
	const visited = new Set([entryId]);
	let current = byId.get(entryId);
	let depth = 0;
	while (current?.parentId && depth < 8 && !visited.has(current.parentId)) {
		visited.add(current.parentId);
		current = byId.get(current.parentId);
		if (current) depth++;
	}
	return depth;
}

function ModalView(props: { modal: Exclude<Modal, null>; snapshot: AppSnapshot; t: Translate; onLanguageChange: (language: Language) => void; onThemeChange: (theme: AppSnapshot["settings"]["theme"]) => void; onSendShortcutChange: (sendShortcut: "enter" | "ctrlEnter") => void; onSettingsSaved: (settings: AppSnapshot["settings"]) => void; catalogKind: CatalogKind; catalogItems: CatalogEntry[]; activeProjectId?: string; activeSessionId?: string; mcpAuthEvent?: McpAuthEvent; onCatalogKindChange: (kind: CatalogKind) => void; onInsertDraft: (text: string) => void; onAppendDraftToSession: (sessionId: string, text: string) => void; onOpenRoles: () => void; onOpenSettings: () => void; onStartOAuth: (providerId: string) => void; authFlowActive: boolean; onClose: () => void; call: AppCall; refresh: () => Promise<void> }) {
	const { modal, snapshot, t, onLanguageChange, onThemeChange, onSendShortcutChange, onSettingsSaved, catalogKind, catalogItems, activeProjectId, activeSessionId, mcpAuthEvent, onCatalogKindChange, onInsertDraft, onAppendDraftToSession, onOpenRoles, onOpenSettings, onStartOAuth, authFlowActive, onClose, call, refresh } = props;
	const [role, setRole] = useState<Role>({ id: "", name: "", description: "", systemPrompt: "", model: "", tools: [], scope: "project" });
	const [roleTools, setRoleTools] = useState("");
	const [theme, setTheme] = useState(snapshot.settings.theme);
	const [defaultModel, setDefaultModel] = useState(snapshot.settings.defaultModel);
	const [language, setLanguage] = useState(snapshot.settings.language);
	const [sendShortcut, setSendShortcut] = useState(snapshot.settings.sendShortcut);
	const [subagentsEnabled, setSubagentsEnabled] = useState(snapshot.settings.subagentsEnabled);
	const [maxParallelTasks, setMaxParallelTasks] = useState(snapshot.settings.maxParallelTasks);
	const [settingsSaving, setSettingsSaving] = useState(false);
	const settingsSaveInFlight = useRef(false);
	const [confirmTools, setConfirmTools] = useState(snapshot.settings.confirmToolCalls);
	const [providerId, setProviderId] = useState(snapshot.providers[0]?.id ?? "");
	const [credential, setCredential] = useState("");
	const [taskRole, setTaskRole] = useState(snapshot.roles[0]?.id ?? "");
	const [taskPrompt, setTaskPrompt] = useState("");
	const [dependencies, setDependencies] = useState<string[]>([]);
	const [terminalCommand, setTerminalCommand] = useState("");
	const [folderPath, setFolderPath] = useState("");
	const [browsingFolder, setBrowsingFolder] = useState(false);
	const [openingFolder, setOpeningFolder] = useState(false);
	const [folderError, setFolderError] = useState<string | null>(null);
	const [sessionStats, setSessionStats] = useState<DesktopSessionStats>();
	const [sessionTree, setSessionTree] = useState<DesktopSessionTree>();
	const [thinkingState, setThinkingState] = useState<DesktopThinkingState>();
	const [compactInstructions, setCompactInstructions] = useState("");
	const [exportFormat, setExportFormat] = useState<"html" | "jsonl">("html");
	const [sessionExportedName, setSessionExportedName] = useState("");
	const [sessionDetailsLoading, setSessionDetailsLoading] = useState(false);
	const [sessionDetailsBusy, setSessionDetailsBusy] = useState(false);
	const [sessionDetailsError, setSessionDetailsError] = useState("");
	const [restoredEditorText, setRestoredEditorText] = useState("");
	const detailsSessionId = useRef(activeSessionId);
	detailsSessionId.current = activeSessionId;
	const sessionIsRunning = snapshot.sessions.find((session) => session.id === activeSessionId)?.status === "running";
	const dialogRef = useRef<HTMLElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const browseFolder = async () => {
		if (browsingFolder) return;
		setBrowsingFolder(true);
		setFolderError(null);
		try {
			const result = await call("project.browse", folderPath.trim() ? { path: folderPath.trim() } : {});
			if (result.ok && result.data.path) setFolderPath(result.data.path);
			else if (!result.ok) setFolderError(result.message);
		} finally { setBrowsingFolder(false); }
	};
	useEffect(() => {
		if (!snapshot.providers.some((provider) => provider.id === providerId)) {
			setProviderId(snapshot.providers[0]?.id ?? "");
		}
	}, [snapshot.providers, providerId]);
	useEffect(() => { setLanguage(snapshot.settings.language); }, [snapshot.settings.language]);
	useEffect(() => { setDefaultModel(snapshot.settings.defaultModel); }, [snapshot.settings.defaultModel]);
	useEffect(() => { setSendShortcut(snapshot.settings.sendShortcut); }, [snapshot.settings.sendShortcut]);
	useEffect(() => { setSubagentsEnabled(snapshot.settings.subagentsEnabled); }, [snapshot.settings.subagentsEnabled]);
	useEffect(() => { setMaxParallelTasks(snapshot.settings.maxParallelTasks); }, [snapshot.settings.maxParallelTasks]);
	useEffect(() => { setConfirmTools(snapshot.settings.confirmToolCalls); }, [snapshot.settings.confirmToolCalls]);
	const title = modal === "settings" ? t("Settings & providers") : modal === "roles" ? t("Agent roles") : modal === "catalog" ? catalogTitle(catalogKind, t) : modal === "mcp" ? t("MCP servers") : modal === "new-task" ? t("Create a task") : modal === "open-project" ? t("Open a project") : modal === "session-details" ? t("Session details") : t("Interactive terminal");
	useEffect(() => {
		if (modal !== "session-details" || !activeSessionId) return;
		let current = true;
		setSessionStats(undefined);
		setSessionTree(undefined);
		setThinkingState(undefined);
		setSessionDetailsError("");
		setRestoredEditorText("");
		setSessionExportedName("");
		setSessionDetailsLoading(true);
		void Promise.all([
			call("session.stats", { sessionId: activeSessionId }),
			call("session.tree", { sessionId: activeSessionId }),
			call("session.thinking.get", { sessionId: activeSessionId }),
		]).then(([stats, tree, thinking]) => {
			if (!current) return;
			if (stats.ok) setSessionStats(stats.data);
			if (tree.ok) setSessionTree(tree.data);
			if (thinking.ok) setThinkingState(thinking.data);
			const failed = [stats, tree, thinking].find((result) => !result.ok);
			if (failed && !failed.ok) setSessionDetailsError(failed.message);
		}).finally(() => { if (current) setSessionDetailsLoading(false); });
		return () => { current = false; };
	}, [modal, activeSessionId, call]);
	useEffect(() => {
		const dialog = dialogRef.current;
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		const focusable = () => dialog?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex="-1"])') ?? [];
		(dialog?.querySelector<HTMLElement>("[autofocus]") ?? focusable()[0] ?? dialog)?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
			if (dialogs.item(dialogs.length - 1) !== dialog) return;
			if (event.key === "Escape") {
				event.preventDefault();
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const controls = [...focusable()];
			if (controls.length === 0) { event.preventDefault(); dialog?.focus(); return; }
			const first = controls[0]!;
			const last = controls.at(-1)!;
			if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			if (previousFocus?.isConnected) previousFocus.focus();
		};
	}, [modal]);
	const run = async (event: FormEvent<HTMLFormElement>, action: () => Promise<unknown>) => { event.preventDefault(); await action(); };
	const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (settingsSaveInFlight.current) return;
		settingsSaveInFlight.current = true;
		setSettingsSaving(true);
		try {
			const result = await call("settings.save", { theme, defaultModel, confirmToolCalls: confirmTools, language, sendShortcut, subagentsEnabled, maxParallelTasks });
			if (result.ok) { onSettingsSaved(result.data); await refresh(); }
		} finally {
			settingsSaveInFlight.current = false;
			setSettingsSaving(false);
		}
	};
	const cloneSession = async () => {
		if (!activeSessionId || sessionDetailsBusy || sessionIsRunning) return;
		const sessionId = activeSessionId;
		setSessionDetailsBusy(true);
		setSessionDetailsError("");
		try {
			const result = await call("session.clone", { sessionId });
			if (!result.ok) { setSessionDetailsError(result.message); return; }
			await refresh();
		} finally { setSessionDetailsBusy(false); }
	};
	const forkSession = async (entryId: string | undefined, position: "before" | "at") => {
		if (!activeSessionId || sessionDetailsBusy || sessionIsRunning) return;
		const sessionId = activeSessionId;
		setSessionDetailsBusy(true);
		setSessionDetailsError("");
		try {
			const result = await call("session.fork", { sessionId, ...(entryId ? { entryId } : {}), position });
			if (!result.ok) { if (detailsSessionId.current === sessionId) setSessionDetailsError(result.message); return; }
			if (result.data.selectedText) onAppendDraftToSession(result.data.id, result.data.selectedText);
			await refresh();
		} finally { setSessionDetailsBusy(false); }
	};
	const navigateSessionTree = async (entryId: string) => {
		if (!activeSessionId || sessionDetailsBusy || snapshot.sessions.find((session) => session.id === activeSessionId)?.status === "running") return;
		const sessionId = activeSessionId;
		setSessionDetailsBusy(true);
		setSessionDetailsError("");
		try {
			const result = await call("session.navigate", { sessionId, entryId });
			if (!result.ok) { setSessionDetailsError(result.message); return; }
			if (!result.data.navigated || detailsSessionId.current !== sessionId) return;
			if (result.data.editorText) setRestoredEditorText(result.data.editorText);
			await refresh();
			const tree = await call("session.tree", { sessionId });
			if (tree.ok && detailsSessionId.current === sessionId) setSessionTree(tree.data);
			else if (!tree.ok && detailsSessionId.current === sessionId) setSessionDetailsError(tree.message);
		} finally { setSessionDetailsBusy(false); }
	};
	const setSessionThinking = async (level: DesktopThinkingState["level"]) => {
		if (!activeSessionId || sessionDetailsBusy || snapshot.sessions.find((session) => session.id === activeSessionId)?.status === "running") return;
		const sessionId = activeSessionId;
		setSessionDetailsBusy(true);
		setSessionDetailsError("");
		try {
			const result = await call("session.thinking.set", { sessionId, level });
			if (!result.ok) setSessionDetailsError(result.message);
			else if (detailsSessionId.current === sessionId) setThinkingState(result.data);
		} finally { setSessionDetailsBusy(false); }
	};
	const reloadSessionResources = async () => {
		if (!activeSessionId || sessionDetailsBusy || snapshot.sessions.find((session) => session.id === activeSessionId)?.status === "running") return;
		const sessionId = activeSessionId;
		setSessionDetailsBusy(true);
		setSessionDetailsError("");
		try {
			const result = await call("session.reload", { sessionId });
			if (!result.ok) setSessionDetailsError(result.message);
			else if (detailsSessionId.current === sessionId) await refresh();
		} finally { setSessionDetailsBusy(false); }
	};
	const compactSession = async () => {
		if (!activeSessionId || sessionDetailsBusy || snapshot.sessions.find((session) => session.id === activeSessionId)?.status === "running") return;
		const sessionId = activeSessionId;
		setSessionDetailsBusy(true);
		setSessionDetailsError("");
		try {
			const result = await call("session.compact", { sessionId, ...(compactInstructions.trim() ? { instructions: compactInstructions.trim() } : {}) });
			if (!result.ok) setSessionDetailsError(result.message);
			else if (detailsSessionId.current === sessionId) {
				setCompactInstructions("");
				await refresh();
			}
		} finally { setSessionDetailsBusy(false); }
	};
	const exportSession = async () => {
		if (!activeSessionId || sessionDetailsBusy || sessionIsRunning) return;
		const sessionId = activeSessionId;
		setSessionDetailsBusy(true);
		setSessionDetailsError("");
		setSessionExportedName("");
		try {
			const result = await call("session.export", { sessionId, format: exportFormat });
			if (!result.ok) setSessionDetailsError(result.message);
			else if (result.data.exported && result.data.path && detailsSessionId.current === sessionId)
				setSessionExportedName(result.data.path.split(/[\\/]/).pop() || t("Session exported."));
		} finally { setSessionDetailsBusy(false); }
	};
	return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} tabIndex={-1} className={`modal modal-${modal}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><header className="modal-head"><div><span className="eyebrow">PI ORBIT</span><h2 id="modal-title">{title}</h2></div><button className="icon-button" aria-label={t("Close dialog")} onClick={onClose}>×</button></header>
		{modal === "mcp" && <McpPanel sessionId={activeSessionId} servers={snapshot.mcpServers ?? []} authEvent={mcpAuthEvent} call={call} t={t} />}
		{modal === "session-details" && <div className="modal-content session-details-content">
			{!activeSessionId ? <p className="empty-hint">{t("Select a session to view its details.")}</p> : <>
				<div className="session-detail-actions"><button className="outline-button" disabled={sessionDetailsBusy || sessionIsRunning} onClick={() => void forkSession(sessionTree?.leafId ?? undefined, "at")}>{t("Fork session")}</button><button className="outline-button" disabled={sessionDetailsBusy || sessionIsRunning} onClick={() => void cloneSession()}>{t("Clone session")}</button><button className="outline-button" disabled={sessionDetailsBusy || sessionIsRunning} onClick={() => void reloadSessionResources()}>{t("Reload Pi resources")}</button><label className="session-export-format">{t("Export format")}<select value={exportFormat} disabled={sessionDetailsBusy || sessionIsRunning} onChange={(event) => setExportFormat(event.target.value as "html" | "jsonl")}><option value="html">HTML</option><option value="jsonl">JSONL</option></select></label><button className="outline-button" disabled={sessionDetailsBusy || sessionIsRunning} onClick={() => void exportSession()}>{t("Export session")}</button></div>{sessionExportedName && <p className="session-export-success" role="status">{t("Session exported.")} {sessionExportedName}</p>}
				{sessionIsRunning && <p className="inline-diagnostic">{t("Session controls are unavailable while it is running.")}</p>}
				{sessionDetailsError && <div className="inline-diagnostic" role="alert">{sessionDetailsError}</div>}
				<section className="session-detail-section"><h3>{t("Session statistics")}</h3>{sessionDetailsLoading && !sessionStats ? <p className="empty-hint">{t("Loading session details…")}</p> : sessionStats ? <div className="session-stats-grid"><span>{t("Messages")}<b>{sessionStats.totalMessages.toLocaleString()}</b></span><span>{t("User messages")}<b>{sessionStats.userMessages.toLocaleString()}</b></span><span>{t("Assistant messages")}<b>{sessionStats.assistantMessages.toLocaleString()}</b></span><span>{t("Tool calls")}<b>{sessionStats.toolCalls.toLocaleString()}</b></span><span>{t("Input tokens")}<b>{sessionStats.tokens.input.toLocaleString()}</b></span><span>{t("Output tokens")}<b>{sessionStats.tokens.output.toLocaleString()}</b></span><span>{t("Cache read / write")}<b>{sessionStats.tokens.cacheRead.toLocaleString()} / {sessionStats.tokens.cacheWrite.toLocaleString()}</b></span><span>{t("Total tokens")}<b>{sessionStats.tokens.total.toLocaleString()}</b></span><span>{t("Estimated cost")}<b>${sessionStats.cost.toFixed(4)}</b></span></div> : <p className="empty-hint">{t("Session statistics are unavailable.")}</p>}</section>
				<section className="session-detail-section"><h3>{t("Thinking level")}</h3>{thinkingState ? <label>{t("Thinking level")}<select value={thinkingState.level} disabled={sessionDetailsBusy || sessionIsRunning} onChange={(event) => void setSessionThinking(event.target.value as DesktopThinkingState["level"])}>{thinkingState.availableLevels.map((level) => <option value={level} key={level}>{t(level)}</option>)}</select></label> : <p className="empty-hint">{t("Thinking settings are unavailable.")}</p>}</section>
				<section className="session-detail-section"><div className="session-tree-heading"><h3>{t("Conversation branches")}</h3>{sessionTree && <small>{sessionTree.entries.length} {t("entries")}</small>}</div>{sessionTree?.entries.length ? <div className="session-tree" role="group" aria-label={t("Conversation branches")}>{sessionTree.entries.map((entry) => <div className="session-tree-entry-row" key={entry.id}><button type="button" aria-current={sessionTree.leafId === entry.id ? "step" : undefined} className={`session-tree-entry ${sessionTree.leafId === entry.id ? "session-tree-current" : ""}`} style={{ paddingLeft: `${9 + sessionTreeDepth(entry.id, sessionTree.entries) * 14}px` }} disabled={sessionDetailsBusy || sessionIsRunning} onClick={() => void navigateSessionTree(entry.id)}><span className="session-tree-type">{t(entry.type)}</span><span className="session-tree-label">{entry.label}</span>{entry.role && <small>{entry.role}</small>}</button><button type="button" className="session-tree-fork" aria-label={`${t("Fork from here")}: ${entry.label}`} disabled={sessionDetailsBusy || sessionIsRunning} onClick={() => void forkSession(entry.id, "before")}>{t("Fork from here")}</button></div>)}</div> : <p className="empty-hint">{sessionDetailsLoading ? t("Loading session details…") : t("No conversation branches available.")}</p>}</section>{restoredEditorText && <div className="restored-editor-text"><p>{t("A draft was restored from this branch.")}</p><button className="text-button" onClick={() => { onInsertDraft(restoredEditorText); setRestoredEditorText(""); }}>{t("Append restored text to draft")}</button></div>}
				<form className="session-compact-form" onSubmit={(event) => void run(event, compactSession)}><label>{t("Compact session")}<textarea maxLength={20_000} rows={3} value={compactInstructions} disabled={sessionDetailsBusy || sessionIsRunning} onChange={(event) => setCompactInstructions(event.target.value)} placeholder={t("Optional compaction instructions")}/></label><button className="outline-button" disabled={sessionDetailsBusy || sessionIsRunning}>{t(sessionDetailsBusy ? "Working…" : "Compact")}</button></form>
			</>}
		</div>}
		{modal === "settings" && <div className="modal-content settings-content">
			<div className="setting-section"><h3>{t("Preferences")}</h3><p>{t("Customize the language, message shortcut, appearance, and default model for this workspace.")}</p>
				<form className="settings-form" onSubmit={(event) => void saveSettings(event)}>
					<label>{t("Language")}<select value={language} disabled={settingsSaving} onChange={(event) => { const value = event.target.value as Language; setLanguage(value); onLanguageChange(value); }}><option value="en">{t("English")}</option><option value="zh-CN">{t("简体中文")}</option></select></label>
					<label>{t("Send shortcut")}<select value={sendShortcut} disabled={settingsSaving} onChange={(event) => { const value = event.target.value as "enter" | "ctrlEnter"; setSendShortcut(value); onSendShortcutChange(value); }}><option value="enter">{t("Enter to send")}</option><option value="ctrlEnter">{t("Ctrl+↵ / ⌘+↵ to send")}</option></select></label><label className="check-setting"><input type="checkbox" checked={subagentsEnabled} disabled={settingsSaving} onChange={(event) => setSubagentsEnabled(event.target.checked)} />{t("Enable subagents")}</label><label className="check-setting"><input type="checkbox" checked={confirmTools} disabled={settingsSaving} onChange={(event) => setConfirmTools(event.target.checked)} />{t("Confirm tool calls before running")}</label><label>{t("Maximum parallel tasks")}<select value={maxParallelTasks} disabled={settingsSaving || !subagentsEnabled} onChange={(event) => setMaxParallelTasks(Number(event.target.value))}>{[1, 2, 3, 4].map((count) => <option value={count} key={count}>{count}</option>)}</select><small>{t("Tasks per project running at the same time.")}</small></label>
					<label>{t("Appearance")}<select value={theme} disabled={settingsSaving} onChange={(event) => { const value = event.target.value as typeof theme; setTheme(value); onThemeChange(value); }}><option value="system">{t("System theme")}</option><option value="dark">{t("Dark")}</option><option value="light">{t("Light")}</option></select></label>
					<label>{t("Default model")}<select value={defaultModel} disabled={settingsSaving} onChange={(event) => setDefaultModel(event.target.value)}><option value="">{t("No default")}</option>{snapshot.providers.flatMap((provider) => provider.models.map((model) => <option value={model} key={`${provider.id}:${model}`}>{model}</option>))}</select></label>
					<button className="primary-action" disabled={settingsSaving}>{t(settingsSaving ? "Working…" : "Save preferences")}</button>
				</form>
			</div>
			<div className="setting-section"><CustomProviderPanel providers={snapshot.providers} t={t} call={call} refresh={refresh} /></div>
			<div className="setting-section"><h3>{t("Model providers")}</h3><p>{t("API keys are entered here, passed to Pi through the protected desktop bridge, and stored in Pi’s local credential store. The key is cleared from this form after saving.")}</p>
				{snapshot.providers.length === 0 && <div className="inline-diagnostic">{t("No providers were returned. Check Pi’s installed provider configuration and reopen Settings.")}</div>}
				{snapshot.providers.map((provider) => <div className="provider-row" key={provider.id}><div><b>{provider.name}</b><small>{t(provider.configured ? "Credential configured" : "Needs authentication")}</small></div><span className={provider.configured ? "configured-tag" : "missing-tag"}>{t(provider.configured ? "Connected" : "Not connected")}</span>{provider.oauthLogin && <button className="text-button" disabled={authFlowActive} onClick={() => onStartOAuth(provider.id)}>{t("Sign in")}</button>}{provider.configured && <button className="text-button" onClick={() => void call(provider.credentialType === "oauth" ? "auth.logout" : "auth.clear", { providerId: provider.id }).then((result) => { if (result.ok) void refresh(); })}>{t(provider.credentialType === "oauth" ? "Log out" : "Clear")}</button>}</div>)}
				<form className="credential-form" onSubmit={(event) => void run(event, async () => { const result = await call("auth.configure", { providerId, credential }); if (result.ok) { setCredential(""); await refresh(); } })}><label>{t("Provider")}<select required value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="" disabled>{t("Select provider")}</option>{snapshot.providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select></label><label>{t("API key")}<input type="password" autoComplete="off" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder={t("Paste API key")} /></label><button className="primary-action" disabled={!providerId || !credential}>{t("Save credential")}</button></form>
			</div><CapabilityList capabilities={snapshot.capabilities} call={call} t={t} />
		</div>}
		{modal === "roles" && <div className="modal-content role-content"><div className="role-list">{snapshot.roles.map((item) => <button className={`role-list-item ${role.id === item.id ? "role-active" : ""}`} key={item.id} onClick={() => { setRole(item); setRoleTools(item.tools.join(", ")); }}><span className="role-avatar">{item.name.slice(0, 1).toUpperCase()}</span><span><b>{item.name}</b><small>{t(item.scope)} {t("role")} · {item.model || t("default model")}</small></span><span className="role-arrow">›</span></button>)}{snapshot.roles.length === 0 && <p className="empty-hint">{t("No role definitions are available yet. Create a role for the task scheduler.")}</p>}<button className="outline-button full-button" onClick={() => { setRole({ id: "", name: "", description: "", systemPrompt: "", model: snapshot.settings.defaultModel, tools: [], scope: activeProjectId ? "project" : "user" }); setRoleTools(""); }}>＋ {t("New role")}</button></div><form className="role-editor" onSubmit={(event) => void run(event, async () => { const value = { ...role, id: role.id || slug(role.name), tools: roleTools.split(",").map((tool) => tool.trim()).filter(Boolean) }; const result = await call("role.save", value); if (result.ok) { setRole(result.data); await refresh(); } })}><label>{t("Role name")}<input required value={role.name} onChange={(event) => setRole({ ...role, name: event.target.value })} placeholder={t("Code reviewer")} /></label><label>{t("Short description")}<input value={role.description} onChange={(event) => setRole({ ...role, description: event.target.value })} placeholder={t("Reviews changes for correctness and regressions")} /></label><label>{t("Markdown system prompt")}<textarea rows={7} value={role.systemPrompt} onChange={(event) => setRole({ ...role, systemPrompt: event.target.value })} placeholder={t("# Role\nYou are a careful code reviewer…")} /></label><label>{t("Model")}<select value={role.model} onChange={(event) => setRole({ ...role, model: event.target.value })}><option value="">{t("Use default model")}</option>{snapshot.providers.flatMap((provider) => provider.models.map((model) => <option value={model} key={`${provider.id}:${model}`}>{model}</option>))}</select></label><label>{t("Allowed tools")}<input value={roleTools} onChange={(event) => setRoleTools(event.target.value)} placeholder={t("read, edit, bash")} /><small>{t("Comma separated tool names.")}</small></label><label>{t("Definition scope")}<select value={role.scope} onChange={(event) => setRole({ ...role, scope: event.target.value as Role["scope"] })}><option value="project">{t("Project")}</option><option value="user">{t("User")}</option></select></label><button className="primary-action">{t("Save role")}</button></form></div>}
		{modal === "catalog" && <div className="modal-content catalog-content"><nav className="catalog-tabs" aria-label={t("Library category")}>{(["skills", "templates", "commands", "extensions"] as CatalogKind[]).map((kind) => <button type="button" className={kind === catalogKind ? "catalog-tab-active" : ""} onClick={() => onCatalogKindChange(kind)} key={kind}>{catalogTitle(kind, t)}</button>)}</nav><div className="catalog-diagnostic"><span>i</span><p>{t(catalogKind === "extensions" ? "Extensions are listed as sources. Run supported extension commands from Commands; terminal-only interfaces need a desktop adapter." : "Select or create a conversation session to use these items. Skills and templates insert into its draft; extension commands run in it.")}</p></div>{catalogItems.length === 0 ? <div className="empty-catalog"><div>✳</div><b>{language === "zh-CN" ? `暂无${catalogTitle(catalogKind, t)}` : `No ${catalogTitle(catalogKind, t).toLowerCase()} found`}</b><p>{t("Items are loaded from the active Pi configuration. Add them to your Pi user or project folder.")}</p></div> : <div className="catalog-list">{catalogItems.map((item) => <CatalogRow key={item.id} item={item} kind={catalogKind} disabled={!activeSessionId} t={t} onRun={async () => { const result = await call("catalog.run", { kind: catalogKind.slice(0, -1) as "skill" | "template" | "command" | "extension", id: item.id }); if (result.ok) { if (result.data.insertedText) { onInsertDraft(result.data.insertedText); onClose(); } else if (result.data.started) onClose(); } }} />)}</div>}</div>}
		{modal === "open-project" && <div className="modal-content task-create-content"><form onSubmit={(event) => void run(event, async () => {
			if (!folderPath.trim() || openingFolder || browsingFolder) return;
			setOpeningFolder(true);
			setFolderError(null);
			try {
				const result = await call("project.open", { path: folderPath.trim() });
				if (!result.ok) { setFolderError(result.message); return; }
				const session = await call("session.create", { projectId: result.data.id });
				await refresh();
				if (session.ok) onClose();
				else setFolderError(session.message);
			} finally { setOpeningFolder(false); }
		})}><p className="modal-intro">{t("Choose a local repository folder. Pi Orbit keeps its sessions and tasks on this device.")}</p><button type="button" className="outline-button" disabled={browsingFolder || openingFolder} onClick={() => void browseFolder()}>{t(browsingFolder ? "Opening folder picker…" : "Browse folders…")}</button><label>{t("Folder path")}<input autoFocus required value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder={t("Select a folder or enter its path")} /></label>{folderError && <div className="inline-diagnostic" role="alert">{t(folderError)}</div>}<div className="modal-footer"><button type="button" className="outline-button" onClick={onClose}>{t("Cancel")}</button><button className="primary-action" disabled={!folderPath.trim() || browsingFolder || openingFolder}>{t("Open folder")}</button></div></form></div>}
		{modal === "new-task" && <div className="modal-content task-create-content"><form onSubmit={(event) => void run(event, async () => { if (taskPrompt.trim() && activeProjectId && snapshot.settings.subagentsEnabled) { const result = await call("task.create", { projectId: activeProjectId, roleId: taskRole, prompt: taskPrompt.trim(), dependsOn: dependencies }); if (result.ok) { await refresh(); onClose(); } } })}>{!activeProjectId ? <><p className="modal-intro">{t("Open a project before creating a task.")}</p><button type="button" className="outline-button" onClick={() => { onClose(); }}>{t("Close")}</button></> : !snapshot.settings.subagentsEnabled ? <><p className="modal-intro">{t("Subagents are disabled. Enable them in Settings to create or resume tasks.")}</p><button type="button" className="outline-button" onClick={onOpenSettings}>{t("Enable subagents in Settings")}</button></> : <><p className="modal-intro">{t("The new agent runs in an isolated worktree and reports changes here for review.")}</p><label>{t("Role")}<select required value={taskRole} onChange={(event) => setTaskRole(event.target.value)}><option value="" disabled>{t("Select a role")}</option>{snapshot.roles.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model || t("default model")}</option>)}</select></label>{snapshot.roles.length === 0 && <div className="inline-diagnostic">{t("Create an agent role before dispatching a task.")} <button className="text-button" type="button" onClick={onOpenRoles}>{t("Manage roles")}</button></div>}<label>{t("Task instructions")}<textarea required rows={5} value={taskPrompt} onChange={(event) => setTaskPrompt(event.target.value)} placeholder={t("Implement the settings screen and add focused tests…")} /></label><label>{t("Wait for tasks")}<select multiple value={dependencies} onChange={(event) => setDependencies(Array.from(event.target.selectedOptions, (option) => option.value))}>{snapshot.tasks.filter((task) => task.projectId === activeProjectId && !["failed", "cancelled"].includes(task.status)).map((task) => <option value={task.id} key={task.id}>{task.roleName}: {truncate(task.prompt, 48)}</option>)}</select><small>{t("Leave empty to run immediately. Failed prerequisites stop dependent tasks.")}</small></label><div className="form-note"><span>◈</span>{t("Up to")} {snapshot.settings.maxParallelTasks} {t("tasks can run at once per project.")}</div><div className="modal-footer"><button type="button" className="outline-button" onClick={onClose}>{t("Cancel")}</button><button className="primary-action" disabled={!taskPrompt.trim() || !taskRole}>{t("Create task")} <span>→</span></button></div></>}</form></div>}
				{modal === "terminal" && <div className="terminal-content"><div className="terminal-toolbar"><span className="terminal-leds"><i /><i /><i /></span><span>{snapshot.terminal?.title ?? t("Project terminal")}</span><span className={`task-status status-${snapshot.terminal?.state === "running" ? "running" : "queued"}`}>{snapshot.terminal?.state ? t(snapshot.terminal.state) : t("not started")}</span>{snapshot.terminal && <button className="text-button" onClick={() => void call("terminal.stop", { terminalId: snapshot.terminal!.id })}>{t("Stop")}</button>}</div><TerminalPane output={snapshot.terminal?.output ?? ""} outputOffset={snapshot.terminal?.outputOffset ?? 0} terminalId={snapshot.terminal?.id} running={snapshot.terminal?.state === "running"} t={t} onInput={(text) => { if (snapshot.terminal?.id) void call("terminal.input", { terminalId: snapshot.terminal.id, text }); }} onResize={(cols, rows) => { if (snapshot.terminal?.id) void call("terminal.resize", { terminalId: snapshot.terminal.id, cols, rows }); }} /><form className="terminal-start" onSubmit={(event) => void run(event, async () => { if (!activeProjectId) return; const result = await call("terminal.start", { projectId: activeProjectId, command: terminalCommand || undefined }); if (result.ok) await refresh(); })}><label>{t("Start with command")}<input value={terminalCommand} onChange={(event) => setTerminalCommand(event.target.value)} placeholder={t("Leave blank for the project shell")} /></label><button className="primary-action" disabled={!activeProjectId || Boolean(snapshot.terminal?.state === "running")}>{t("Start")}</button></form></div>}
	</section></div>;
}

type AppCall = <K extends Command>(command: K, payload: CommandMap[K]["payload"]) => Promise<Result<CommandMap[K]["data"]>>;
function AuthFlowDialog({ event, t, call, onClose }: { event: AuthFlowEvent; t: Translate; call: AppCall; onClose: () => void }) {
	const [value, setValue] = useState("");
	const [submitted, setSubmitted] = useState(false);
	const prompt = event.type === "prompt" ? event.prompt : undefined;
	const isTerminal = event.type === "complete" || event.type === "failed" || event.type === "cancelled";
	const submit = async (formEvent: FormEvent<HTMLFormElement>) => {
		formEvent.preventDefault();
		if (event.type !== "prompt") return;
		const submitted = value;
		setValue("");
		setSubmitted(true);
		const result = await call("auth.respond", { flowId: event.flowId, promptId: event.promptId, value: submitted });
		if (!result.ok) setSubmitted(false);
	};
	return <div className="modal-backdrop auth-backdrop"><section className="modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title"><header className="modal-head"><div><span className="eyebrow">PI ORBIT</span><h2 id="auth-modal-title">{t("Provider sign-in")}</h2></div></header><div className="modal-content auth-content">
		{event.type === "started" && <p>{t("Starting provider sign-in…")}</p>}
		{event.type === "progress" && <p>{event.message}</p>}
		{event.type === "info" && <><p>{event.message}</p>{event.links?.map((link) => <div className="auth-link-row" key={link.url}><span>{link.label ?? link.url}</span><button className="text-button" type="button" onClick={() => void call("auth.open-url", { url: link.url })}>{t("Open link")}</button></div>)}</>}
		{event.type === "auth_url" && <><p>{event.instructions ?? t("Continue in your browser to authorize this provider.")}</p><div className="auth-code-value">{event.url}</div><button className="outline-button" type="button" onClick={() => void call("auth.open-url", { url: event.url })}>{t("Open sign-in page")}</button></>}
		{event.type === "device_code" && <><p>{t("Open the verification page and enter this code.")}</p><div className="auth-link-row"><span>{event.verificationUri}</span><button className="text-button" type="button" onClick={() => void call("auth.open-url", { url: event.verificationUri })}>{t("Open page")}</button></div><div className="auth-code-value">{event.userCode}</div></>}
		{event.type === "prompt" && prompt && <form className="auth-prompt-form" onSubmit={(formEvent) => void submit(formEvent)}><p>{prompt.message}</p>{submitted ? <p>{t("Waiting for provider…")}</p> : <>{prompt.type === "select" ? <select autoFocus required value={value} onChange={(inputEvent) => setValue(inputEvent.target.value)}><option value="" disabled>{t("Choose an option")}</option>{prompt.options.map((option) => <option key={option.id} value={option.id}>{option.label}{option.description ? ` — ${option.description}` : ""}</option>)}</select> : prompt.type === "manual_code" ? <textarea autoFocus rows={3} value={value} onChange={(inputEvent) => setValue(inputEvent.target.value)} placeholder={prompt.placeholder ?? t("Paste the authorization code or redirect URL")} /> : <input autoFocus type={prompt.type === "secret" ? "password" : "text"} autoComplete="off" value={value} onChange={(inputEvent) => setValue(inputEvent.target.value)} placeholder={prompt.placeholder} />}<button className="primary-action" disabled={!value.trim()}>{t("Continue")}</button></>}</form>}
		{event.type === "complete" && <p>{t("Provider sign-in complete.")}</p>}
		{event.type === "failed" && <p className="auth-error">{event.message}</p>}
		{event.type === "cancelled" && <p>{t("Provider sign-in cancelled.")}</p>}
		<div className="modal-footer"><button type="button" className="outline-button" onClick={onClose}>{t(isTerminal ? "Close" : "Cancel sign-in")}</button></div>
	</div></section></div>;
}
function CapabilityList({ capabilities, call, t }: { capabilities: AppSnapshot["capabilities"]; call: AppCall; t: Translate }) { return <div className="setting-section"><h3>{t("Pi capabilities")}</h3><div className="capability-grid">{Object.entries(capabilities).map(([name, capability]) => <div className="capability-row" key={name}><span className={capability.available ? "green-dot" : "amber-dot"} /><span><b>{name}</b><small>{capability.available ? t("Available") : capability.diagnostic ?? t("Not available")}</small></span>{!capability.available && <button className="text-button" onClick={() => void call("capability.open", { capability: name })}>{t("Details")}</button>}</div>)}</div></div>; }
function TerminalPane({ output, outputOffset, terminalId, running, onInput, onResize, t }: { output: string; outputOffset: number; terminalId?: string; running: boolean; onInput: (text: string) => void; onResize: (cols: number, rows: number) => void; t: Translate }) {
	const hostRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const outputCursor = useRef(0);
	const terminalIdRef = useRef<string | undefined>(terminalId);
	const runningRef = useRef(running);
	const inputHandler = useRef(onInput);
	const resizeHandler = useRef(onResize);
	inputHandler.current = onInput;
	resizeHandler.current = onResize;
	runningRef.current = running;
	useEffect(() => {
		const terminal = new Terminal({ cursorBlink: true, fontFamily: "'Cascadia Code', 'SFMono-Regular', Consolas, monospace", fontSize: 12, theme: { background: "#111316", foreground: "#d6d9de", cursor: "#b7a1ff", selectionBackground: "#453b64" } });
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		if (hostRef.current) terminal.open(hostRef.current);
		terminalRef.current = terminal;
		const input = terminal.onData((text) => { if (runningRef.current) inputHandler.current(text); });
		const resize = terminal.onResize(({ cols, rows }) => { if (runningRef.current) resizeHandler.current(cols, rows); });
		const observer = new ResizeObserver(() => fit.fit());
		if (hostRef.current) observer.observe(hostRef.current);
		fit.fit();
		return () => { observer.disconnect(); input.dispose(); resize.dispose(); terminal.dispose(); terminalRef.current = null; };
	}, []);
	useEffect(() => {
		if (!terminalRef.current) return;
		if (terminalIdRef.current !== terminalId) {
			terminalIdRef.current = terminalId;
			outputCursor.current = 0;
			terminalRef.current.reset();
		}
		const update = terminalOutputDelta({ output, outputOffset }, outputCursor.current);
		if (update.reset) terminalRef.current.reset();
		if (update.text) terminalRef.current.write(update.text);
		outputCursor.current = update.cursor;
	}, [output, outputOffset, terminalId]);
	return <div className="terminal-screen"><div className="terminal-xterm" ref={hostRef} role="application" aria-label={t("Interactive project terminal")} />{!running && !output && <div className="terminal-placeholder">{t("Start a shell to use terminal applications such as vim and htop.")}</div>}</div>;
}
function CatalogRow({ item, kind, disabled, onRun, t }: { item: CatalogEntry; kind: CatalogKind; disabled: boolean; onRun: () => void; t: Translate }) {
	const isExtension = kind === "extensions";
	return <article className="catalog-row">
		<div className="catalog-item-icon">{kind === "skills" ? "✳" : kind === "templates" ? "▤" : kind === "commands" ? "⌘" : "⬡"}</div>
		<div className="catalog-item-main"><b>{item.name}</b><p>{item.description || `${t("From ")}${item.source}`}</p><small>{item.source}</small>
			{!isExtension && <small className="catalog-config-guidance">{t("Availability is managed in the Pi configuration from this source.")}</small>}
		</div>
		{isExtension ? <span className="catalog-config-guidance">{t("Run a command from Commands")}</span> : <button className="outline-button small-button" disabled={disabled} onClick={onRun}>{t(kind === "commands" ? "Run" : "Insert")}</button>}
	</article>;
}
function ExtensionUiPanel({ state, onUseEditorText, t }: { state?: ExtensionUiState; onUseEditorText: (text: string) => void; t: Translate }) {
	if (!state) return null;
	const statuses = Object.entries(state.status);
	const widgets = Object.entries(state.widgets);
	const hasContent = statuses.length > 0 || (state.workingVisible && Boolean(state.workingMessage || state.workingIndicator)) || Boolean(state.hiddenThinkingLabel) || widgets.length > 0 || Boolean(state.editorText) || state.toolsExpanded;
	if (!hasContent) return null;
	return <section className="extension-ui-panel" aria-label={t("Extension interface")}>
		<div className="extension-ui-heading"><span className="eyebrow">{t("EXTENSION INTERFACE")}</span>{state.toolsExpanded && <span className="extension-ui-chip">{t("Tools expanded")}</span>}</div>
		{statuses.map(([key, value]) => <div className="extension-status-row" key={key}><b>{key}</b><span>{value}</span></div>)}
		{state.workingVisible && (state.workingMessage || state.workingIndicator) && <div className="extension-working"><span className="live-dot" /><span>{state.workingMessage || formatExtensionValue(state.workingIndicator)}</span></div>}
		{state.hiddenThinkingLabel && <div className="extension-working-label">{state.hiddenThinkingLabel}</div>}
		{widgets.map(([key, widget]) => <div className="extension-widget" key={key}><b>{key}</b><pre>{formatExtensionValue(widget.content)}</pre></div>)}
		{state.editorText !== undefined && <div className="extension-widget"><div className="extension-widget-head"><b>{t("Extension editor")}</b><button className="text-button" onClick={() => onUseEditorText(state.editorText ?? "")}>{t("Use in composer")}</button></div><pre>{state.editorText || t("(empty)")}</pre></div>}
	</section>;
}
function ExtensionDialog({ request, onSubmit, onCancel, t }: { request: { id: string; extensionId: string; title: string; message?: string; kind: "text" | "confirm" | "select" | "editor"; options?: string[]; placeholder?: string }; onSubmit: (value: unknown) => void; onCancel: (value: unknown) => void; t: Translate }) { const [value, setValue] = useState(request.kind === "editor" ? request.message ?? "" : ""); return <div className="modal-backdrop extension-backdrop"><section className="modal extension-modal" role="dialog" aria-modal="true" aria-labelledby="extension-title"><header className="modal-head"><div><span className="eyebrow">{t("Extension")} · {request.extensionId}</span><h2 id="extension-title">{request.title}</h2></div></header>{request.message && request.kind !== "editor" && <p className="modal-intro">{request.message}</p>}{request.kind === "text" && <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder={request.placeholder} />}{request.kind === "editor" && <textarea className="extension-editor" aria-label={`${request.title} editor`} autoFocus rows={10} value={value} onChange={(event) => setValue(event.target.value)} placeholder={request.placeholder ?? t("Enter text…")} />}{request.kind === "select" && <select autoFocus value={value} onChange={(event) => setValue(event.target.value)}><option value="" disabled>{t("Select an option")}</option>{request.options?.map((option) => <option key={option}>{option}</option>)}</select>}<div className="modal-footer"><button className="outline-button" onClick={() => onCancel(request.kind === "confirm" ? false : null)}>{request.kind === "confirm" ? t("No") : t("Cancel")}</button><button className="primary-action" onClick={() => onSubmit(request.kind === "confirm" ? true : value)}>{request.kind === "confirm" ? t("Yes") : t("Continue")}</button></div></section></div>; }
function statusLabel(status: Task["status"], t: Translate) { return t(({ queued: "Queued", running: "Running", paused: "Paused", review: "Needs review", completed: "Completed", failed: "Failed", cancelled: "Cancelled", merged: "Merged" })[status]); }
function catalogTitle(kind: CatalogKind, t: Translate) { return t(kind.charAt(0).toUpperCase() + kind.slice(1)); }
function slug(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || `role-${Date.now()}`; }
function truncate(value: string, size: number) { return value.length > size ? `${value.slice(0, size - 1)}…` : value; }
function formatTime(value: string, language: Language) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "" : date.toLocaleTimeString(language, { hour: "numeric", minute: "2-digit" }); }
function relativeTime(value: string, language: Language) { const time = new Date(value).valueOf(); if (Number.isNaN(time)) return ""; const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000)); if (language === "zh-CN") return minutes < 1 ? "刚刚" : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`; return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`; }
function formatExtensionValue(value: unknown) { if (typeof value === "string") return value; try { return JSON.stringify(value); } catch { return String(value); } }
function translateDiagnostic(message: string, t: Translate) {
	const mergePrefix = "Merge needs attention: ";
	return message.startsWith(mergePrefix) ? `${t(mergePrefix)}${message.slice(mergePrefix.length)}` : t(message);
}

export default App;
