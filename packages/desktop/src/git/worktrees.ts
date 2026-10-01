import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;

export type TaskWorktree = {
	projectRoot: string;
	worktreePath: string;
	baseCommit: string;
};

export type TaskWorktreeChange = { path: string; status: "added" | "modified" | "deleted"; diff: string };

export type GitMergeBlockReason =
	| "base-not-ancestor"
	| "conflict"
	| "deleted-files"
	| "local-modifications"
	| "task-id-reused";

export type GitMergeResult =
	| { status: "merged"; files: string[]; diff: string }
	| { status: "already-merged"; files: string[]; diff: string }
	| { status: "blocked"; reason: GitMergeBlockReason; files: string[]; diff: string };

export class GitWorkspaceDirtyError extends Error {
	readonly paths: string[];

	constructor(paths: string[]) {
		super(`Cannot create a writable task while the project has local changes: ${paths.join(", ")}`);
		this.name = "GitWorkspaceDirtyError";
		this.paths = paths;
	}
}

async function git(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		maxBuffer: MAX_GIT_OUTPUT,
		windowsHide: true,
		env: options.env,
	});
	return stdout;
}

async function gitWithInput(
	cwd: string,
	args: string[],
	input: Buffer | string,
	options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn("git", ["-C", cwd, ...args], {
			windowsHide: true,
			stdio: ["pipe", "ignore", "pipe"],
			env: options.env,
		});
		const errorParts: Buffer[] = [];
		child.stderr.on("data", (chunk: Buffer) => errorParts.push(chunk));
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolvePromise();
				return;
			}
			reject(new Error(Buffer.concat(errorParts).toString("utf8").trim() || `git exited with code ${code}`));
		});
		child.stdin.end(input);
	});
}

function parseNulList(output: string): string[] {
	return output.split("\0").filter((value) => value.length > 0);
}

function parseStatusPaths(output: string): string[] {
	return parseNulList(output).map((entry) => entry.slice(3));
}

function parseNameStatus(output: string): Array<{ status: string; path: string }> {
	const tokens = parseNulList(output);
	const changes: Array<{ status: string; path: string }> = [];
	for (let index = 0; index + 1 < tokens.length; index += 2) {
		changes.push({ status: tokens[index], path: tokens[index + 1] });
	}
	return changes;
}

async function repositoryRoot(projectPath: string): Promise<string> {
	return (await git(resolve(projectPath), ["rev-parse", "--show-toplevel"])).trim();
}

async function worktreeStatusPaths(projectRoot: string): Promise<string[]> {
	return parseStatusPaths(
		await git(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]),
	);
}

/**
 * Refuse writable work when the base workspace has changes outside explicitly
 * allowed paths, then create a detached worktree at the exact HEAD the task records.
 */
export async function createTaskWorktree(options: {
	projectPath: string;
	worktreePath: string;
	allowedDirtyPaths?: readonly string[];
}): Promise<TaskWorktree> {
	const projectRoot = await repositoryRoot(options.projectPath);
	const allowedDirtyPaths = new Set((options.allowedDirtyPaths ?? []).map((path) => resolve(projectRoot, path)));
	const dirtyPaths = (await worktreeStatusPaths(projectRoot)).filter(
		(path) => !allowedDirtyPaths.has(resolve(projectRoot, path)),
	);
	if (dirtyPaths.length > 0) throw new GitWorkspaceDirtyError(dirtyPaths);

	const baseCommit = (await git(projectRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
	const worktreePath = resolve(options.worktreePath);
	if (!isAbsolute(worktreePath) || worktreePath === projectRoot) {
		throw new TypeError("Task worktree path must be an absolute path separate from the project root");
	}
	await mkdir(dirname(worktreePath), { recursive: true });
	await git(projectRoot, ["worktree", "add", "--detach", worktreePath, baseCommit]);
	return { projectRoot, worktreePath, baseCommit };
}

type MergeMarker = {
	taskId: string;
	baseCommit: string;
	patchSha256: string;
	state: "applying" | "merged";
	updatedAt: string;
};

function safeTaskId(taskId: string): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new TypeError("Task ID contains unsupported characters");
	return taskId;
}

async function commonGitDirectory(projectRoot: string): Promise<string> {
	const path = (await git(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
	return resolve(path);
}

async function readMergeMarker(path: string): Promise<MergeMarker | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as MergeMarker;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeMergeMarker(path: string, marker: MergeMarker): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, { flag: "wx" });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

async function buildTaskPatch(
	worktreePath: string,
	baseCommit: string,
): Promise<{ patch: string; files: string[]; deletions: string[]; changes: TaskWorktreeChange[] }> {
	const trackedChanges = parseNulList(
		await git(worktreePath, ["diff", "--name-only", "-z", "--no-renames", baseCommit, "--"]),
	);
	const untracked = parseNulList(await git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]));
	const changedPaths = [...new Set([...trackedChanges, ...untracked])];
	if (changedPaths.length === 0) return { patch: "", files: [], deletions: [], changes: [] };

	const temporaryIndexDirectory = await mkdtemp(join(tmpdir(), "pi-orbit-index-"));
	const indexPath = join(temporaryIndexDirectory, "index");
	const env = { ...process.env, GIT_INDEX_FILE: indexPath, GIT_LITERAL_PATHSPECS: "1" };
	try {
		await git(worktreePath, ["read-tree", baseCommit], { env });
		const pathInput = Buffer.from(`${changedPaths.join("\0")}\0`, "utf8");
		await gitWithInput(worktreePath, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], pathInput, { env });
		const patch = await git(
			worktreePath,
			["diff", "--cached", "--binary", "--no-ext-diff", "--no-renames", baseCommit],
			{ env },
		);
		const names = parseNameStatus(
			await git(worktreePath, ["diff", "--cached", "--name-status", "-z", "--no-renames", baseCommit], { env }),
		);
		const changes = await Promise.all(
			names.map(
				async (change): Promise<TaskWorktreeChange> => ({
					path: change.path,
					status: change.status === "A" ? "added" : change.status === "D" ? "deleted" : "modified",
					diff: (
						await git(
							worktreePath,
							["diff", "--cached", "--binary", "--no-ext-diff", baseCommit, "--", change.path],
							{ env },
						)
					).slice(0, 1_000_000),
				}),
			),
		);
		return {
			patch,
			files: names.map((change) => change.path),
			deletions: names.filter((change) => change.status === "D").map((change) => change.path),
			changes,
		};
	} finally {
		await rm(temporaryIndexDirectory, { recursive: true, force: true });
	}
}

/** Read a child task's complete uncommitted changes without changing either worktree. */
export async function inspectTaskWorktree(options: {
	worktreePath: string;
	baseCommit: string;
}): Promise<readonly TaskWorktreeChange[]> {
	return (await buildTaskPatch(resolve(options.worktreePath), options.baseCommit)).changes;
}

async function patchCheck(projectRoot: string, patch: string, reverse = false): Promise<boolean> {
	try {
		await gitWithInput(
			projectRoot,
			["apply", "--check", "--binary", "--whitespace=nowarn", ...(reverse ? ["--reverse"] : []), "-"],
			patch,
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Apply a task's complete tracked and untracked diff as uncommitted changes.
 * The durable marker lives in the shared Git directory and makes retries
 * idempotent, including recovery if the process stops after applying the patch.
 */
export async function mergeTaskWorktree(options: {
	projectPath: string;
	worktreePath: string;
	baseCommit: string;
	taskId: string;
}): Promise<GitMergeResult> {
	const projectRoot = await repositoryRoot(options.projectPath);
	const worktreePath = await repositoryRoot(options.worktreePath);
	const baseCommit = (await git(projectRoot, ["rev-parse", "--verify", `${options.baseCommit}^{commit}`])).trim();
	const sourceCommonDir = await commonGitDirectory(worktreePath);
	const targetCommonDir = await commonGitDirectory(projectRoot);
	if (sourceCommonDir !== targetCommonDir) throw new Error("Task worktree does not belong to the target project");

	const taskId = safeTaskId(options.taskId);
	const { patch, files, deletions } = await buildTaskPatch(worktreePath, baseCommit);
	if (patch.length === 0) return { status: "merged", files: [], diff: "" };
	const patchSha256 = createHash("sha256").update(patch).digest("hex");
	const markerPath = join(targetCommonDir, "pi-orbit", "merged-tasks", `${taskId}.json`);
	let marker = await readMergeMarker(markerPath);
	if (marker) {
		if (marker.baseCommit !== baseCommit || marker.patchSha256 !== patchSha256) {
			return { status: "blocked", reason: "task-id-reused", files, diff: patch };
		}
		if (marker.state === "merged") return { status: "already-merged", files, diff: patch };
		if (await patchCheck(projectRoot, patch, true)) {
			marker = { ...marker, state: "merged", updatedAt: new Date().toISOString() };
			await writeMergeMarker(markerPath, marker);
			return { status: "already-merged", files, diff: patch };
		}
	}

	const head = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();
	try {
		await git(projectRoot, ["merge-base", "--is-ancestor", baseCommit, head]);
	} catch {
		return { status: "blocked", reason: "base-not-ancestor", files, diff: patch };
	}
	const committedChanges = new Set(
		parseNulList(await git(projectRoot, ["diff", "--name-only", "-z", "--no-renames", baseCommit, head, "--"])),
	);
	const committedOverlaps = files.filter((file) => committedChanges.has(file));
	if (committedOverlaps.length > 0) {
		return { status: "blocked", reason: "local-modifications", files: committedOverlaps, diff: patch };
	}
	const dirtyPaths = new Set(await worktreeStatusPaths(projectRoot));
	const localOverlaps = files.filter((file) => dirtyPaths.has(file));
	if (localOverlaps.length > 0) {
		return { status: "blocked", reason: "local-modifications", files: localOverlaps, diff: patch };
	}
	if (deletions.length > 0) return { status: "blocked", reason: "deleted-files", files: deletions, diff: patch };
	if (!(await patchCheck(projectRoot, patch))) return { status: "blocked", reason: "conflict", files, diff: patch };
	if (!marker) {
		marker = { taskId, baseCommit, patchSha256, state: "applying", updatedAt: new Date().toISOString() };
		await writeMergeMarker(markerPath, marker);
	}
	await gitWithInput(projectRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], patch);
	marker = { taskId, baseCommit, patchSha256, state: "merged", updatedAt: new Date().toISOString() };
	await writeMergeMarker(markerPath, marker);
	return { status: "merged", files, diff: patch };
}
