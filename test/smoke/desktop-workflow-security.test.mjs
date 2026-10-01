import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const workflowDirectory = new URL("../../.github/workflows/", import.meta.url);

async function readWorkflow(name) {
	const source = await readFile(new URL(name, workflowDirectory), "utf8");
	return { source, workflow: parse(source) };
}

test("pull-request desktop packaging never receives signing secrets", async () => {
	const { source, workflow } = await readWorkflow("desktop-release-candidate.yml");
	assert.ok(workflow.on.pull_request);
	assert.deepEqual(
		workflow.jobs["package-and-installed-smoke"].strategy.matrix.include.map((entry) => entry.platform),
		["windows", "macos", "linux"],
	);
	assert.doesNotMatch(source, /\$\{\{\s*secrets\./);
});

test("signed candidates require a manual main run and protected environment", async () => {
	const { workflow } = await readWorkflow("desktop-signed-candidate.yml");
	assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
	const gate = workflow.jobs["verify-main-ref"];
	assert.match(gate.steps[0].run, /refs\/heads\/main/);
	assert.equal(gate.permissions.actions, "read");
	assert.match(gate.steps[1].run, /desktop-release-candidate\.yml\/runs/);
	assert.match(gate.steps[1].run, /head_sha=\$GITHUB_SHA&status=success/);
	assert.doesNotMatch(JSON.stringify(gate), /secrets\./);
	const job = workflow.jobs["package-sign-and-smoke"];
	assert.equal(job.needs, "verify-main-ref");
	assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
	assert.equal(job.environment, "desktop-signing");
	assert.deepEqual(
		job.strategy.matrix.include.map((entry) => entry.platform),
		["windows", "macos"],
	);
	assert.doesNotMatch(JSON.stringify({ ...job, steps: [] }), /secrets\./);
	assert.deepEqual(
		job.steps.filter((step) => JSON.stringify(step).includes("secrets.")).map((step) => step.name),
		["Sign and package Windows NSIS installer", "Sign, notarize, and package macOS DMG"],
	);
});
