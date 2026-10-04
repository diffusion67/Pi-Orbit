import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["test/**/*.test.ts"],
			exclude: [
				"test/extensions/desktop-ui-context.test.ts",
				"test/git/worktrees.test.ts",
				"test/main/app-service.test.ts",
				"test/main/codex-adaptations.test.ts",
				"test/main/session-message.test.ts",
				"test/main/worker-ui-dismiss.test.ts",
			],
		},
		resolve: {
			conditions: ["source"],
			alias: [
				{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex },
				{
					find: /^@earendil-works\/pi-durable\/storage\/sqlite\/node$/,
					replacement: fileURLToPath(new URL("../durable/src/storage/sqlite/node.ts", import.meta.url)),
				},
			],
		},
		ssr: { resolve: { conditions: ["source"] } },
	}),
);
