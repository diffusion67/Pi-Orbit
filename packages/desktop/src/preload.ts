import { contextBridge, ipcRenderer } from "electron";
import type { DesktopCommand } from "./shared/commands.ts";
import type { DesktopAuthEvent, DesktopEvent, DesktopMcpAuthEvent, DesktopResult } from "./shared/desktop-types.ts";

// The build step injects the command names from the main process's TypeBox schemas.
declare const __PI_ORBIT_COMMANDS__: readonly DesktopCommand[];
const allowedCommands = new Set<string>(__PI_ORBIT_COMMANDS__);

function eventFrom(value: unknown): DesktopEvent | undefined {
	if (value === null || typeof value !== "object") return undefined;
	if (!("seq" in value) || !Number.isSafeInteger(value.seq) || Number(value.seq) < 1) return undefined;
	if (!("type" in value) || typeof value.type !== "string") return undefined;
	return value as DesktopEvent;
}

function authEventFrom(value: unknown): DesktopAuthEvent | undefined {
	if (value === null || typeof value !== "object") return undefined;
	if (!("flowId" in value) || typeof value.flowId !== "string") return undefined;
	if (!("type" in value) || typeof value.type !== "string") return undefined;
	return value as DesktopAuthEvent;
}

function mcpAuthEventFrom(value: unknown): DesktopMcpAuthEvent | undefined {
	if (value === null || typeof value !== "object") return undefined;
	if (!("sessionId" in value) || typeof value.sessionId !== "string") return undefined;
	if (!("serverName" in value) || typeof value.serverName !== "string") return undefined;
	if (!("url" in value) || typeof value.url !== "string") return undefined;
	return value as DesktopMcpAuthEvent;
}

if (process.isMainFrame) {
	contextBridge.exposeInMainWorld("piOrbit", {
		invoke: async (command: unknown, payload: unknown): Promise<DesktopResult<unknown>> => {
			if (
				typeof command !== "string" ||
				!allowedCommands.has(command) ||
				(payload !== undefined && (payload === null || typeof payload !== "object" || Array.isArray(payload)))
			) {
				return { ok: false, code: "INVALID_ARGUMENT", message: "Invalid command or request payload" };
			}
			try {
				return (await ipcRenderer.invoke("pi-orbit:invoke", command, payload)) as DesktopResult<unknown>;
			} catch {
				return { ok: false, code: "IPC_UNAVAILABLE", message: "The application process is unavailable" };
			}
		},
		subscribe: (afterSeq: number, listener: (event: DesktopEvent) => void): (() => void) => {
			if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError("Invalid event sequence");
			let active = true;
			let replaying = true;
			let lastSeq = afterSeq;
			const queued: DesktopEvent[] = [];
			const deliver = (candidate: unknown): void => {
				const event = eventFrom(candidate);
				if (!event || event.seq <= lastSeq || !active) return;
				lastSeq = event.seq;
				listener(event);
			};
			const onLive = (_event: Electron.IpcRendererEvent, candidate: unknown): void => {
				const event = eventFrom(candidate);
				if (!event || !active) return;
				if (replaying) queued.push(event);
				else deliver(event);
			};
			ipcRenderer.on("pi-orbit:event", onLive);
			void ipcRenderer
				.invoke("pi-orbit:subscribe", afterSeq)
				.then((history: unknown) => {
					if (!active) return;
					const all = [...(Array.isArray(history) ? history : []), ...queued]
						.map(eventFrom)
						.filter((event): event is DesktopEvent => event !== undefined)
						.sort((a, b) => a.seq - b.seq);
					replaying = false;
					for (const event of all) deliver(event);
				})
				.catch(() => {
					replaying = false;
				});
			return () => {
				active = false;
				ipcRenderer.removeListener("pi-orbit:event", onLive);
				ipcRenderer.send("pi-orbit:unsubscribe");
			};
		},
		subscribeAuth: (listener: (event: DesktopAuthEvent) => void): (() => void) => {
			const onAuthEvent = (_event: Electron.IpcRendererEvent, candidate: unknown): void => {
				const event = authEventFrom(candidate);
				if (event) listener(event);
			};
			ipcRenderer.on("pi-orbit:auth-event", onAuthEvent);
			return () => ipcRenderer.removeListener("pi-orbit:auth-event", onAuthEvent);
		},
		subscribeMcpAuth: (listener: (event: DesktopMcpAuthEvent) => void): (() => void) => {
			const onMcpAuth = (_event: Electron.IpcRendererEvent, candidate: unknown): void => {
				const event = mcpAuthEventFrom(candidate);
				if (event) listener(event);
			};
			ipcRenderer.on("pi-orbit:mcp-auth-event", onMcpAuth);
			return () => ipcRenderer.removeListener("pi-orbit:mcp-auth-event", onMcpAuth);
		},
	});
}
