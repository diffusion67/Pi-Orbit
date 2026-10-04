import { describe, expect, it, vi } from "vitest";
import { selectProjectDirectory } from "../../src/main/project-dialog.ts";

describe("native project directory picker", () => {
	it.each(["C:\\work\\项目", "/Users/person/项目", "/home/person/项目"])(
		"returns the selected directory %s",
		async (path) => {
			const show = vi.fn(async () => ({ canceled: false, filePaths: [path] }));
			expect(await selectProjectDirectory(show, path)).toBe(path);
			expect(show).toHaveBeenCalledWith({ properties: ["openDirectory"], defaultPath: path });
		},
	);

	it("returns no selection after cancellation even if the dialog supplies a path", async () => {
		expect(await selectProjectDirectory(async () => ({ canceled: true, filePaths: ["ignored"] }))).toBeUndefined();
	});

	it("handles an empty selection and propagates dialog errors", async () => {
		expect(await selectProjectDirectory(async () => ({ canceled: false, filePaths: [] }))).toBeUndefined();
		await expect(
			selectProjectDirectory(async () => {
				throw new Error("Dialog failed");
			}),
		).rejects.toThrow("Dialog failed");
	});
});
