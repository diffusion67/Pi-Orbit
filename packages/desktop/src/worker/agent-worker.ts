import type { WorkerEvent, WorkerResponse } from "../shared/worker-protocol.ts";
import { type DesktopWorkerPort, installDesktopWorker } from "./worker-host.ts";

type ElectronParentPort = {
	postMessage(message: unknown): void;
	on(event: "message", listener: (event: { readonly data: unknown }) => void): void;
	off(event: "message", listener: (event: { readonly data: unknown }) => void): void;
};

const parentPort = Reflect.get(process, "parentPort") as ElectronParentPort | undefined;
if (!parentPort) throw new Error("Pi Orbit agent worker must be started with Electron utilityProcess.fork()");

const listeners = new Map<(message: unknown) => void, (event: { readonly data: unknown }) => void>();
const port: DesktopWorkerPort = {
	postMessage(message: WorkerResponse | WorkerEvent): void {
		parentPort.postMessage(message);
	},
	on(_event, listener) {
		const wrapped = (event: { readonly data: unknown }) => listener(event.data);
		listeners.set(listener, wrapped);
		parentPort.on("message", wrapped);
		return this;
	},
	off(_event, listener) {
		const wrapped = listeners.get(listener);
		if (wrapped) parentPort.off("message", wrapped);
		listeners.delete(listener);
		return this;
	},
};

installDesktopWorker(port, { onShutdown: () => setImmediate(() => process.exit(0)) });
