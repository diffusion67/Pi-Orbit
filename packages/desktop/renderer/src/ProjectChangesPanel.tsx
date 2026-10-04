import { useEffect, useRef, useState } from "react";
import type { Command, CommandMap, ProjectChange, ProjectChangeMode, ProjectChanges, Result } from "./contract";
import type { Translate } from "./i18n";
import { isBinaryProjectDiff, parseProjectDiff } from "./project-change-diff.ts";

type ProjectChangesCall = <K extends Command>(command: K, payload: CommandMap[K]["payload"]) => Promise<Result<CommandMap[K]["data"]>>;

export function ProjectChangesPanel({ projectId, projectName, activeSessionId, t, call, onClose, onRequestReview }: {
	projectId: string;
	projectName: string;
	activeSessionId?: string;
	t: Translate;
	call: ProjectChangesCall;
	onClose: () => void;
	onRequestReview: (projectId: string, sessionId: string, baseCommit: string, mode: ProjectChangeMode, ref: string, changes: ProjectChange[], truncated: boolean) => void;
}) {
	const [mode, setMode] = useState<ProjectChangeMode>("workingTree");
	const [ref, setRef] = useState("");
	const [changes, setChanges] = useState<ProjectChanges>();
	const [loadedTarget, setLoadedTarget] = useState<{ mode: ProjectChangeMode; ref: string }>();
	const [selectedPath, setSelectedPath] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const requestId = useRef(0);
	const dialogRef = useRef<HTMLElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const titleId = `project-changes-title-${projectId}`;
	const selectedChange = changes?.changes.find((change) => change.path === selectedPath);
	const binary = selectedChange ? isBinaryProjectDiff(selectedChange.diff) : false;

	const loadChanges = async (requestedMode = mode, requestedRef = ref) => {
		const currentRequest = ++requestId.current;
		setLoading(true);
		setError("");
		setChanges(undefined);
		setLoadedTarget(undefined);
		setSelectedPath("");
		const result = await call("project.changes", {
			projectId,
			mode: requestedMode,
			...(requestedMode !== "workingTree" && requestedRef.trim() ? { ref: requestedRef.trim() } : {}),
		});
		if (currentRequest !== requestId.current) return;
		if (result.ok) {
			setChanges(result.data);
			setLoadedTarget({ mode: requestedMode, ref: requestedMode === "workingTree" ? "" : requestedRef.trim() });
		}
		else setError(result.message);
		setLoading(false);
	};

	useEffect(() => {
		void loadChanges("workingTree", "");
		return () => { requestId.current++; };
	}, [projectId]);
	useEffect(() => {
		const dialog = dialogRef.current;
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		const focusable = () => dialog?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex="-1"])') ?? [];
		(focusable()[0] ?? dialog)?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
			if (dialogs.item(dialogs.length - 1) !== dialog) return;
			if (event.key === "Escape") {
				event.preventDefault();
				closeRef.current();
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
	}, []);

	const reviewRequest = () => {
		if (!activeSessionId || !changes || !loadedTarget) return;
		onRequestReview(projectId, activeSessionId, changes.baseCommit, loadedTarget.mode, loadedTarget.ref, changes.changes, changes.truncated);
	};

	return <div className="modal-backdrop project-changes-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
		<section ref={dialogRef} tabIndex={-1} className="modal project-changes-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
			<header className="modal-head"><div><span className="eyebrow">{t("PROJECT REVIEW")}</span><h2 id={titleId}>{projectName} · {t("Project changes")}</h2></div><button className="tiny-icon" type="button" aria-label={t("Close dialog")} onClick={onClose}>×</button></header>
			<div className="project-changes-toolbar">
				<label>{t("Compare")}
					<select value={mode} onChange={(event) => setMode(event.target.value as ProjectChangeMode)}>
						<option value="workingTree">{t("Working tree")}</option>
						<option value="baseBranch">{t("Base branch")}</option>
						<option value="commit">{t("Commit")}</option>
					</select>
				</label>
				{mode !== "workingTree" && <label>{t(mode === "baseBranch" ? "Branch name" : "Commit reference")}
					<input value={ref} onChange={(event) => setRef(event.target.value)} placeholder={t(mode === "baseBranch" ? "main" : "HEAD~1")} />
				</label>}
				<button className="outline-button small-button" type="button" disabled={loading || (mode !== "workingTree" && !ref.trim())} onClick={() => void loadChanges()}>{t(loading ? "Loading changes…" : "Refresh")}</button>
			</div>
			{changes && <div className="project-changes-meta"><span>{t("Comparison")}: {loadedTarget ? t(targetLabel(loadedTarget.mode)) + (loadedTarget.ref ? ` · ${loadedTarget.ref}` : "") : ""}</span><span>{t("Base commit")}: <code>{changes.baseCommit || t("Unknown")}</code></span><span>{changes.changes.length} {t("files")}</span></div>}
			{changes?.truncated && <p className="project-changes-notice" role="status">{t("The diff was truncated. Some changed files or lines may be missing.")}</p>}
			{error && <p className="project-changes-error" role="alert">{error}</p>}
			{!loading && !error && changes?.changes.length === 0 && <div className="project-changes-empty">{t("No project changes found for this comparison.")}</div>}
			{loading && <div className="project-changes-empty" role="status">{t("Loading changes…")}</div>}
			{changes && changes.changes.length > 0 && <div className="project-changes-layout">
				<nav className="project-change-files" aria-label={t("Changed files")}>
					{changes.changes.map((change) => <button key={change.path} type="button" className={`project-change-file ${selectedPath === change.path ? "is-selected" : ""}`} onClick={() => setSelectedPath(change.path)}><span className={`file-dot file-${change.status}`} /><span>{change.path}</span><small>{statusLetter(change.status)}</small></button>)}
				</nav>
				<section className="project-change-diff" aria-label={selectedChange ? `${t("Diff for")} ${selectedChange.path}` : t("Select a changed file")}>
					{selectedChange ? <><div className="project-change-diff-title"><b>{selectedChange.path}</b><span>{t(selectedChange.status)}</span></div>{binary ? <p className="project-changes-empty">{t("This file is binary and has no text diff to display.")}</p> : selectedChange.diff ? <DiffLines diff={selectedChange.diff} /> : <p className="project-changes-empty">{t("No diff content was provided.")}</p>}</> : <p className="project-changes-empty">{t("Select a changed file")}</p>}
				</section>
			</div>}
			<footer className="project-changes-footer"><span>{activeSessionId ? t("Ask Pi to review these changes") : t("Select a session to ask Pi for a review")}</span><button type="button" className="primary-action" disabled={!activeSessionId || !changes || loading || changes.changes.length === 0} onClick={reviewRequest}>{t("Ask agent to review")}</button></footer>
		</section>
	</div>;
}

function DiffLines({ diff }: { diff: string }) {
	const rows = parseProjectDiff(diff);
	return <pre className="structured-diff" aria-label="Diff"><code>{rows.map((line, index) => <span className={`diff-line diff-${line.kind}`} key={index}><i>{line.oldLine ?? ""}</i><i>{line.newLine ?? ""}</i><span>{line.text}</span></span>)}</code></pre>;
}

function statusLetter(status: ProjectChange["status"]): string {
	return status === "added" ? "A" : status === "deleted" ? "D" : "M";
}

function targetLabel(mode: ProjectChangeMode): string {
	return mode === "workingTree" ? "Working tree" : mode === "baseBranch" ? "Base branch" : "Commit";
}
