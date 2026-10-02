import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	assertFreshRelease,
	assertInstallerFormat,
	assertPublicationGate,
	assertReleaseAssets,
	assertReleaseIdentity,
	assertTrustedRun,
	getArchiveInstaller,
	getGitHubApiArgs,
	getPackagingArchitecture,
	getReleaseAssetName,
	publishVerifiedDraft,
	selectArtifact,
	verifyInstallerChecksum,
} from "./desktop-release-helpers.mjs";

const repo = "diffusion67/Pi-Orbit";
const sha = "a".repeat(40);
const version = "0.1.0-rc.1";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const workflow = { id: 10, name: "CI", path: ".github/workflows/ci.yml" };
const desktopWorkflow = {
	id: 20,
	name: "Pi Orbit Desktop Unsigned Artifacts",
	path: ".github/workflows/desktop-release-candidate.yml",
};
const run = (wf = workflow) => ({
	id: wf.id * 10,
	workflow_id: wf.id,
	name: wf.name,
	path: wf.path,
	repository: { full_name: repo },
	head_repository: { full_name: repo },
	head_branch: "main",
	head_sha: sha,
	event: "push",
	status: "completed",
	conclusion: "success",
	run_attempt: 1,
});
const job = (name, steps, source = run()) => ({
	id: name.length,
	name,
	run_id: source.id,
	run_attempt: source.run_attempt,
	head_sha: sha,
	status: "completed",
	conclusion: "success",
	steps: steps.map((step) => ({ name: step, status: "completed", conclusion: "success" })),
});
const ciJobs = () => [
	job("build-check-test", ["Build", "Check", "Test"]),
	job("mcp-conformance", ["MCP client conformance"]),
];
const desktopJobs = () => [
	["windows", "Package Windows NSIS installer", "Install, launch, and uninstall packaged app (Windows)", "Windows"],
	["macos", "Package macOS DMG", "Mount and launch packaged app from DMG (macOS)", "macOS"],
	["linux", "Package Linux AppImage", "Launch packaged AppImage (Linux)", "Linux"],
].map(([platform, pack, smoke, label]) => job(`${platform} desktop artifact`, [
	"Typecheck desktop renderer", "Test desktop services and worker", "Build desktop application", pack, smoke,
	`Create SHA-256 manifest (${label})`, "Upload platform artifact and checksum",
], run(desktopWorkflow)));
const gate = () => ({
	repository: repo,
	eventName: "workflow_run",
	ref: "refs/heads/main",
	sourceSha: sha,
	liveSha: sha,
	version,
	trigger: run(),
	ci: { workflow, run: run(), jobs: ciJobs() },
	desktop: { workflow: desktopWorkflow, run: run(desktopWorkflow), jobs: desktopJobs() },
});

test("only trusted successful main push runs for the exact SHA qualify", () => {
	assert.equal(assertTrustedRun(run(), workflow, sha), undefined);
	for (const patch of [
		{ head_sha: "b".repeat(40) }, { head_branch: "other" }, { event: "pull_request" },
		{ head_repository: { full_name: "attacker/Pi-Orbit" } }, { repository: { full_name: "other/Pi-Orbit" } },
		{ conclusion: "failure" }, { status: "in_progress" }, { workflow_id: 99 }, { path: "other.yml" },
	]) assert.throws(() => assertTrustedRun({ ...run(), ...patch }, workflow, sha));
});

test("publication needs both latest exact-SHA runs and the unchanged live main", () => {
	assert.equal(assertPublicationGate(gate()), undefined);
	for (const patch of [
		{ liveSha: "b".repeat(40) }, { sourceSha: "bad" }, { repository: "fork/Pi-Orbit" },
		{ eventName: "pull_request_target" }, { ref: "refs/heads/other" }, { version: "0.1.0-rc.2" },
		{ trigger: { ...run(), id: 999 } },
		{ desktop: { ...gate().desktop, run: { ...run(desktopWorkflow), head_sha: "b".repeat(40) } } },
	]) assert.throws(() => assertPublicationGate({ ...gate(), ...patch }));
});

test("missing, failed, skipped or previous-attempt jobs and mandatory steps block publication", () => {
	for (const jobs of [ciJobs().slice(0, 1), [...ciJobs(), ciJobs()[0]],
		ciJobs().map((item) => ({ ...item, conclusion: "skipped" })),
		ciJobs().map((item) => ({ ...item, run_attempt: 2 })),
		ciJobs().map((item) => ({ ...item, head_sha: "b".repeat(40) })),
		ciJobs().map((item) => ({ ...item, steps: [] })),
	]) assert.throws(() => assertPublicationGate({ ...gate(), ci: { ...gate().ci, jobs } }));
	const broken = desktopJobs();
	broken[0].steps[4].conclusion = "failure";
	assert.throws(() => assertPublicationGate({ ...gate(), desktop: { ...gate().desktop, jobs: broken } }));
	assert.throws(() => assertPublicationGate({ ...gate(), desktop: { ...gate().desktop, jobs: desktopJobs().slice(1) } }));
});

test("artifacts must uniquely belong to the validated run and SHA and remain downloadable", () => {
	const artifact = {
		id: 50, name: `pi-orbit-windows-${sha}`, expired: false, size_in_bytes: 123,
		workflow_run: { id: 200, head_sha: sha, head_branch: "main", repository_id: 42, head_repository_id: 42 },
	};
	assert.equal(selectArtifact([artifact], "windows", run(desktopWorkflow), 42), artifact);
	for (const items of [[], [artifact, artifact], [{ ...artifact, expired: true }],
		[{ ...artifact, workflow_run: { ...artifact.workflow_run, head_sha: "b".repeat(40) } }],
		[{ ...artifact, workflow_run: { ...artifact.workflow_run, head_repository_id: 99 } }],
	]) assert.throws(() => selectArtifact(items, "windows", run(desktopWorkflow), 42));
});

test("archive allows exactly one versioned installer plus SHA256SUMS with safe flat names", () => {
	const name = "Pi Orbit Setup 0.1.0-rc.1.exe";
	assert.equal(getArchiveInstaller([name, "SHA256SUMS"], "windows"), name);
	for (const names of [[name], [name, name, "SHA256SUMS"], [name, "SHA256SUMS", "surprise.sh"],
		["../bad.exe", "SHA256SUMS"], ["Pi Orbit 0.0.3.exe", "SHA256SUMS"],
		["Pi Orbit 0.1.0-rc.1.dmg", "SHA256SUMS"], ["bad*0.1.0-rc.1.exe", "SHA256SUMS"],
		["Pi Orbit 0.1.0-rc.10.exe", "SHA256SUMS"],
	]) assert.throws(() => getArchiveInstaller(names, "windows"));
});

test("release installer filenames are stable under GitHub asset sanitization", () => {
	for (const [original, expected] of [
		["Pi Orbit Setup 0.1.0-rc.1.exe", "Pi-Orbit-Setup-0.1.0-rc.1.exe"],
		["Pi Orbit-0.1.0-rc.1-arm64.dmg", "Pi-Orbit-0.1.0-rc.1-arm64.dmg"],
		["Pi Orbit-0.1.0-rc.1.AppImage", "Pi-Orbit-0.1.0-rc.1.AppImage"],
		["Pi-Orbit-0.1.0-rc.1.exe", "Pi-Orbit-0.1.0-rc.1.exe"],
	]) assert.equal(getReleaseAssetName(original), expected);
	for (const name of ["../bad.exe", "bad(1).exe", ".bad.exe", "bad.exe.", "bad/exe", ""]) {
		assert.throws(() => getReleaseAssetName(name));
	}
});

test("installer signatures reject renamed text files and contradictory AppImage architecture", () => {
	const pe = Buffer.alloc(128);
	pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.write("PE\0\0", 64);
	assert.equal(assertInstallerFormat("windows", "x64", pe, Buffer.alloc(512)), undefined);
	const elf = Buffer.alloc(64);
	elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); elf.set([0x41, 0x49, 2], 8); elf.writeUInt16LE(62, 18);
	assert.equal(assertInstallerFormat("linux", "x64", elf, Buffer.alloc(512)), undefined);
	const dmg = Buffer.alloc(512); dmg.write("koly");
	assert.equal(assertInstallerFormat("macos", "arm64", Buffer.alloc(64), dmg), undefined);
	for (const platform of ["windows", "linux", "macos"]) {
		assert.throws(() => assertInstallerFormat(platform, "x64", Buffer.from("not an installer"), Buffer.alloc(512)));
	}
	assert.throws(() => assertInstallerFormat("linux", "arm64", elf, Buffer.alloc(512)));
});

test("installer checksum must exactly match the downloaded bytes and filename", () => {
	const name = "Pi Orbit Setup 0.1.0-rc.1.exe";
	const bytes = Buffer.from("installer");
	const digest = hash(bytes);
	assert.equal(verifyInstallerChecksum(`${digest}  ${name}\r\n`, name, digest), digest);
	for (const sums of [`${"0".repeat(64)}  ${name}\n`, `${digest}  different.exe\n`,
		`${digest}  ${name}\n${digest}  ${name}\n`, "", `${digest}  ../${name}\n`,
	]) assert.throws(() => verifyInstallerChecksum(sums, name, digest));
});

test("architecture comes from one unambiguous electron-builder packaging target", () => {
	assert.equal(getPackagingArchitecture("2026-10-01T12:00:00Z   • packaging       platform=darwin arch=arm64 electron=44.4.5", "macos"), "arm64");
	assert.equal(getPackagingArchitecture("  • packaging platform=win32 arch=x64 electron=44.4.5", "windows"), "x64");
	for (const log of ["", "running on x64", "packaging platform=linux arch=x64",
		"packaging platform=darwin arch=universal", "packaging platform=darwin arch=x64\npackaging platform=darwin arch=arm64",
	]) assert.throws(() => getPackagingArchitecture(log, "macos"));
});

test("API arguments require an explicit raw-output opt-in for logs and file bytes", () => {
	const headers = ["-H", "X-GitHub-Api-Version: 2022-11-28", "-H", "Cache-Control: no-cache"];
	assert.deepEqual(getGitHubApiArgs(`repos/${repo}/releases`), ["api", `repos/${repo}/releases`, ...headers]);
	for (const endpoint of ["actions/jobs/123/logs", "actions/artifacts/456/zip", "releases/assets/789"]) {
		assert.deepEqual(getGitHubApiArgs(`repos/${repo}/${endpoint}`, { rawOutput: true }), [
			"api", `repos/${repo}/${endpoint}`, ...headers, "--allow-escape-sequences",
		]);
	}
});

test("architecture parsing ignores ANSI formatting without weakening target checks", () => {
	const color = (value) => `\u001b[36m${value}\u001b[0m`;
	const log = `2026-10-02T00:00:00Z • ${color("packaging")} ${color("platform=darwin")} ${color("arch=arm64")} electron=44.4.5`;
	assert.equal(getPackagingArchitecture(log, "macos"), "arm64");
	assert.throws(() => getPackagingArchitecture(log, "windows"), /Packaging OS differs/);
	assert.throws(() => getPackagingArchitecture(`${log}\n${log}`, "macos"), /Expected exactly one packaging target/);
	assert.throws(() => getPackagingArchitecture(log.replace("arm64", "universal"), "macos"), /Unsupported or unknown architecture/);
});

test("publication-only changes rebuild exact-SHA desktop artifacts on pull requests and main", () => {
	const text = readFileSync(new URL("../.github/workflows/desktop-release-candidate.yml", import.meta.url), "utf8");
	for (const event of ["push", "pull_request"]) {
		const block = new RegExp(`^  ${event}:\\n([\\s\\S]*?)(?=^  \\w|^permissions:)`, "m").exec(text)?.[1];
		assert.ok(block, `Missing ${event} trigger`);
		for (const path of [".github/workflows/desktop-publish-release.yml", "scripts/desktop-release*.mjs"]) {
			assert.ok(block.includes(`- "${path}"`), `${event} must rebuild after ${path} changes`);
		}
	}
});

test("an existing tag or any existing release is never overwritten or reused", () => {
	assert.equal(assertFreshRelease([], []), undefined);
	for (const draft of [true, false]) assert.throws(() => assertFreshRelease([{ tag_name: `pi-orbit-v${version}`, draft }], []));
	assert.throws(() => assertFreshRelease([], [{ ref: `refs/tags/pi-orbit-v${version}` }]));
	assert.equal(assertFreshRelease([{ tag_name: "other" }], [{ ref: "refs/tags/other" }]), undefined);
});

test("remote release assets must match every verified local file, with no extras", () => {
	const files = [{ name: "a.exe", size: 5, sha256: "a".repeat(64) }];
	const assets = [{ id: 1, name: "a.exe", state: "uploaded", size: 5, digest: `sha256:${"a".repeat(64)}` }];
	assert.equal(assertReleaseAssets(assets, files), undefined);
	for (const values of [[], [...assets, assets[0]], [{ ...assets[0], size: 6 }],
		[{ ...assets[0], state: "starter" }], [{ ...assets[0], digest: `sha256:${"b".repeat(64)}` }],
	]) assert.throws(() => assertReleaseAssets(values, files));
});

test("an already-published release is read-only only when tag, SHA, notes and prerelease state match", () => {
	const release = { id: 123, tag_name: `pi-orbit-v${version}`, target_commitish: sha, draft: false, prerelease: true, body: "verified notes" };
	assert.equal(assertReleaseIdentity(release, sha, "verified notes", false), undefined);
	for (const patch of [{ target_commitish: "main" }, { draft: true }, { prerelease: false }, { body: "different notes" }, { tag_name: "v1.0.0" }]) {
		assert.throws(() => assertReleaseIdentity({ ...release, ...patch }, sha, "verified notes", false));
	}
});

test("draft is published only after upload, download verification and a fresh gate", async () => {
	const calls = [];
	const io = Object.fromEntries(["guard", "create", "upload", "verify", "publish"].map((key) => [key, async () => {
		calls.push(key);
		return { id: 123 };
	}]));
	await publishVerifiedDraft(io);
	assert.deepEqual(calls, ["guard", "create", "upload", "verify", "guard", "publish", "verify"]);
});

test("a verification failure or main movement leaves the draft unpublished and never deletes it", async () => {
	for (const failAt of ["upload", "verify", "second-guard"]) {
		const calls = [];
		let guards = 0;
		const io = Object.fromEntries(["guard", "create", "upload", "verify", "publish", "delete"].map((key) => [key, async () => {
			calls.push(key);
			if (key === "guard") guards++;
			if (key === failAt || (failAt === "second-guard" && guards === 2)) throw new Error("blocked");
			return { id: 123 };
		}]));
		await assert.rejects(publishVerifiedDraft(io), /blocked/);
		assert.equal(calls.includes("publish"), false);
		assert.equal(calls.includes("delete"), false);
	}
});

test("workflow confines publication to trusted push-main completion and job-local permissions", () => {
	const text = readFileSync(new URL("../.github/workflows/desktop-publish-release.yml", import.meta.url), "utf8");
	assert.match(text, /workflow_run:/);
	assert.match(text, /workflows: \["CI", "Pi Orbit Desktop Unsigned Artifacts"\]/);
	assert.match(text, /branches: \[main\]/);
	assert.match(text, /permissions: \{\}/);
	assert.match(text, /github\.repository == 'diffusion67\/Pi-Orbit'/);
	assert.match(text, /github\.event\.workflow_run\.head_repository\.full_name == 'diffusion67\/Pi-Orbit'/);
	assert.match(text, /github\.event\.workflow_run\.event == 'push'/);
	assert.match(text, /github\.event\.workflow_run\.conclusion == 'success'/);
	assert.match(text, /cancel-in-progress: false/);
	assert.match(text, /contents: write\n\s+actions: read/);
	assert.match(text, /persist-credentials: false/);
	assert.doesNotMatch(text, /pull_request(?:_target)?:|workflow_dispatch:|secrets\.|npm publish|--clobber/);
	for (const line of text.split("\n").filter((line) => /uses:/.test(line))) assert.match(line, /@[a-f0-9]{40}(?:\s|$)/);
});
