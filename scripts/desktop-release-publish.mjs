import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertFreshRelease, assertInstallerFormat, assertPublicationGate, assertReleaseAssets, assertReleaseIdentity, assertTrustedRun,
	getArchiveInstaller, getPackagingArchitecture, getReleaseAssetName, PLATFORMS, publishVerifiedDraft, REPOSITORY, selectArtifact,
	TAG, UPSTREAM_SHA, verifyInstallerChecksum, VERSION, WORKFLOWS,
} from "./desktop-release-helpers.mjs";

const apiRoot = `repos/${REPOSITORY}`;
const apiHeaders = ["-H", "X-GitHub-Api-Version: 2022-11-28", "-H", "Cache-Control: no-cache"];

function command(binary, args, options = {}) {
	return execFileSync(binary, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
}

function json(endpoint, args = []) {
	return JSON.parse(command("gh", ["api", `${apiRoot}/${endpoint}`, ...apiHeaders, ...args]));
}

function list(endpoint, key) {
	const pages = json(endpoint, ["--paginate", "--slurp"]);
	return pages.flatMap((page) => key ? page[key] : page);
}

function download(endpoint, destination, binary = false) {
	const fd = openSync(destination, "wx", 0o600);
	try {
		command("gh", ["api", `${apiRoot}/${endpoint}`, ...apiHeaders,
			...(binary ? ["-H", "Accept: application/octet-stream"] : [])], { stdio: ["ignore", fd, "pipe"] });
	} finally {
		closeSync(fd);
	}
}

async function fileInfo(path, name) {
	const sha = createHash("sha256");
	for await (const chunk of createReadStream(path)) sha.update(chunk);
	return { path, name, sha256: sha.digest("hex"), size: statSync(path).size };
}

function readGate(env, event, version) {
	const sourceSha = event.workflow_run.head_sha;
	const gate = {
		repository: env.GITHUB_REPOSITORY, eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF,
		sourceSha, version, trigger: event.workflow_run,
		liveSha: json("git/ref/heads/main").object.sha,
	};
	for (const [key, expected] of Object.entries(WORKFLOWS)) {
		const workflow = json(`actions/workflows/${expected.path.split("/").at(-1)}`);
		assert.equal(workflow.path, expected.path, "Workflow path differs");
		assert.equal(workflow.name, expected.name, "Workflow name differs");
		// Do not filter on success/completed: a newer pending or failed run must block an older green run.
		const latest = json(`actions/workflows/${workflow.id}/runs?branch=main&event=push&per_page=1`).workflow_runs[0];
		if (!latest) throw new Error(`No main push run for ${expected.name}`);
		const run = json(`actions/runs/${latest.id}`);
		const jobs = list(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, "jobs");
		gate[key] = { workflow, run, jobs };
	}
	return gate;
}

function currentReleaseState() {
	return {
		releases: list("releases?per_page=100"),
		refs: list(`git/matching-refs/tags/${TAG}?per_page=100`),
	};
}

function assertTag(refs, sha, required) {
	const matches = refs.filter((ref) => ref.ref === `refs/tags/${TAG}`);
	assert.ok(matches.length === 1 || (!required && matches.length === 0), "Missing or duplicate release tag");
	for (const ref of matches) {
		assert.equal(ref.object.type, "commit", "Unexpected release tag type");
		assert.equal(ref.object.sha, sha, "Release tag points to a different commit");
	}
}

async function main() {
	const env = process.env;
	assert.equal(env.GITHUB_ACTIONS, "true", "Publication runs only in GitHub Actions");
	assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, "Wrong repository");
	assert.equal(env.GITHUB_EVENT_NAME, "workflow_run", "Wrong event");
	assert.equal(env.GITHUB_REF, "refs/heads/main", "Wrong workflow ref");
	const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
	assert.equal(event.repository?.full_name, REPOSITORY, "Wrong event repository");
	const trigger = event.workflow_run;
	const triggerWorkflow = Object.values(WORKFLOWS).find((workflow) => workflow.path === trigger?.path?.split("@")[0]);
	assert.ok(triggerWorkflow, "Unexpected trigger workflow");
	assertTrustedRun(trigger, { ...triggerWorkflow, id: trigger.workflow_id }, trigger.head_sha);
	assert.equal(command("git", ["rev-parse", "HEAD"]).trim(), trigger.head_sha, "Checkout does not match source");
	const version = JSON.parse(readFileSync("packages/desktop/package.json", "utf8")).version;
	assert.equal(version, VERSION, "Outside the single approved desktop version");
	const gate = readGate(env, event, version);
	if (gate.liveSha !== gate.sourceSha || [gate.ci, gate.desktop].some(({ run }) =>
		run.head_sha !== gate.sourceSha || run.status !== "completed" || run.conclusion !== "success")) {
		console.log("No publication: current main does not yet have both successful prerequisite runs.");
		return;
	}
	assertPublicationGate(gate);
	const initialState = currentReleaseState();
	const existing = initialState.releases.filter((release) => release.tag_name === TAG);
	assert.ok(existing.length <= 1, "Duplicate releases for the approved tag");
	// A completed second trigger may verify an existing publication, but never edit or resume it.
	if (existing.length) {
		assert.equal(existing[0].draft, false, "Existing draft requires manual inspection; refusing to resume it");
		assert.equal(existing[0].target_commitish, gate.sourceSha, "Existing release belongs to another source");
		assertTag(initialState.refs, gate.sourceSha, true);
	} else {
		assertFreshRelease(initialState.releases, initialState.refs);
	}

	const work = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "pi-orbit-release-"));
	const assetsDir = join(work, "assets");
	mkdirSync(assetsDir);
	const artifacts = list(`actions/runs/${gate.desktop.run.id}/artifacts?per_page=100`, "artifacts");
	const installers = [];
	for (const [platform, config] of Object.entries(PLATFORMS)) {
		const artifact = selectArtifact(artifacts, platform, gate.desktop.run, event.repository.id);
		const job = gate.desktop.jobs.find((item) => item.name === `${platform} desktop artifact`);
		// Reruns may leave old artifacts behind. Require upload during this validated job, not a prior attempt.
		assert.ok(Date.parse(artifact.created_at) >= Date.parse(job.started_at) &&
			Date.parse(artifact.created_at) <= Date.parse(job.completed_at), "Artifact predates the validated job attempt");
		const log = command("gh", ["api", `${apiRoot}/actions/jobs/${job.id}/logs`, ...apiHeaders]);
		const arch = getPackagingArchitecture(log, platform);
		const archive = join(work, `${platform}.zip`);
		download(`actions/artifacts/${artifact.id}/zip`, archive);
		if (artifact.digest) {
			assert.equal(`sha256:${(await fileInfo(archive, `${platform}.zip`)).sha256}`, artifact.digest, "Artifact archive digest differs");
		}
		const entries = command("unzip", ["-Z1", archive]).trimEnd().split(/\r?\n/);
		const archiveName = getArchiveInstaller(entries, platform);
		const name = getReleaseAssetName(archiveName);
		assert.ok(!installers.some((file) => file.name === name), "Duplicate release filename");
		const path = join(assetsDir, name);
		const fd = openSync(path, "wx", 0o600);
		try {
			// Never extract paths, symlinks, scripts or executable metadata from the archive.
			// -p sends the one allowlisted member's bytes to an already-opened local file.
			command("unzip", ["-p", archive, archiveName], { stdio: ["ignore", fd, "pipe"] });
		} finally {
			closeSync(fd);
		}
		const file = await fileInfo(path, name);
		assert.ok(file.size >= 512 && file.size < 2_000_000_000, "Invalid installer size");
		const installerFd = openSync(path, "r");
		try {
			const prefix = Buffer.alloc(Math.min(file.size, 65536));
			const suffix = Buffer.alloc(512);
			readSync(installerFd, prefix, 0, prefix.length, 0);
			readSync(installerFd, suffix, 0, suffix.length, file.size - 512);
			assertInstallerFormat(platform, arch, prefix, suffix);
		} finally {
			closeSync(installerFd);
		}
		verifyInstallerChecksum(command("unzip", ["-p", archive, "SHA256SUMS"]), archiveName, file.sha256);
		installers.push({ ...file, platform, arch, label: config.label, jobId: job.id });
	}
	const replacements = {
		SOURCE_SHA: gate.sourceSha,
		UPSTREAM_SHA,
		CI_RUN_URL: `https://github.com/${REPOSITORY}/actions/runs/${gate.ci.run.id}`,
		DESKTOP_RUN_URL: `https://github.com/${REPOSITORY}/actions/runs/${gate.desktop.run.id}`,
		ARTIFACTS: installers.map((file) => `- ${file.label} ${file.arch}: \`${file.name}\` (${file.size} bytes); [架构构建记录](https://github.com/${REPOSITORY}/actions/runs/${gate.desktop.run.id}/job/${file.jobId})`).join("\n"),
		CHECKSUMS: installers.map((file) => `${file.sha256}  ${file.name}`).join("\n"),
	};
	let notes = readFileSync(`packages/desktop/docs/releases/${VERSION}.md`, "utf8");
	for (const [key, value] of Object.entries(replacements)) notes = notes.replaceAll(`{{${key}}}`, value);
	assert.ok(!notes.includes("{{"), "Unresolved release-note field");
	const notesPath = join(assetsDir, "RELEASE_NOTES.md");
	writeFileSync(notesPath, notes, { flag: "wx" });
	const files = [...installers, await fileInfo(notesPath, "RELEASE_NOTES.md")];
	const sumsPath = join(assetsDir, "SHA256SUMS");
	writeFileSync(sumsPath, `${files.map((file) => `${file.sha256}  ${file.name}`).join("\n")}\n`, { flag: "wx" });
	files.push(await fileInfo(sumsPath, "SHA256SUMS"));

	const verify = async (draft, isDraft) => {
		const release = json(`releases/${draft.id}`);
		assertReleaseIdentity(release, gate.sourceSha, notes, isDraft);
		const remote = list(`releases/${draft.id}/assets?per_page=100`);
		assertReleaseAssets(remote, files);
		const destination = mkdtempSync(join(work, "verify-"));
		for (const file of files) {
			const asset = remote.find((item) => item.name === file.name);
			const path = join(destination, file.name);
			download(`releases/assets/${asset.id}`, path, true);
			const downloaded = await fileInfo(path, file.name);
			assert.equal(downloaded.size, file.size, `Downloaded release size differs: ${file.name}`);
			assert.equal(downloaded.sha256, file.sha256, `Downloaded release hash differs: ${file.name}`);
		}
		if (!isDraft) assertTag(currentReleaseState().refs, gate.sourceSha, true);
	};
	if (existing.length) {
		await verify(existing[0], false);
		console.log(`Already published and independently verified: https://github.com/${REPOSITORY}/releases/tag/${TAG}`);
		return;
	}

	await publishVerifiedDraft({
		guard: async (draft) => {
			const fresh = readGate(env, event, version);
			assertPublicationGate(fresh);
			for (const key of Object.keys(WORKFLOWS)) {
				assert.equal(fresh[key].run.id, gate[key].run.id, "Latest prerequisite run changed");
				assert.equal(fresh[key].run.run_attempt, gate[key].run.run_attempt, "Prerequisite run was retried");
			}
			const state = currentReleaseState();
			if (!draft) assertFreshRelease(state.releases, state.refs);
			else {
				const matches = state.releases.filter((release) => release.tag_name === TAG);
				assert.equal(matches.length, 1, "Draft changed during verification");
				assert.equal(matches[0].id, draft.id, "Draft identity changed");
				assertReleaseIdentity(matches[0], gate.sourceSha, notes, true);
				assertTag(state.refs, gate.sourceSha, false);
			}
		},
		create: async () => {
			const input = join(work, "create-release.json");
			writeFileSync(input, JSON.stringify({
				tag_name: TAG, target_commitish: gate.sourceSha, name: `Pi Orbit ${VERSION} (unsigned)`,
				body: notes, draft: true, prerelease: true, make_latest: "false",
			}), { flag: "wx" });
			const draft = json("releases", ["--method", "POST", "--input", input]);
			assertReleaseIdentity(draft, gate.sourceSha, notes, true);
			console.log(`Created draft ${draft.id}; failures leave it intact for manual inspection.`);
			return draft;
		},
		upload: async (draft) => {
			// Address the newly created release ID directly, not a mutable tag lookup.
			// POST rejects duplicate names; there is intentionally no delete/overwrite path.
			for (const file of files) {
				const endpoint = `https://uploads.github.com/${apiRoot}/releases/${draft.id}/assets?name=${encodeURIComponent(file.name)}`;
				command("gh", ["api", endpoint, ...apiHeaders, "--method", "POST",
					"-H", "Content-Type: application/octet-stream", "--input", file.path]);
			}
		},
		verify,
		publish: async (draft) => {
			const input = join(work, "publish-release.json");
			writeFileSync(input, JSON.stringify({ draft: false, prerelease: true, make_latest: "false" }), { flag: "wx" });
			assert.equal(json("git/ref/heads/main").object.sha, gate.sourceSha, "main moved immediately before publication");
			json(`releases/${draft.id}`, ["--method", "PATCH", "--input", input]);
		},
	});
	console.log(`Published and downloaded for verification: https://github.com/${REPOSITORY}/releases/tag/${TAG}`);
}

main().catch((error) => {
	console.error(error.message);
	console.error("Publication stopped. No existing release, tag or asset was deleted or overwritten; inspect any retained draft.");
	process.exitCode = 1;
});
