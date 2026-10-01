import { describe, expect, it, vi } from "vitest";

const duplicate = vi.hoisted(() => ({
	requestSingleInstanceLock: vi.fn(() => false),
	quit: vi.fn(),
	whenReady: vi.fn(() => new Promise<void>(() => {})),
	openDatabase: vi.fn(),
}));

vi.mock("electron", () => ({
	app: {
		requestSingleInstanceLock: duplicate.requestSingleInstanceLock,
		quit: duplicate.quit,
		whenReady: duplicate.whenReady,
		on: vi.fn(),
	},
	BrowserWindow: vi.fn(),
	dialog: { showErrorBox: vi.fn() },
	ipcMain: { handle: vi.fn(), on: vi.fn() },
	shell: { openExternal: vi.fn() },
	utilityProcess: { fork: vi.fn() },
}));
vi.mock("../../src/main/app-service.ts", () => ({ DesktopAppService: { open: duplicate.openDatabase } }));
vi.mock("../../src/main/terminal-service.ts", () => ({ TerminalService: vi.fn() }));

import "../../src/main.ts";

describe("desktop single instance", () => {
	it("exits a duplicate instance before opening or recovering the shared database", () => {
		expect(duplicate.requestSingleInstanceLock).toHaveBeenCalledOnce();
		expect(duplicate.quit).toHaveBeenCalledOnce();
		expect(duplicate.whenReady).not.toHaveBeenCalled();
		expect(duplicate.openDatabase).not.toHaveBeenCalled();
	});
});
