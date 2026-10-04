import type { SaveDialogOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { selectSessionExportFile, selectSessionFile } from "../../src/main/session-dialog.ts";

describe("native session file dialogs", () => {
	it("filters imports to Pi JSONL and ignores cancellation", async () => {
		const show = vi.fn(async () => ({ canceled: false, filePaths: ["C:\\项目\\session.jsonl"] }));
		expect(await selectSessionFile(show)).toBe("C:\\项目\\session.jsonl");
		expect(show).toHaveBeenCalledWith({
			title: "Import Pi session",
			properties: ["openFile"],
			filters: [{ name: "Pi sessions", extensions: ["jsonl"] }],
		});
		expect(await selectSessionFile(async () => ({ canceled: true, filePaths: ["ignored"] }))).toBeUndefined();
	});
	it.each(["html", "jsonl"] as const)("uses a safe filename and chosen %s format", async (format) => {
		const show = vi.fn(async (_options: SaveDialogOptions) => ({
			canceled: false,
			filePath: `/tmp/export.${format}`,
		}));
		expect(await selectSessionExportFile(show, "A/B:项目. ", format)).toBe(`/tmp/export.${format}`);
		expect(show.mock.calls[0]?.[0]).toMatchObject({
			defaultPath: `A-B-项目.${format}`,
			filters: [{ extensions: [format] }],
		});
	});
	it("returns no export path on cancellation and propagates dialog failures", async () => {
		expect(
			await selectSessionExportFile(async () => ({ canceled: true, filePath: "ignored" }), "Session"),
		).toBeUndefined();
		await expect(
			selectSessionFile(async () => {
				throw new Error("Dialog failed");
			}),
		).rejects.toThrow("Dialog failed");
	});
});
