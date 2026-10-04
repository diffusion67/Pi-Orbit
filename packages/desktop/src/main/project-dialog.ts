import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";

/** Electron uses the native directory dialog on Windows, macOS and Linux. */
export async function selectProjectDirectory(
	showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
	defaultPath?: string,
): Promise<string | undefined> {
	const result = await showOpenDialog({
		properties: ["openDirectory"],
		...(defaultPath ? { defaultPath } : {}),
	});
	return result.canceled ? undefined : result.filePaths[0];
}
