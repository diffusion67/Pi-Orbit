import { randomUUID } from "node:crypto";
import { isWorkerRequest, type WorkerEvent, type WorkerResponse } from "../shared/worker-protocol.ts";

export interface WorkerTransport {
	onMessage(listener: (message: unknown) => void): void;
	onExit(listener: (code: number) => void): void;
	postMessage(message: unknown): void;
	kill(): void;
}

type Pending = {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
};
type Slot = {
	readonly process: WorkerTransport;
	readonly pending: Map<string, Pending>;
	readonly exited: Promise<void>;
	readonly settleExit: () => void;
	expectedExit: boolean;
};

export class WorkerRequestError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "WorkerRequestError";
		this.code = code;
	}
}

function responseFrom(value: unknown): WorkerResponse | undefined {
	if (value === null || typeof value !== "object" || !("id" in value) || typeof value.id !== "string")
		return undefined;
	if (!("ok" in value) || typeof value.ok !== "boolean") return undefined;
	if (value.ok) return value as WorkerResponse;
	if (!("error" in value) || value.error === null || typeof value.error !== "object") return undefined;
	if (!("code" in value.error) || typeof value.error.code !== "string") return undefined;
	if (!("message" in value.error) || typeof value.error.message !== "string") return undefined;
	return value as WorkerResponse;
}

function eventFrom(value: unknown): WorkerEvent | undefined {
	if (value === null || typeof value !== "object" || !("type" in value) || value.type !== "event") return undefined;
	if (!("event" in value) || value.event === null || typeof value.event !== "object") return undefined;
	if (!("type" in value.event) || typeof value.event.type !== "string") return undefined;
	return value as WorkerEvent;
}

/** Owns every live agent worker, rejects outstanding calls on crash, and bounds shutdown. */
export class AgentWorkerManager {
	private readonly slots = new Map<string, Slot>();
	private readonly createProcess: () => WorkerTransport;
	private readonly onEvent: (key: string, event: WorkerEvent["event"]) => void;
	private readonly onUnexpectedExit: (key: string, code: number) => void;

	constructor(options: {
		createProcess: () => WorkerTransport;
		onEvent: (key: string, event: WorkerEvent["event"]) => void;
		onUnexpectedExit: (key: string, code: number) => void;
	}) {
		this.createProcess = options.createProcess;
		this.onEvent = options.onEvent;
		this.onUnexpectedExit = options.onUnexpectedExit;
	}

	has(key: string): boolean {
		return this.slots.has(key);
	}

	async start(key: string, payload: unknown): Promise<unknown> {
		if (this.slots.has(key)) throw new WorkerRequestError("ALREADY_RUNNING", `Worker ${key} is already running`);
		const process = this.createProcess();
		let settleExit = () => {};
		const exited = new Promise<void>((resolve) => {
			settleExit = resolve;
		});
		const slot: Slot = { process, pending: new Map(), exited, settleExit, expectedExit: false };
		this.slots.set(key, slot);
		process.onMessage((message) => {
			const response = responseFrom(message);
			if (response !== undefined) {
				const pending = slot.pending.get(response.id);
				if (pending === undefined) return;
				clearTimeout(pending.timer);
				slot.pending.delete(response.id);
				if (response.ok) pending.resolve(response.data);
				else pending.reject(new WorkerRequestError(response.error.code, response.error.message));
				return;
			}
			const event = eventFrom(message);
			if (event !== undefined) this.onEvent(key, event.event);
		});
		process.onExit((code) => {
			slot.settleExit();
			if (this.slots.get(key) !== slot) return;
			this.slots.delete(key);
			for (const pending of slot.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new WorkerRequestError("WORKER_EXITED", `Worker ${key} exited with code ${code}`));
			}
			slot.pending.clear();
			if (!slot.expectedExit) this.onUnexpectedExit(key, code);
		});
		try {
			return await this.request(key, "init", payload, 30_000);
		} catch (error) {
			slot.expectedExit = true;
			if (this.slots.get(key) === slot) process.kill();
			await this.waitForExit(slot, key);
			throw error;
		}
	}

	private waitForExit(slot: Slot, key: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new WorkerRequestError("WORKER_STOP_TIMEOUT", `Worker ${key} did not exit after kill`)),
				5_000,
			);
			void slot.exited.then(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	request(key: string, type: string, payload: unknown, timeoutMs = 30_000): Promise<unknown> {
		const slot = this.slots.get(key);
		if (slot === undefined) throw new WorkerRequestError("WORKER_NOT_RUNNING", `Worker ${key} is not running`);
		const message = { id: randomUUID(), type, payload };
		if (!isWorkerRequest(message)) throw new WorkerRequestError("INVALID_REQUEST", `Invalid ${type} worker request`);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				slot.pending.delete(message.id);
				reject(new WorkerRequestError("WORKER_TIMEOUT", `Worker ${key} did not answer ${type}`));
			}, timeoutMs);
			slot.pending.set(message.id, { resolve, reject, timer });
			try {
				slot.process.postMessage(message);
			} catch (error) {
				clearTimeout(timer);
				slot.pending.delete(message.id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async stop(key: string): Promise<void> {
		const slot = this.slots.get(key);
		if (slot === undefined) return;
		slot.expectedExit = true;
		try {
			await this.request(key, "shutdown", {}, 5_000);
		} catch {
			// A hung or crashed worker is still terminated below.
		} finally {
			if (this.slots.get(key) === slot) slot.process.kill();
			await this.waitForExit(slot, key);
		}
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.slots.keys()].map((key) => this.stop(key)));
	}
}
