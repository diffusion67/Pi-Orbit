import type { OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from "electron";

export async function selectSessionFile(
	show: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
): Promise<string | undefined> {
	const result = await show({
		title: "Import Pi session",
		properties: ["openFile"],
		filters: [{ name: "Pi sessions", extensions: ["jsonl"] }],
	});
	return result.canceled ? undefined : result.filePaths[0];
}

export async function selectSessionExportFile(
	show: (options: SaveDialogOptions) => Promise<SaveDialogReturnValue>,
	title: string,
	format: "html" | "jsonl" = "html",
): Promise<string | undefined> {
	const filename =
		title
			.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
			.replace(/[. ]+$/, "")
			.slice(0, 120) || "session";
	const result = await show({
		title: `Export session as ${format.toUpperCase()}`,
		defaultPath: `${filename}.${format}`,
		filters: [{ name: format === "html" ? "HTML" : "Pi sessions", extensions: [format] }],
	});
	return result.canceled ? undefined : result.filePath;
}
