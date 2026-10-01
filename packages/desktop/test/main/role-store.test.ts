import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RoleStore } from "../../src/main/role-store.ts";

describe("RoleStore", () => {
	it("round trips project Markdown roles without exposing arbitrary paths", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-roles-"));
		try {
			const roles = new RoleStore(join(directory, "user-config"));
			const saved = await roles.save(
				{
					id: "new",
					name: "Code reviewer",
					description: "Review changes",
					model: "openai/gpt",
					tools: ["read", "bash"],
					scope: "project",
					systemPrompt: "Check the diff.\nUse tests.",
				},
				directory,
			);
			expect(saved.id).toBe("project:code-reviewer");
			expect(await roles.list(directory)).toEqual([saved]);
			const content = await readFile(join(directory, ".pi", "agents", "code-reviewer.md"), "utf8");
			expect(content).toContain("Check the diff.");
			await expect(roles.save({ ...saved, id: "project:../outside" }, directory)).resolves.toMatchObject({
				id: "project:code-reviewer",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
