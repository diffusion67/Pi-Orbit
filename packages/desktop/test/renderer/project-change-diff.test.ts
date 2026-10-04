import { describe, expect, it } from "vitest";
import { isBinaryProjectDiff, parseProjectDiff } from "../../renderer/src/project-change-diff.ts";

describe("project diff display", () => {
	it("tracks old and new line numbers across removals and additions", () => {
		const lines = parseProjectDiff("diff --git a/file.ts b/file.ts\n@@ -4,2 +4,3 @@\n keep\n-old\n+new\n+extra");
		expect(lines.map(({ kind, oldLine, newLine }) => [kind, oldLine, newLine])).toEqual([
			["meta", null, null],
			["hunk", null, null],
			["context", 4, 4],
			["deleted", 5, null],
			["added", null, 5],
			["added", null, 6],
		]);
	});

	it("recognizes binary patches and leaves text diffs as text", () => {
		expect(isBinaryProjectDiff("Binary files a/image.png and b/image.png differ")).toBe(true);
		expect(isBinaryProjectDiff("+const changed = true;")).toBe(false);
	});
});
