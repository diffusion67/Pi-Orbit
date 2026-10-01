import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AppSnapshot, AuthFlowEvent, CatalogEntry, Command, CommandMap, DesktopAttachment, DesktopEvent, ExtensionUiState, McpAuthEvent, Result, Role, Task } from "./contract";
import { createTranslator, type Language, type Translate } from "./i18n";
import { AttachmentBudget, MAX_ATTACHMENT_BYTES } from "../../src/shared/attachments.ts";
import { McpPanel } from "./McpPanel";

type CatalogKind = "skills" | "templates" | "commands" | "extensions";
type Modal = "settings" | "roles" | "catalog" | "mcp" | "new-task" | "open-project" | "terminal" | null;
const emptySnapshot: AppSnapshot = {
	lastEventSeq: 0,
	projects: [],
	sessions: [],
	messages: [],
	tasks: [],
	roles: [],
	catalog: { skills: [], templates: [], commands: [], extensions: [] },
	providers: [],
	mcpServers: [],
	extensionUi: {},
	settings: { theme: "system", defaultModel: "", confirmToolCalls: true, language: "en", sendShortcut: "enter" },
	features: { terminal: false, desktopExtensions: false },
	capabilities: {},
};

const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const textFileExtensions = new Set([
	".txt", ".md", ".markdown", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".csv", ".tsv", ".log",
	".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".xml", ".py", ".rs", ".go", ".java", ".c", ".h",
	".cpp", ".hpp", ".cs", ".php", ".rb", ".sh", ".sql", ".env", ".diff", ".patch", ".ini", ".conf",
]);

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
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [attachments, setAttachments] = useState<DesktopAttachment[]>([]);
	const [sessionDelivery, setSessionDelivery] = useState<"steer" | "followUp">("steer");
	const [projectPath, setProjectPath] = useState("");
	const [eventRequest, setEventRequest] = useState<Extract<DesktopEvent, { type: "extension.request" }> | null>(null);
	const [authFlow, setAuthFlow] = useState<AuthFlowEvent | null>(null);
	const [mcpAuthEvent, setMcpAuthEvent] = useState<McpAuthEvent>();
	const transcriptRef = useRef<HTMLDivElement>(null);
	const attachmentInputRef = useRef<HTMLInputElement>(null);
	const attachmentsRef = useRef<DesktopAttachment[]>([]);
	const attachmentBudgetRef = useRef(new AttachmentBudget());
	const syncedExtensionEditors = useRef(new Map<string, string>());
	const dismissedAuthFlows = useRef(new Set<string>());
	const lastEventSeq = useRef(0);
	const activeProject = snapshot.projects.find((project) => project.id === snapshot.activeProjectId);
	const activeSession = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId);
	const sessionExtensionUi = activeSession ? snapshot.extensionUi[`session:${activeSession.id}`] : undefined;
	const projectTasks = snapshot.tasks.filter((task) => task.projectId === snapshot.activeProjectId);
	const activeTask = projectTasks.find((task) => task.id === selectedTaskId) ?? projectTasks.find((task) => task.status !== "merged");
	const catalogItems = snapshot.catalog[catalogKind];

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
		if (event.type === "extension.request") setEventRequest(event);
		if (event.type === "extension.dismiss") setEventRequest((current) => current?.request.id === event.requestId ? null : current);
		setSnapshot((current) => {
			if (event.seq <= current.lastEventSeq) return current;
			if (event.type === "snapshot") return event.snapshot;
			if (event.type === "message") return { ...current, lastEventSeq: event.seq, messages: current.messages.some((item) => item.id === event.message.id) ? current.messages.map((item) => item.id === event.message.id ? event.message : item) : [...current.messages, event.message] };
			if (event.type === "task") return { ...current, lastEventSeq: event.seq, tasks: current.tasks.some((item) => item.id === event.task.id) ? current.tasks.map((item) => item.id === event.task.id ? event.task : item) : [...current.tasks, event.task] };
			if (event.type === "extension.update") return { ...current, lastEventSeq: event.seq, extensionUi: { ...current.extensionUi, [event.workerKey]: event.state } };
			if (event.type === "mcp.status") return { ...current, lastEventSeq: event.seq, ...(event.workerKey === `session:${current.activeSessionId}` ? { mcpServers: event.servers } : {}) };
			if (event.type === "terminal.output" && current.terminal?.id === event.terminalId) return { ...current, lastEventSeq: event.seq, terminal: { ...current.terminal, output: `${current.terminal.output}${event.text}` } };
			return { ...current, lastEventSeq: event.seq };
		});
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
		void api.invoke("app.snapshot", undefined).then((result) => {
			if (!alive) return;
			if (!result.ok) {
				setError(`${result.code}: ${result.message}`);
				setReady(true);
				return;
			}
			setSnapshot(result.data);
			lastEventSeq.current = result.data.lastEventSeq;
			setReady(true);
			unsubscribe = api.subscribe(result.data.lastEventSeq, applyEvent);
		}).catch((cause: unknown) => {
			if (!alive) return;
			setError(cause instanceof Error ? cause.message : "Could not load the local application snapshot.");
			setReady(true);
		});
		return () => { alive = false; unsubscribe?.(); };
	}, [applyEvent]);

	useEffect(() => window.piOrbit?.subscribeAuth((event) => {
		if (!dismissedAuthFlows.current.has(event.flowId)) setAuthFlow(event);
	}), []);
	useEffect(() => window.piOrbit?.subscribeMcpAuth((event) => setMcpAuthEvent(event)), []);

	useEffect(() => {
		const panel = transcriptRef.current;
		if (panel) panel.scrollTop = panel.scrollHeight;
	}, [snapshot.messages]);

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
	const respondExtensionDialog = (requestId: string, value: unknown) => {
		void call("extension.ui.respond", { requestId, value }).then((result) => {
			if (result.ok || result.code === "UI_REQUEST_NOT_FOUND" || result.code === "WORKER_NOT_RUNNING") {
				setEventRequest((current) => current?.request.id === requestId ? null : current);
			}
		});
	};

	const selectSession = async (sessionId: string) => {
		const result = await call("session.select", { sessionId });
		if (result.ok) {
			const refreshed = await call("app.snapshot", undefined);
			if (refreshed.ok) setSnapshot(refreshed.data);
			else setSnapshot((current) => ({ ...current, activeSessionId: sessionId, messages: [] }));
		}
	};
	const refreshSnapshot = async () => {
		const result = await call("app.snapshot", undefined);
		if (result.ok) setSnapshot(result.data);
	};
	const openProject = async (path: string) => {
		const result = await call("project.open", { path });
		if (result.ok) await refreshSnapshot();
	};
	const createSession = async (projectId: string) => {
		const result = await call("session.create", { projectId });
		if (result.ok) await refreshSnapshot();
	};
	const mergeTask = async (taskId: string) => {
		const result = await call("task.merge", { taskId });
		if (!result.ok) return;
		await refreshSnapshot();
		if (!result.data.merged) setError(result.data.conflicts.length ? `Merge needs attention: ${result.data.conflicts.join(", ")}` : "Merge was not applied. Review the task diff and try again.");
	};
	const addAttachments = async (event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		event.target.value = "";
		if (files.length === 0) return;
		let releaseBudget: (() => void) | undefined;
		try {
			const emptyFile = files.find((file) => file.size === 0);
			if (emptyFile) throw new Error(`${emptyFile.name} is empty.`);
			const oversizedFile = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
			if (oversizedFile) throw new Error(`${oversizedFile.name} exceeds the 8 MiB attachment limit.`);
			releaseBudget = attachmentBudgetRef.current.reserve(files, attachmentsRef.current);
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
			const nextAttachments = [...attachmentsRef.current, ...loaded];
			attachmentsRef.current = nextAttachments;
			setAttachments(nextAttachments);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not read the selected file.");
		} finally {
			releaseBudget?.();
		}
	};
	const promptSession = async (text: string) => {
		if (!activeSession || (!text.trim() && attachments.length === 0)) return;
		const payloadAttachments = attachments.length ? attachments : undefined;
		const result = activeSession.status === "running"
			? await call("session.message", { sessionId: activeSession.id, text: text.trim(), deliverAs: sessionDelivery, ...(payloadAttachments ? { attachments: payloadAttachments } : {}) })
			: await call("session.prompt", { sessionId: activeSession.id, text: text.trim(), ...(payloadAttachments ? { attachments: payloadAttachments } : {}) });
		if (result.ok) {
			setDraft("");
			attachmentsRef.current = [];
			setAttachments([]);
		}
	};
	const removeAttachment = (index: number) => {
		const nextAttachments = attachmentsRef.current.filter((_, itemIndex) => itemIndex !== index);
		attachmentsRef.current = nextAttachments;
		setAttachments(nextAttachments);
	};
	const openCatalog = (kind: CatalogKind) => { setCatalogKind(kind); setModal("catalog"); };
	const submitPrompt = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void promptSession(draft); };

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
						<div className="section-head session-heading"><span>{t("Sessions")}</span><button className="tiny-icon" aria-label={t("New session")} onClick={() => void createSession(activeProject.id)}>＋</button></div>
						{snapshot.sessions.filter((session) => session.projectId === activeProject.id).map((session) => <button key={session.id} className={`session-row ${session.id === activeSession?.id ? "selected" : ""}`} onClick={() => void selectSession(session.id)}><span className="session-glyph">◷</span><span className="row-text">{session.title || t("Untitled session")}</span>{session.status === "running" && <span className="live-dot" />}</button>)}
						{snapshot.sessions.filter((session) => session.projectId === activeProject.id).length === 0 && <p className="empty-hint">{t("No sessions yet. Create one with ＋.")}</p>}
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
			<div className="conversation-head"><div><div className="crumb">{activeProject?.name ?? t("No project selected")}<span>/</span>{activeSession?.title ?? t("New conversation")}</div><h1>{activeSession?.title || t("Pi workspace")}</h1></div><div className="conversation-actions"><span className={`status-pill ${activeSession?.status === "running" ? "is-running" : ""}`}><i />{activeSession?.status === "running" ? t("Running") : t("Ready")}</span><button className="action-button" disabled={!activeSession} onClick={() => activeSession && void call("session.fork", { sessionId: activeSession.id })}>⑂ {t("Fork")}</button><button className="action-button" disabled={!activeSession} onClick={() => activeSession && void call("session.compact", { sessionId: activeSession.id })}>↘ {t("Compact")}</button><button className="action-button primary-action" disabled={!activeProject} onClick={() => setModal("new-task")}>＋ {t("New task")}</button></div></div>
			{activeSession && <div className="model-line"><span className="model-glyph">◈</span><select aria-label={t("Model")} value={activeSession.model || snapshot.settings.defaultModel} onChange={(event) => void call("model.select", { sessionId: activeSession.id, model: event.target.value })}><option value="">{t("Choose model")}</option>{snapshot.providers.flatMap((provider) => provider.models.map((model) => <option key={`${provider.id}:${model}`} value={model}>{model}</option>))}</select><span className="model-provider">{snapshot.providers.find((provider) => provider.models.includes(activeSession.model))?.name ?? (snapshot.providers.length ? t("Choose a model") : t("Configure a provider in Settings"))}</span>{snapshot.providers.length === 0 && <button type="button" className="text-button" onClick={() => setModal("settings")}>{t("Settings")}</button>}</div>}
				<div className="transcript" ref={transcriptRef} aria-live="polite" aria-relevant="additions text">
					{!activeSession ? (
						<div className="welcome"><div className="welcome-orbit"><span>π</span><i /><b /></div><p className="eyebrow">{t("YOUR LOCAL AI WORKSPACE")}</p><h2>{t("Build something")}<br /><em>{t("thoughtful.")}</em></h2><p className="welcome-copy">{t("Choose a project and session, then work with Pi in a focused desktop workspace.")}</p><div className="welcome-cards"><button onClick={() => activeProject ? void createSession(activeProject.id) : setModal("open-project")}><span>✳</span><b>{t("Start a conversation")}</b><small>{t("Ask Pi to explore or change your code")}</small></button><button onClick={() => activeProject ? setModal("new-task") : setModal("open-project")}><span>⌘</span><b>{t("Delegate a task")}</b><small>{t("Run a focused agent in its own worktree")}</small></button></div></div>
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
					<form className="composer" onSubmit={submitPrompt}><input ref={attachmentInputRef} className="attachment-file-input" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,text/*,.md,.markdown,.json,.jsonc,.yaml,.yml,.toml,.csv,.tsv,.log,.js,.jsx,.ts,.tsx,.css,.html,.xml,.py,.rs,.go,.java,.c,.h,.cpp,.hpp,.cs,.php,.rb,.sh,.sql,.env,.diff,.patch,.ini,.conf" onChange={(event) => void addAttachments(event)} /><textarea aria-label={t("Message Pi")} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { const sendOnEnter = shortcutPreview === "enter" && event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey; const sendOnCtrlEnter = shortcutPreview === "ctrlEnter" && event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey; if (sendOnEnter || sendOnCtrlEnter) { event.preventDefault(); void promptSession(draft); } }} placeholder={activeSession ? t("Message Pi…") : t("Select or create a session to begin")} disabled={!activeSession} rows={3} />{attachments.length > 0 && <div className="attachment-previews" aria-label={t("Attachments")}>{attachments.map((attachment, index) => <div className="attachment-preview" key={`${attachment.name}-${index}`}>{attachment.type === "image" ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} /> : <span className="attachment-text-icon" aria-hidden="true">▤</span>}<span className="attachment-file-details"><b title={attachment.name}>{attachment.name}</b><small>{formatFileSize(attachmentSize(attachment))}</small></span><button type="button" aria-label={`${t("Remove attachment")} ${attachment.name}`} onClick={() => removeAttachment(index)}>×</button></div>)}</div>}<div className="composer-bottom"><div className="composer-tools"><button type="button" title={t("Attach or reference file")} aria-label={t("Attach files")} onClick={() => attachmentInputRef.current?.click()}>＋</button><button type="button" onClick={() => openCatalog("skills")}>✳ <span>{t("Skills")}</span></button><button type="button" onClick={() => openCatalog("templates")}>▤ <span>{t("Template")}</span></button><button type="button" onClick={() => setModal("terminal")}>⌘ <span>{t("Terminal")}</span></button></div><div className="send-group"><span>{shortcutPreview === "enter" ? t("↵ to send · ⇧↵ for newline") : t("Ctrl+↵ to send · ↵ for newline")}</span>{activeSession?.status === "running" && <label className="delivery-mode-label">{t("Send as")}<select aria-label={t("Send as")} className="delivery-mode" value={sessionDelivery} onChange={(event) => setSessionDelivery(event.target.value as "steer" | "followUp")}><option value="steer">{t("Steer now")}</option><option value="followUp">{t("Follow up")}</option></select></label>}{activeSession?.status === "running" && <button type="submit" className="send-button" aria-label={t("Queue message")} title={t("Queue message")} disabled={!draft.trim() && attachments.length === 0}>↑</button>}{activeSession?.status === "running" && <button type="button" className="stop-button" onClick={() => void call("session.abort", { sessionId: activeSession.id })}>■ {t("Stop")}</button>}{activeSession && activeSession.status !== "running" && <button className="send-button" type="submit" aria-label={t("Send message")} disabled={!draft.trim() && attachments.length === 0}>↑</button>}</div></div></form><div className="composer-disclaimer">{t("Pi can make mistakes. Review changes before merging.")}</div>
				</div>
			</section>

			<aside className="sidebar right-sidebar" aria-label={t("Task and file details")}>
				<div className="inspector-head"><div><span className="eyebrow">{t("ORCHESTRATION")}</span><h2>{t("Tasks")} <span className="task-count">{projectTasks.length}</span></h2></div><button className="tiny-icon" aria-label={t("Create task")} disabled={!activeProject} onClick={() => setModal("new-task")}>＋</button></div>
				<div className="task-list" aria-label={t("Task list")}>{projectTasks.length === 0 ? <div className="task-empty"><div className="task-empty-icon">⑂</div><b>{t("No delegated tasks")}</b><p>{t("Delegate focused work to a role. Each task gets an isolated worktree and its own conversation.")}</p><button className="outline-button" disabled={!activeProject} onClick={() => setModal("new-task")}>{t("Create task")}</button></div> : projectTasks.map((task) => <button key={task.id} className={`task-card ${task.id === (activeTask?.id) ? "task-selected" : ""}`} onClick={() => { setSelectedTaskId(task.id); setSelectedFile(null); }}><div className="task-card-top"><span className={`task-status status-${task.status}`}>{statusLabel(task.status, t)}</span><span className="task-time">{relativeTime(task.updatedAt, languagePreview)}</span></div><b>{task.prompt}</b><div className="task-card-meta"><span className="task-avatar">{task.roleName.slice(0, 1).toUpperCase()}</span>{task.roleName}<span className="meta-sep">·</span>{task.filesChanged} {t("files")}</div>{task.dependsOn.length > 0 && <div className="dependency-line">↳ {t(" waits for ")}{task.dependsOn.map((id) => snapshot.tasks.find((candidate) => candidate.id === id)?.roleName ?? id.slice(0, 7)).join(", ")}</div>}</button>)}</div>
				{activeTask && <div className="task-detail"><div className="detail-title-row"><div><span className={`task-status status-${activeTask.status}`}>{statusLabel(activeTask.status, t)}</span><h3>{activeTask.roleName}</h3></div><button className="tiny-icon" aria-label={t("Task actions")} onClick={() => setSelectedFile(null)}>•••</button></div><p className="task-prompt">{activeTask.prompt}</p>{activeTask.resultSummary && <div className="task-result"><div className="detail-label">{t("LATEST RESULT")}</div><p>{activeTask.resultSummary}</p></div>}<ExtensionUiPanel state={snapshot.extensionUi[`task:${activeTask.id}`]} t={t} onUseEditorText={(text) => setDraft(text)} /><div className="task-actions">{activeTask.status === "running" && <button onClick={() => void call("task.pause", { taskId: activeTask.id })}>Ⅱ {t("Pause")}</button>}{activeTask.status === "paused" && <button onClick={() => void call("task.resume", { taskId: activeTask.id })}>▶ {t("Resume")}</button>}{!["merged", "cancelled", "failed", "completed"].includes(activeTask.status) && <button className="danger-action" onClick={() => void call("task.cancel", { taskId: activeTask.id })}>{t("Cancel")}</button>}{["review", "completed"].includes(activeTask.status) && <button className="merge-button" onClick={() => void mergeTask(activeTask.id)}>{t("Merge changes")}</button>}</div>{activeTask.usage && <div className="task-usage"><span>{t("Usage")}</span><span>{t("In")} {activeTask.usage.input.toLocaleString()}</span><span>{t("Out")} {activeTask.usage.output.toLocaleString()}</span></div>}
					<div className="detail-tabs"><span>{t("Changes")} <b>{activeTask.changes.length}</b></span><span>{t("Activity")} <b>{activeTask.messages.length + activeTask.toolRecords.length}</b></span></div>
					<div className="change-list">{activeTask.changes.length ? activeTask.changes.map((change) => <button key={change.path} className={`change-row ${selectedFile === change.path ? "file-selected" : ""}`} onClick={() => setSelectedFile(selectedFile === change.path ? null : change.path)}><span className={`file-dot file-${change.status}`} />{change.path}<span className="change-kind">{change.status === "modified" ? "M" : change.status === "added" ? "A" : "D"}</span></button>) : <p className="empty-hint">{t("No changed files yet.")}</p>}{selectedFile && activeTask.changes.find((change) => change.path === selectedFile) && <pre className="diff-preview">{activeTask.changes.find((change) => change.path === selectedFile)?.diff || t("No diff content was provided.")}</pre>}</div>
					<div className="task-messages"><div className="detail-label">{t("TASK MESSAGES")}</div>{activeTask.messages.length > 0 ? activeTask.messages.slice(-3).map((message) => <div key={message.id} className="task-message"><b>{message.author}</b><p>{message.text}</p></div>) : <p className="empty-hint">{t("No task messages yet.")}</p>}</div>
					{activeTask.toolRecords.length > 0 && <details className="activity-details"><summary>{t("Tool activity")} · {activeTask.toolRecords.length}</summary>{activeTask.toolRecords.slice(-5).map((record) => <div className="activity-row" key={record.id}><span>{record.name}</span><small>{t(record.status)}</small><p>{record.summary}</p></div>)}</details>}
					<div className="task-reply"><form onSubmit={(event) => { event.preventDefault(); const field = event.currentTarget.elements.namedItem("task-reply") as HTMLInputElement; if (field.value.trim() && activeTask.status === "running") { void call("task.message", { taskId: activeTask.id, text: field.value.trim() }); field.value = ""; } }}><input name="task-reply" aria-label={`${t("Send a message to")} ${activeTask.roleName}`} placeholder={activeTask.status === "running" ? t("Message this task…") : t("Task messages are available while running")} disabled={activeTask.status !== "running"} /><button type="submit" aria-label={t("Send task message")} disabled={activeTask.status !== "running"}>↑</button></form></div>
				</div>}
				<div className="inspector-footer"><div><span className="green-dot" />{t("LOCAL ONLY")}</div><button onClick={() => setModal("terminal")}>⌘ {t("Terminal")}</button></div>
			</aside>
		</div>
		{modal && <ModalView modal={modal} snapshot={snapshot} t={t} onLanguageChange={setLanguagePreview} onThemeChange={setThemePreview} onSendShortcutChange={setShortcutPreview} onSettingsSaved={(settings) => setSnapshot((current) => ({ ...current, settings }))} catalogKind={catalogKind} catalogItems={catalogItems} activeProjectId={activeProject?.id} activeSessionId={activeSession?.id} mcpAuthEvent={mcpAuthEvent} onCatalogKindChange={setCatalogKind} onInsertDraft={(text) => setDraft((current) => `${current}${current ? "\n\n" : ""}${text}`)} onOpenRoles={() => setModal("roles")} onStartOAuth={(providerId) => { void call("auth.login", { providerId }).then((result) => { if (result.ok) setAuthFlow((current) => current ?? { flowId: result.data.flowId, type: "started" }); }); }} authFlowActive={authFlow !== null} onClose={() => { setLanguagePreview(snapshot.settings.language); setThemePreview(snapshot.settings.theme); setShortcutPreview(snapshot.settings.sendShortcut); setMcpAuthEvent(undefined); setModal(null); }} call={call} refresh={refreshSnapshot} />}
		{eventRequest && <ExtensionDialog key={eventRequest.request.id} request={eventRequest.request} t={t} onSubmit={(value) => respondExtensionDialog(eventRequest.request.id, value)} onCancel={(value) => respondExtensionDialog(eventRequest.request.id, value)} />}
		{authFlow && <AuthFlowDialog key={`${authFlow.flowId}:${authFlow.type === "prompt" ? authFlow.promptId : authFlow.type}`} event={authFlow} t={t} call={call} onClose={() => { dismissedAuthFlows.current.add(authFlow.flowId); if (authFlow.type !== "complete" && authFlow.type !== "failed" && authFlow.type !== "cancelled") void call("auth.cancel", { flowId: authFlow.flowId }); setAuthFlow(null); }} />}
		<div className="app-bottomline"><span><i />{t("LOCAL DATA")}</span><span>{snapshot.tasks.filter((task) => task.status === "running").length} {snapshot.tasks.filter((task) => task.status === "running").length === 1 ? t("active agent") : t("active agents")}</span><button onClick={() => setModal("terminal")}>{t("Terminal panel")}</button></div>
	</main>;
}

function ModalView(props: { modal: Exclude<Modal, null>; snapshot: AppSnapshot; t: Translate; onLanguageChange: (language: Language) => void; onThemeChange: (theme: AppSnapshot["settings"]["theme"]) => void; onSendShortcutChange: (sendShortcut: "enter" | "ctrlEnter") => void; onSettingsSaved: (settings: AppSnapshot["settings"]) => void; catalogKind: CatalogKind; catalogItems: CatalogEntry[]; activeProjectId?: string; activeSessionId?: string; mcpAuthEvent?: McpAuthEvent; onCatalogKindChange: (kind: CatalogKind) => void; onInsertDraft: (text: string) => void; onOpenRoles: () => void; onStartOAuth: (providerId: string) => void; authFlowActive: boolean; onClose: () => void; call: AppCall; refresh: () => Promise<void> }) {
	const { modal, snapshot, t, onLanguageChange, onThemeChange, onSendShortcutChange, onSettingsSaved, catalogKind, catalogItems, activeProjectId, activeSessionId, mcpAuthEvent, onCatalogKindChange, onInsertDraft, onOpenRoles, onStartOAuth, authFlowActive, onClose, call, refresh } = props;
	const [role, setRole] = useState<Role>({ id: "", name: "", description: "", systemPrompt: "", model: "", tools: [], scope: "project" });
	const [roleTools, setRoleTools] = useState("");
	const [theme, setTheme] = useState(snapshot.settings.theme);
	const [defaultModel, setDefaultModel] = useState(snapshot.settings.defaultModel);
	const [language, setLanguage] = useState(snapshot.settings.language);
	const [sendShortcut, setSendShortcut] = useState(snapshot.settings.sendShortcut);
	const [confirmTools] = useState(snapshot.settings.confirmToolCalls);
	const [providerId, setProviderId] = useState(snapshot.providers[0]?.id ?? "");
	const [credential, setCredential] = useState("");
	const [taskRole, setTaskRole] = useState(snapshot.roles[0]?.id ?? "");
	const [taskPrompt, setTaskPrompt] = useState("");
	const [dependencies, setDependencies] = useState<string[]>([]);
	const [terminalCommand, setTerminalCommand] = useState("");
	const [folderPath, setFolderPath] = useState("");
	useEffect(() => {
		if (!snapshot.providers.some((provider) => provider.id === providerId)) {
			setProviderId(snapshot.providers[0]?.id ?? "");
		}
	}, [snapshot.providers, providerId]);
	useEffect(() => { setLanguage(snapshot.settings.language); }, [snapshot.settings.language]);
	useEffect(() => { setSendShortcut(snapshot.settings.sendShortcut); }, [snapshot.settings.sendShortcut]);
	const title = modal === "settings" ? t("Settings & providers") : modal === "roles" ? t("Agent roles") : modal === "catalog" ? catalogTitle(catalogKind, t) : modal === "mcp" ? t("MCP servers") : modal === "new-task" ? t("Create a task") : modal === "open-project" ? t("Open a project") : t("Interactive terminal");
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);
	const run = async (event: FormEvent<HTMLFormElement>, action: () => Promise<unknown>) => { event.preventDefault(); await action(); };
	return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`modal modal-${modal}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><header className="modal-head"><div><span className="eyebrow">PI ORBIT</span><h2 id="modal-title">{title}</h2></div><button className="icon-button" aria-label={t("Close dialog")} onClick={onClose}>×</button></header>
		{modal === "mcp" && <McpPanel sessionId={activeSessionId} servers={snapshot.mcpServers ?? []} authEvent={mcpAuthEvent} call={call} t={t} />}
		{modal === "settings" && <div className="modal-content settings-content">
			<div className="setting-section"><h3>{t("Preferences")}</h3><p>{t("Customize the language, message shortcut, appearance, and default model for this workspace.")}</p>
				<form className="settings-form" onSubmit={(event) => void run(event, async () => { const result = await call("settings.save", { theme, defaultModel, confirmToolCalls: confirmTools, language, sendShortcut }); if (result.ok) { onSettingsSaved(result.data); await refresh(); } })}>
					<label>{t("Language")}<select value={language} onChange={(event) => { const value = event.target.value as Language; setLanguage(value); onLanguageChange(value); }}><option value="en">{t("English")}</option><option value="zh-CN">{t("简体中文")}</option></select></label>
					<label>{t("Send shortcut")}<select value={sendShortcut} onChange={(event) => { const value = event.target.value as "enter" | "ctrlEnter"; setSendShortcut(value); onSendShortcutChange(value); }}><option value="enter">{t("Enter to send")}</option><option value="ctrlEnter">{t("Ctrl+↵ / ⌘+↵ to send")}</option></select></label>
					<label>{t("Appearance")}<select value={theme} onChange={(event) => { const value = event.target.value as typeof theme; setTheme(value); onThemeChange(value); }}><option value="system">{t("System theme")}</option><option value="dark">{t("Dark")}</option><option value="light">{t("Light")}</option></select></label>
					<label>{t("Default model")}<select value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)}><option value="">{t("No default")}</option>{snapshot.providers.flatMap((provider) => provider.models.map((model) => <option value={model} key={`${provider.id}:${model}`}>{model}</option>))}</select></label>
					<div className="inline-diagnostic settings-note"><b>{t("Tool confirmation preference is not active yet.")}</b><br />{t("Pi Orbit currently follows Pi’s configured tool policy. This stored preference does not add confirmation prompts.")}</div>
					<button className="primary-action">{t("Save preferences")}</button>
				</form>
			</div>
			<div className="setting-section"><h3>{t("Model providers")}</h3><p>{t("API keys are entered here, passed to Pi through the protected desktop bridge, and stored in Pi’s local credential store. The key is cleared from this form after saving.")}</p>
				{snapshot.providers.length === 0 && <div className="inline-diagnostic">{t("No providers were returned. Check Pi’s installed provider configuration and reopen Settings.")}</div>}
				{snapshot.providers.map((provider) => <div className="provider-row" key={provider.id}><div><b>{provider.name}</b><small>{t(provider.configured ? "Credential configured" : "Needs authentication")}</small></div><span className={provider.configured ? "configured-tag" : "missing-tag"}>{t(provider.configured ? "Connected" : "Not connected")}</span>{provider.oauthLogin && <button className="text-button" disabled={authFlowActive} onClick={() => onStartOAuth(provider.id)}>{t("Sign in")}</button>}{provider.configured && <button className="text-button" onClick={() => void call(provider.credentialType === "oauth" ? "auth.logout" : "auth.clear", { providerId: provider.id }).then((result) => { if (result.ok) void refresh(); })}>{t(provider.credentialType === "oauth" ? "Log out" : "Clear")}</button>}</div>)}
				<form className="credential-form" onSubmit={(event) => void run(event, async () => { const result = await call("auth.configure", { providerId, credential }); if (result.ok) { setCredential(""); await refresh(); } })}><label>{t("Provider")}<select required value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="" disabled>{t("Select provider")}</option>{snapshot.providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select></label><label>{t("API key")}<input type="password" autoComplete="off" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder={t("Paste API key")} /></label><button className="primary-action" disabled={!providerId || !credential}>{t("Save credential")}</button></form>
			</div><CapabilityList capabilities={snapshot.capabilities} call={call} t={t} />
		</div>}
		{modal === "roles" && <div className="modal-content role-content"><div className="role-list">{snapshot.roles.map((item) => <button className={`role-list-item ${role.id === item.id ? "role-active" : ""}`} key={item.id} onClick={() => { setRole(item); setRoleTools(item.tools.join(", ")); }}><span className="role-avatar">{item.name.slice(0, 1).toUpperCase()}</span><span><b>{item.name}</b><small>{t(item.scope)} {t("role")} · {item.model || t("default model")}</small></span><span className="role-arrow">›</span></button>)}{snapshot.roles.length === 0 && <p className="empty-hint">{t("No role definitions are available yet. Create a role for the task scheduler.")}</p>}<button className="outline-button full-button" onClick={() => { setRole({ id: "", name: "", description: "", systemPrompt: "", model: snapshot.settings.defaultModel, tools: [], scope: activeProjectId ? "project" : "user" }); setRoleTools(""); }}>＋ {t("New role")}</button></div><form className="role-editor" onSubmit={(event) => void run(event, async () => { const value = { ...role, id: role.id || slug(role.name), tools: roleTools.split(",").map((tool) => tool.trim()).filter(Boolean) }; const result = await call("role.save", value); if (result.ok) { setRole(result.data); await refresh(); } })}><label>{t("Role name")}<input required value={role.name} onChange={(event) => setRole({ ...role, name: event.target.value })} placeholder={t("Code reviewer")} /></label><label>{t("Short description")}<input value={role.description} onChange={(event) => setRole({ ...role, description: event.target.value })} placeholder={t("Reviews changes for correctness and regressions")} /></label><label>{t("Markdown system prompt")}<textarea rows={7} value={role.systemPrompt} onChange={(event) => setRole({ ...role, systemPrompt: event.target.value })} placeholder={t("# Role\nYou are a careful code reviewer…")} /></label><label>{t("Model")}<select value={role.model} onChange={(event) => setRole({ ...role, model: event.target.value })}><option value="">{t("Use default model")}</option>{snapshot.providers.flatMap((provider) => provider.models.map((model) => <option value={model} key={`${provider.id}:${model}`}>{model}</option>))}</select></label><label>{t("Allowed tools")}<input value={roleTools} onChange={(event) => setRoleTools(event.target.value)} placeholder={t("read, edit, bash")} /><small>{t("Comma separated tool names.")}</small></label><label>{t("Definition scope")}<select value={role.scope} onChange={(event) => setRole({ ...role, scope: event.target.value as Role["scope"] })}><option value="project">{t("Project")}</option><option value="user">{t("User")}</option></select></label><button className="primary-action">{t("Save role")}</button></form></div>}
		{modal === "catalog" && <div className="modal-content catalog-content"><nav className="catalog-tabs" aria-label={t("Library category")}>{(["skills", "templates", "commands", "extensions"] as CatalogKind[]).map((kind) => <button type="button" className={kind === catalogKind ? "catalog-tab-active" : ""} onClick={() => onCatalogKindChange(kind)} key={kind}>{catalogTitle(kind, t)}</button>)}</nav><div className="catalog-diagnostic"><span>i</span><p>{t(catalogKind === "extensions" ? "Extensions are listed as sources. Run supported extension commands from Commands; terminal-only interfaces need a desktop adapter." : "Select or create a conversation session to use these items. Skills and templates insert into its draft; extension commands run in it.")}</p></div>{catalogItems.length === 0 ? <div className="empty-catalog"><div>✳</div><b>{language === "zh-CN" ? `暂无${catalogTitle(catalogKind, t)}` : `No ${catalogTitle(catalogKind, t).toLowerCase()} found`}</b><p>{t("Items are loaded from the active Pi configuration. Add them to your Pi user or project folder.")}</p></div> : <div className="catalog-list">{catalogItems.map((item) => <CatalogRow key={item.id} item={item} kind={catalogKind} disabled={!activeSessionId} t={t} onRun={async () => { const result = await call("catalog.run", { kind: catalogKind.slice(0, -1) as "skill" | "template" | "command" | "extension", id: item.id }); if (result.ok) { if (result.data.insertedText) { onInsertDraft(result.data.insertedText); onClose(); } else if (result.data.started) onClose(); } }} />)}</div>}</div>}
		{modal === "open-project" && <div className="modal-content task-create-content"><form onSubmit={(event) => void run(event, async () => { if (!folderPath.trim()) return; const result = await call("project.open", { path: folderPath.trim() }); if (result.ok) { await call("session.create", { projectId: result.data.id }); await refresh(); onClose(); } })}><p className="modal-intro">{t("Choose a local repository folder. Pi Orbit keeps its sessions and tasks on this device.")}</p><label>{t("Folder path")}<input autoFocus required value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="C:\\work\\project" /></label><div className="modal-footer"><button type="button" className="outline-button" onClick={onClose}>{t("Cancel")}</button><button className="primary-action" disabled={!folderPath.trim()}>{t("Open folder")}</button></div></form></div>}
		{modal === "new-task" && <div className="modal-content task-create-content"><form onSubmit={(event) => void run(event, async () => { if (taskPrompt.trim() && activeProjectId) { const result = await call("task.create", { projectId: activeProjectId, roleId: taskRole, prompt: taskPrompt.trim(), dependsOn: dependencies }); if (result.ok) { await refresh(); onClose(); } } })}>{!activeProjectId ? <><p className="modal-intro">{t("Open a project before creating a task.")}</p><button type="button" className="outline-button" onClick={() => { onClose(); }}>{t("Close")}</button></> : <><p className="modal-intro">{t("The new agent runs in an isolated worktree and reports changes here for review.")}</p><label>{t("Role")}<select required value={taskRole} onChange={(event) => setTaskRole(event.target.value)}><option value="" disabled>{t("Select a role")}</option>{snapshot.roles.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model || t("default model")}</option>)}</select></label>{snapshot.roles.length === 0 && <div className="inline-diagnostic">{t("Create an agent role before dispatching a task.")} <button className="text-button" type="button" onClick={onOpenRoles}>{t("Manage roles")}</button></div>}<label>{t("Task instructions")}<textarea required rows={5} value={taskPrompt} onChange={(event) => setTaskPrompt(event.target.value)} placeholder={t("Implement the settings screen and add focused tests…")} /></label><label>{t("Wait for tasks")}<select multiple value={dependencies} onChange={(event) => setDependencies(Array.from(event.target.selectedOptions, (option) => option.value))}>{snapshot.tasks.filter((task) => task.projectId === activeProjectId && !["failed", "cancelled"].includes(task.status)).map((task) => <option value={task.id} key={task.id}>{task.roleName}: {truncate(task.prompt, 48)}</option>)}</select><small>{t("Leave empty to run immediately. Failed prerequisites stop dependent tasks.")}</small></label><div className="form-note"><span>◈</span>{t("Up to 4 tasks run at the same time per project.")}</div><div className="modal-footer"><button type="button" className="outline-button" onClick={onClose}>{t("Cancel")}</button><button className="primary-action" disabled={!taskPrompt.trim() || !taskRole}>{t("Create task")} <span>→</span></button></div></>}</form></div>}
				{modal === "terminal" && <div className="terminal-content"><div className="terminal-toolbar"><span className="terminal-leds"><i /><i /><i /></span><span>{snapshot.terminal?.title ?? t("Project terminal")}</span><span className={`task-status status-${snapshot.terminal?.state === "running" ? "running" : "queued"}`}>{snapshot.terminal?.state ? t(snapshot.terminal.state) : t("not started")}</span>{snapshot.terminal && <button className="text-button" onClick={() => void call("terminal.stop", { terminalId: snapshot.terminal!.id })}>{t("Stop")}</button>}</div><TerminalPane output={snapshot.terminal?.output ?? ""} terminalId={snapshot.terminal?.id} running={snapshot.terminal?.state === "running"} t={t} onInput={(text) => { if (snapshot.terminal?.id) void call("terminal.input", { terminalId: snapshot.terminal.id, text }); }} onResize={(cols, rows) => { if (snapshot.terminal?.id) void call("terminal.resize", { terminalId: snapshot.terminal.id, cols, rows }); }} /><form className="terminal-start" onSubmit={(event) => void run(event, async () => { if (!activeProjectId) return; const result = await call("terminal.start", { projectId: activeProjectId, command: terminalCommand || undefined }); if (result.ok) await refresh(); })}><label>{t("Start with command")}<input value={terminalCommand} onChange={(event) => setTerminalCommand(event.target.value)} placeholder={t("Leave blank for the project shell")} /></label><button className="primary-action" disabled={!activeProjectId || Boolean(snapshot.terminal?.state === "running")}>{t("Start")}</button></form></div>}
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
function TerminalPane({ output, terminalId, running, onInput, onResize, t }: { output: string; terminalId?: string; running: boolean; onInput: (text: string) => void; onResize: (cols: number, rows: number) => void; t: Translate }) {
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
			terminalRef.current.clear();
		}
		if (output.length < outputCursor.current) outputCursor.current = 0;
		if (output.length > outputCursor.current) {
			terminalRef.current.write(output.slice(outputCursor.current));
			outputCursor.current = output.length;
		}
	}, [output, terminalId]);
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
