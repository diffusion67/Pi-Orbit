import { chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform === "darwin") {
	// node-pty's published macOS helper lacks executable bits; its PTY fork uses posix_spawnp.
	const require = createRequire(import.meta.url);
	const packageRoot = dirname(require.resolve("node-pty/package.json"));
	const helpers = [
		join(packageRoot, "build", "Release", "spawn-helper"),
		join(packageRoot, "prebuilds", `darwin-${process.arch}`, "spawn-helper"),
	];
	let found = false;
	for (const helper of helpers) {
		let metadata;
		try {
			metadata = await stat(helper);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			throw error;
		}
		await chmod(helper, metadata.mode | 0o111);
		found = true;
	}
	if (!found) throw new Error("node-pty spawn-helper is missing for this macOS architecture");
}
