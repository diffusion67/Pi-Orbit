import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const desktop = JSON.parse(readFileSync(new URL("packages/desktop/package.json", root), "utf8"));
const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
const workspaces = readdirSync(new URL("packages/", root), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => ({
		path: `packages/${entry.name}`,
		manifest: JSON.parse(readFileSync(new URL(`packages/${entry.name}/package.json`, root), "utf8")),
	}));

test("desktop runtime dependencies use the current workspace versions", () => {
	for (const { manifest } of workspaces) {
		const specifier = desktop.dependencies[manifest.name];
		if (specifier === undefined) continue;
		assert.equal(specifier, manifest.version, `${manifest.name} must resolve to the synchronized workspace`);
	}
});

test("desktop lockfile links runtime workspaces without stale nested registry copies", () => {
	assert.deepEqual(lock.packages["packages/desktop"].dependencies, desktop.dependencies);
	for (const { path, manifest } of workspaces) {
		if (desktop.dependencies[manifest.name] === undefined) continue;
		assert.deepEqual(lock.packages[`node_modules/${manifest.name}`], { resolved: path, link: true });
		assert.equal(lock.packages[`packages/desktop/node_modules/${manifest.name}`], undefined);
	}
});
