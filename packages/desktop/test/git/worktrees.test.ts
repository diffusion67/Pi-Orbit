import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import {
	createTaskWorktree,
	GitWorkspaceDirtyError,
	inspectTaskWorktree,
	mergeTaskWorktree,
} from "../../src/git/worktrees.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function runGit(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		windowsHide: true,
	});
	return stdout.trim();
}

async function createRepository(): Promise<{ directory: string; baseCommit: string }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-orbit-git-test-"));
	temporaryRepositories.push(directory);
	const projectPath = join(directory, "project");
	await mkdir(projectPath);
	await runGit(projectPath, ["init", "-b", "main"]);
	await runGit(projectPath, ["config", "user.name", "Pi Orbit Test"]);
	await runGit(projectPath, ["config", "user.email", "pi-orbit@example.invalid"]);
	await runGit(projectPath, ["config", "core.autocrlf", "false"]);
	await writeFile(join(projectPath, "tracked.txt"), "starting content\n");
	await runGit(projectPath, ["add", "--", "tracked.txt"]);
	await runGit(projectPath, ["commit", "-m", "initial"]);
	return { directory, baseCommit: await runGit(projectPath, ["rev-parse", "HEAD"]) };
}

afterEach(async () => {
	await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

after(() => {
	if (temporaryRepositories.length > 0) throw new Error("Temporary Git repositories were not cleaned up");
});

describe("task worktrees", () => {
	it("records HEAD and creates a detached worktree only from a clean workspace", async () => {
		const { directory, baseCommit } = await createRepository();
		const projectPath = join(directory, "project");
		const worktreePath = join(directory, "task-1");
		const result = await createTaskWorktree({ projectPath, worktreePath });

		assert.equal(result.baseCommit, baseCommit);
		assert.equal(await runGit(worktreePath, ["rev-parse", "HEAD"]), baseCommit);
		assert.equal(await runGit(worktreePath, ["symbolic-ref", "-q", "HEAD"]).catch(() => ""), "");

		await writeFile(join(projectPath, "tracked.txt"), "uncommitted\n");
		await assert.rejects(
			createTaskWorktree({ projectPath, worktreePath: join(directory, "task-2") }),
			GitWorkspaceDirtyError,
		);
	});

	it("merges tracked and untracked changes as uncommitted files and is idempotent", async () => {
		const { directory, baseCommit } = await createRepository();
		const projectPath = join(directory, "project");
		const worktreePath = join(directory, "task-1");
		await createTaskWorktree({ projectPath, worktreePath });
		await writeFile(join(worktreePath, "tracked.txt"), "task change\n");
		await writeFile(join(worktreePath, "new file.txt"), "new task file\n");
		const inspected = await inspectTaskWorktree({ worktreePath, baseCommit });
		assert.deepEqual(
			inspected.map(({ path, status }) => ({ path, status })),
			[
				{ path: "new file.txt", status: "added" },
				{ path: "tracked.txt", status: "modified" },
			],
		);
		assert.match(inspected[0].diff, /new task file/);

		const first = await mergeTaskWorktree({ projectPath, worktreePath, baseCommit, taskId: "task-1" });
		const second = await mergeTaskWorktree({ projectPath, worktreePath, baseCommit, taskId: "task-1" });

		assert.equal(first.status, "merged");
		assert.equal(second.status, "already-merged");
		assert.equal(await readFile(join(projectPath, "tracked.txt"), "utf8"), "task change\n");
		assert.equal(await readFile(join(projectPath, "new file.txt"), "utf8"), "new task file\n");
		assert.equal(await runGit(projectPath, ["rev-parse", "HEAD"]), baseCommit);
	});

	it("treats worktree filenames containing Git pathspec characters literally", async () => {
		const { directory, baseCommit } = await createRepository();
		const projectPath = join(directory, "project");
		const worktreePath = join(directory, "task-1");
		await createTaskWorktree({ projectPath, worktreePath });
		await writeFile(join(worktreePath, "literal[ab].txt"), "literal name\n");
		await writeFile(join(worktreePath, "literala.txt"), "glob match\n");

		const changes = await inspectTaskWorktree({ worktreePath, baseCommit });
		assert.deepEqual(
			changes.map(({ path }) => path),
			["literal[ab].txt", "literala.txt"],
		);
		assert.match(changes[0].diff, /literal name/);
		assert.doesNotMatch(changes[0].diff, /glob match/);

		const result = await mergeTaskWorktree({ projectPath, worktreePath, baseCommit, taskId: "task-1" });
		assert.equal(result.status, "merged");
		assert.equal(await readFile(join(projectPath, "literal[ab].txt"), "utf8"), "literal name\n");
		assert.equal(await readFile(join(projectPath, "literala.txt"), "utf8"), "glob match\n");
	});

	it("blocks a task change when the target has local edits to that file", async () => {
		const { directory, baseCommit } = await createRepository();
		const projectPath = join(directory, "project");
		const worktreePath = join(directory, "task-1");
		await createTaskWorktree({ projectPath, worktreePath });
		await writeFile(join(worktreePath, "tracked.txt"), "task change\n");
		await writeFile(join(projectPath, "tracked.txt"), "local edit\n");

		const result = await mergeTaskWorktree({ projectPath, worktreePath, baseCommit, taskId: "task-1" });

		assert.equal(result.status, "blocked");
		if (result.status === "blocked") assert.equal(result.reason, "local-modifications");
		assert.equal(await readFile(join(projectPath, "tracked.txt"), "utf8"), "local edit\n");
	});

	it("blocks deletions for explicit user handling", async () => {
		const { directory, baseCommit } = await createRepository();
		const projectPath = join(directory, "project");
		const worktreePath = join(directory, "task-1");
		await createTaskWorktree({ projectPath, worktreePath });
		await rm(join(worktreePath, "tracked.txt"));

		const result = await mergeTaskWorktree({ projectPath, worktreePath, baseCommit, taskId: "task-1" });

		assert.equal(result.status, "blocked");
		if (result.status === "blocked") assert.equal(result.reason, "deleted-files");
		assert.equal(await readFile(join(projectPath, "tracked.txt"), "utf8"), "starting content\n");
	});
});
