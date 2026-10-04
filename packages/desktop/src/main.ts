import { join } from "node:path";
import {
	app,
	BrowserWindow,
	dialog,
	type IpcMainEvent,
	type IpcMainInvokeEvent,
	ipcMain,
	shell,
	utilityProcess,
} from "electron";
import { DesktopAppService } from "./main/app-service.ts";
import { selectProjectDirectory } from "./main/project-dialog.ts";
import { selectSessionExportFile, selectSessionFile } from "./main/session-dialog.ts";
import { TerminalService } from "./main/terminal-service.ts";
import type { WorkerTransport } from "./main/worker-manager.ts";
import type { DesktopEvent } from "./shared/desktop-types.ts";

let window: BrowserWindow | undefined;
let service: DesktopAppService | undefined;
let shuttingDown = false;
const subscriptions = new Map<number, () => void>();

function createWorkerTransport(): WorkerTransport {
	const workerPath = join(app.getAppPath(), "dist", "worker", "agent-worker.js");
	const child = utilityProcess.fork(workerPath, [], { serviceName: "Pi Orbit Agent" });
	return {
		onMessage: (listener) => {
			child.on("message", (message: unknown) => listener(message));
		},
		onExit: (listener) => {
			child.on("exit", listener);
		},
		postMessage: (message) => child.postMessage(message),
		kill: () => {
			child.kill();
		},
	};
}

function trustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
	return (
		window !== undefined && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
	);
}

function installIpc(appService: DesktopAppService): void {
	ipcMain.handle("pi-orbit:invoke", async (event, command: unknown, payload: unknown) => {
		if (!trustedSender(event))
			return { ok: false, code: "UNTRUSTED_FRAME", message: "The request did not come from the app window" };
		const result = await appService.invoke(command, payload);
		if (command === "app.quit" && result.ok) setTimeout(() => app.quit(), 0);
		return result;
	});
	ipcMain.handle("pi-orbit:subscribe", async (event, afterSeq: unknown): Promise<DesktopEvent[]> => {
		if (!trustedSender(event) || !Number.isSafeInteger(afterSeq) || Number(afterSeq) < 0) return [];
		const sender = event.sender;
		subscriptions.get(sender.id)?.();
		const pending: DesktopEvent[] = [];
		const unsubscribe = await appService.subscribe(Number(afterSeq), (item) => {
			if (item.seq <= Number(afterSeq)) return;
			if (!subscriptions.has(sender.id)) pending.push(item);
			else if (!sender.isDestroyed()) sender.send("pi-orbit:event", item);
		});
		subscriptions.set(sender.id, unsubscribe);
		return pending;
	});
	ipcMain.on("pi-orbit:unsubscribe", (event) => {
		if (!trustedSender(event)) return;
		subscriptions.get(event.sender.id)?.();
		subscriptions.delete(event.sender.id);
	});
}

async function createWindow(): Promise<void> {
	const appService = await DesktopAppService.open({
		dataDirectory: app.getPath("userData"),
		createWorkerTransport,
		createTerminalService: (onOutput, onExit) => new TerminalService({ onOutput, onExit }),
		onAuthEvent: (event) => {
			if (window && !window.isDestroyed()) window.webContents.send("pi-orbit:auth-event", event);
		},
		onMcpAuthEvent: (event) => {
			if (window && !window.isDestroyed()) window.webContents.send("pi-orbit:mcp-auth-event", event);
		},
		openExternal: (url) => shell.openExternal(url),
		chooseProjectDirectory: (defaultPath) =>
			selectProjectDirectory(
				(options) =>
					window && !window.isDestroyed()
						? dialog.showOpenDialog(window, options)
						: dialog.showOpenDialog(options),
				defaultPath,
			),
		chooseSessionFile: () =>
			selectSessionFile((options) =>
				window && !window.isDestroyed() ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options),
			),
		chooseSessionExportFile: (title, format) =>
			selectSessionExportFile(
				(options) =>
					window && !window.isDestroyed()
						? dialog.showSaveDialog(window, options)
						: dialog.showSaveDialog(options),
				title,
				format,
			),
	});
	service = appService;
	installIpc(appService);
	const browser = new BrowserWindow({
		width: 1500,
		height: 940,
		minWidth: 1050,
		minHeight: 650,
		backgroundColor: "#111316",
		show: false,
		webPreferences: {
			preload: join(app.getAppPath(), "dist", "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true,
		},
	});
	window = browser;
	browser.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	browser.webContents.on("will-navigate", (event) => event.preventDefault());
	browser.webContents.on("render-process-gone", (_event, details) => {
		dialog.showErrorBox("Pi Orbit renderer stopped", `The desktop interface exited: ${details.reason}`);
	});
	browser.on("ready-to-show", () => {
		if (!browser.isDestroyed()) browser.show();
	});
	const webContentsId = browser.webContents.id;
	browser.on("closed", () => {
		subscriptions.get(webContentsId)?.();
		subscriptions.delete(webContentsId);
		window = undefined;
	});
	const devServer = process.env.PI_ORBIT_DEV_SERVER_URL;
	if (devServer) {
		const url = new URL(devServer);
		if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
			throw new Error("Development server must use loopback HTTP");
		}
		await browser.loadURL(url.toString());
	} else {
		await browser.loadFile(join(app.getAppPath(), "dist", "renderer", "index.html"));
	}
}

// A second writer would recover tasks that are still executing in the first instance.
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (!window || window.isDestroyed()) return;
		if (window.isMinimized()) window.restore();
		window.focus();
	});
	app.on("window-all-closed", () => app.quit());
	app.on("before-quit", (event) => {
		if (shuttingDown || !service) return;
		event.preventDefault();
		shuttingDown = true;
		void service.close().then(
			() => app.exit(0),
			(error: unknown) => {
				console.error("Pi Orbit shutdown failed:", error);
				app.exit(1);
			},
		);
	});

	void app
		.whenReady()
		.then(createWindow)
		.catch((error: unknown) => {
			dialog.showErrorBox("Pi Orbit could not start", error instanceof Error ? error.message : String(error));
			app.quit();
		});
}
