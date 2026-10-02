import assert from "node:assert/strict";

// Deliberately one release, one repository. Extending this is a separate release review.
export const REPOSITORY = "diffusion67/Pi-Orbit";
export const VERSION = "0.1.0-rc.1";
export const TAG = `pi-orbit-v${VERSION}`;
export const UPSTREAM_SHA = "7fbbd5f4a1d982bb02d63472dde0774fa639f99b";
export const WORKFLOWS = {
	ci: { name: "CI", path: ".github/workflows/ci.yml" },
	desktop: { name: "Pi Orbit Desktop Unsigned Artifacts", path: ".github/workflows/desktop-release-candidate.yml" },
};
export const PLATFORMS = {
	windows: {
		os: "win32", extension: ".exe", label: "Windows",
		packageStep: "Package Windows NSIS installer",
		smokeStep: "Install, launch, and uninstall packaged app (Windows)",
	},
	macos: {
		os: "darwin", extension: ".dmg", label: "macOS",
		packageStep: "Package macOS DMG",
		smokeStep: "Mount and launch packaged app from DMG (macOS)",
	},
	linux: {
		os: "linux", extension: ".AppImage", label: "Linux",
		packageStep: "Package Linux AppImage",
		smokeStep: "Launch packaged AppImage (Linux)",
	},
};

export function assertTrustedRun(run, workflow, sha) {
	assert.ok(/^[a-f0-9]{40}$/.test(sha), "Invalid source SHA");
	assert.ok(Number.isSafeInteger(run?.id) && run.id > 0, "Missing run ID");
	assert.equal(run.repository?.full_name, REPOSITORY, "Untrusted run repository");
	assert.equal(run.head_repository?.full_name, REPOSITORY, "Untrusted source repository");
	assert.equal(run.head_branch, "main", "Run is not from main");
	assert.equal(run.head_sha, sha, "Run source SHA differs");
	assert.equal(run.event, "push", "Only main push runs may publish");
	assert.equal(run.status, "completed", "Run is not complete");
	assert.equal(run.conclusion, "success", "Run did not succeed");
	assert.equal(run.workflow_id, workflow.id, "Workflow identity differs");
	assert.equal(run.name, workflow.name, "Workflow name differs");
	assert.equal(run.path?.split("@")[0], workflow.path, "Workflow path differs");
	assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, "Missing run attempt");
}

function assertJob(jobs, run, name, steps) {
	const matches = jobs.filter((job) => job.name === name);
	assert.equal(matches.length, 1, `Missing or duplicate job: ${name}`);
	const job = matches[0];
	assert.equal(job.run_id, run.id, `Wrong run for ${name}`);
	assert.equal(job.run_attempt, run.run_attempt, `Wrong attempt for ${name}`);
	assert.equal(job.head_sha, run.head_sha, `Wrong source for ${name}`);
	assert.equal(job.status, "completed", `Incomplete job: ${name}`);
	assert.equal(job.conclusion, "success", `Unsuccessful job: ${name}`);
	for (const step of steps) {
		const matchingSteps = job.steps.filter((item) => item.name === step);
		assert.equal(matchingSteps.length, 1, `Missing or duplicate step: ${name}/${step}`);
		assert.equal(matchingSteps[0].status, "completed", `Incomplete step: ${name}/${step}`);
		assert.equal(matchingSteps[0].conclusion, "success", `Unsuccessful step: ${name}/${step}`);
	}
}

export function assertPublicationGate(gate) {
	assert.equal(gate.repository, REPOSITORY, "Wrong publication repository");
	assert.equal(gate.eventName, "workflow_run", "Only workflow_run may publish");
	assert.equal(gate.ref, "refs/heads/main", "Default ref must be main");
	assert.equal(gate.version, VERSION, "Desktop version is outside the approved release");
	assert.equal(gate.liveSha, gate.sourceSha, "main moved; refusing stale artifacts");
	for (const key of Object.keys(WORKFLOWS)) {
		assert.equal(gate[key].workflow.name, WORKFLOWS[key].name, "Unexpected workflow name");
		assert.equal(gate[key].workflow.path, WORKFLOWS[key].path, "Unexpected workflow path");
		assertTrustedRun(gate[key].run, gate[key].workflow, gate.sourceSha);
	}
	const triggered = [gate.ci, gate.desktop].find((item) => item.run.id === gate.trigger?.id);
	assert.ok(triggered, "Trigger is not one of the latest validated runs");
	assertTrustedRun(gate.trigger, triggered.workflow, gate.sourceSha);
	assert.equal(gate.trigger.run_attempt, triggered.run.run_attempt, "Trigger is from a stale attempt");
	assertJob(gate.ci.jobs, gate.ci.run, "build-check-test", ["Build", "Check", "Test"]);
	assertJob(gate.ci.jobs, gate.ci.run, "mcp-conformance", ["MCP client conformance"]);
	for (const [platform, config] of Object.entries(PLATFORMS)) {
		assertJob(gate.desktop.jobs, gate.desktop.run, `${platform} desktop artifact`, [
			"Typecheck desktop renderer", "Test desktop services and worker", "Build desktop application",
			config.packageStep, config.smokeStep, `Create SHA-256 manifest (${config.label})`,
			"Upload platform artifact and checksum",
		]);
	}
}

export function selectArtifact(artifacts, platform, run, repositoryId) {
	assert.ok(Object.hasOwn(PLATFORMS, platform), "Unknown platform");
	const matches = artifacts.filter((artifact) => artifact.name === `pi-orbit-${platform}-${run.head_sha}`);
	assert.equal(matches.length, 1, `Missing or duplicate ${platform} artifact`);
	const artifact = matches[0];
	assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0, "Missing artifact ID");
	assert.equal(artifact.expired, false, "Artifact expired");
	assert.ok(artifact.size_in_bytes > 0 && artifact.size_in_bytes < 2_000_000_000, "Invalid artifact size");
	assert.equal(artifact.workflow_run?.id, run.id, "Artifact belongs to a different run");
	assert.equal(artifact.workflow_run?.head_sha, run.head_sha, "Artifact source SHA differs");
	assert.equal(artifact.workflow_run?.head_branch, "main", "Artifact branch differs");
	assert.equal(artifact.workflow_run?.repository_id, repositoryId, "Artifact repository differs");
	assert.equal(artifact.workflow_run?.head_repository_id, repositoryId, "Artifact source repository differs");
	return artifact;
}

export function getArchiveInstaller(entries, platform) {
	assert.ok(Object.hasOwn(PLATFORMS, platform), "Unknown platform");
	assert.equal(entries.length, 2, "Archive must contain only installer and SHA256SUMS");
	assert.equal(new Set(entries).size, 2, "Duplicate archive entries");
	assert.ok(entries.includes("SHA256SUMS"), "Missing SHA256SUMS");
	const name = entries.find((entry) => entry !== "SHA256SUMS");
	assert.ok(/^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/.test(name), "Unsafe archive filename");
	assert.ok(!name.includes(".."), "Unsafe archive filename");
	assert.ok(new RegExp(`(^|[ -])${VERSION.replaceAll(".", "\\.")}(?=[ -]|\\.(exe|dmg|AppImage)$)`).test(name), "Installer version differs");
	assert.ok(name.endsWith(PLATFORMS[platform].extension), "Installer platform differs");
	assert.ok(!/uninstaller/i.test(name), "Expected installer, not uninstaller");
	return name;
}

export function getReleaseAssetName(name) {
	const safe = name.replaceAll(" ", "-");
	assert.ok(/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(safe) && !safe.includes(".."), "Unsafe release filename");
	return safe;
}

export function assertInstallerFormat(platform, arch, prefix, suffix) {
	assert.ok(Object.hasOwn(PLATFORMS, platform), "Unknown platform");
	assert.ok(prefix.length >= 64, "Installer is truncated");
	if (platform === "windows") {
		assert.equal(prefix.toString("ascii", 0, 2), "MZ", "Expected Windows executable");
		const peOffset = prefix.readUInt32LE(60);
		assert.ok(peOffset <= prefix.length - 4, "Invalid PE header offset");
		assert.equal(prefix.toString("ascii", peOffset, peOffset + 4), "PE\0\0", "Expected PE executable");
	} else if (platform === "linux") {
		assert.deepEqual([...prefix.subarray(0, 6)], [0x7f, 0x45, 0x4c, 0x46, 2, 1], "Expected 64-bit little-endian ELF");
		assert.deepEqual([...prefix.subarray(8, 11)], [0x41, 0x49, 2], "Expected type-2 AppImage");
		assert.equal(prefix.readUInt16LE(18), { x64: 62, arm64: 183 }[arch], "AppImage architecture contradicts packaging log");
	} else {
		assert.equal(suffix.length, 512, "Truncated DMG trailer");
		assert.equal(suffix.toString("ascii", 0, 4), "koly", "Expected UDIF DMG trailer");
	}
}

export function verifyInstallerChecksum(manifest, name, sha256) {
	const lines = manifest.trim().split(/\r?\n/);
	assert.equal(lines.length, 1, "Expected exactly one checksum");
	const match = /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(lines[0]);
	assert.ok(match, "Invalid SHA256SUMS format");
	assert.equal(match[2], name, "Checksum filename differs");
	assert.equal(match[1].toLowerCase(), sha256, "Installer SHA-256 mismatch");
	return sha256;
}

export function getPackagingArchitecture(log, platform) {
	assert.ok(Object.hasOwn(PLATFORMS, platform), "Unknown platform");
	const matches = [...log.matchAll(/\bpackaging\s+platform=(\S+)\s+arch=(\S+)/g)];
	assert.equal(matches.length, 1, `Expected exactly one packaging target in ${platform} job log`);
	assert.equal(matches[0][1], PLATFORMS[platform].os, "Packaging OS differs");
	const arch = matches[0][2];
	assert.ok(["x64", "arm64"].includes(arch), `Unsupported or unknown architecture: ${arch}`);
	return arch;
}

export function assertFreshRelease(releases, refs) {
	assert.ok(!releases.some((release) => release.tag_name === TAG), `Release ${TAG} already exists; never overwrite or resume it`);
	assert.ok(!refs.some((ref) => ref.ref === `refs/tags/${TAG}`), `Tag ${TAG} already exists; never overwrite or reuse it`);
}

export function assertReleaseAssets(assets, files) {
	assert.equal(assets.length, files.length, "Release asset count differs");
	for (const file of files) {
		const matches = assets.filter((asset) => asset.name === file.name);
		assert.equal(matches.length, 1, `Missing or duplicate release asset: ${file.name}`);
		assert.equal(matches[0].state, "uploaded", `Incomplete release asset: ${file.name}`);
		assert.equal(matches[0].size, file.size, `Release asset size differs: ${file.name}`);
		if (matches[0].digest) assert.equal(matches[0].digest, `sha256:${file.sha256}`, `Release asset digest differs: ${file.name}`);
	}
}

export function assertReleaseIdentity(release, sha, notes, draft) {
	assert.ok(Number.isSafeInteger(release?.id) && release.id > 0, "Missing release ID");
	assert.equal(release.tag_name, TAG, "Release tag differs");
	assert.equal(release.target_commitish, sha, "Release source differs");
	assert.equal(release.prerelease, true, "Release must remain a prerelease");
	assert.equal(release.draft, draft, "Unexpected draft/published state");
	assert.equal(release.body, notes, "Release notes differ");
}

// No cleanup/overwrite path: any failure preserves an unpublished draft for inspection.
export async function publishVerifiedDraft(io) {
	await io.guard();
	const draft = await io.create();
	await io.upload(draft);
	await io.verify(draft, true);
	await io.guard(draft);
	await io.publish(draft);
	await io.verify(draft, false);
	return draft;
}
