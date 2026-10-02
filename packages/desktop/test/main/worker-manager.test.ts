import { describe, expect, it } from "vitest";
import { AgentWorkerManager, type WorkerTransport } from "../../src/main/worker-manager.ts";

class FakeWorker implements WorkerTransport {
	private onMessageCallback: (message: unknown) => void = () => {};
	private onExitCallback: (code: number) => void = () => {};
	readonly requests: Array<{ id: string; type: string }> = [];
	killed = false;
	exitOnKill = true;

	onMessage(listener: (message: unknown) => void): void {
		this.onMessageCallback = listener;
	}
	onExit(listener: (code: number) => void): void {
		this.onExitCallback = listener;
	}
	postMessage(message: unknown): void {
		if (
			message &&
			typeof message === "object" &&
			"id" in message &&
			"type" in message &&
			typeof message.id === "string" &&
			typeof message.type === "string"
		) {
			this.requests.push({ id: message.id, type: message.type });
		}
	}
	kill(): void {
		this.killed = true;
		if (this.exitOnKill) this.onExitCallback(0);
	}
	respond(index: number, data: unknown): void {
		this.onMessageCallback({ id: this.requests[index].id, ok: true, data });
	}
	reject(index: number): void {
		this.onMessageCallback({
			id: this.requests[index].id,
			ok: false,
			error: { code: "INIT_FAILED", message: "failed" },
		});
	}
	exit(code: number): void {
		this.onExitCallback(code);
	}
	emit(message: unknown): void {
		this.onMessageCallback(message);
	}
}

describe("AgentWorkerManager", () => {
	// PR #5 review: late messages from an exited process cannot belong to its replacement.
	it("ignores messages from an exited worker after the same key is reused", async () => {
		const workers = [new FakeWorker(), new FakeWorker()];
		let next = 0;
		const events: unknown[] = [];
		const manager = new AgentWorkerManager({
			createProcess: () => workers[next++]!,
			onEvent: (_key, event) => events.push(event),
			onUnexpectedExit: () => {},
		});
		const first = manager.start("task", { cwd: process.cwd() });
		workers[0]!.respond(0, { sessionId: "first" });
		await first;
		workers[0]!.exit(1);
		const second = manager.start("task", { cwd: process.cwd() });
		workers[1]!.respond(0, { sessionId: "second" });
		await second;
		workers[0]!.emit({ type: "event", event: { type: "ui.request", requestId: "ui-1" } });
		workers[1]!.emit({ type: "event", event: { type: "ui.request", requestId: "ui-2" } });
		expect(events).toEqual([{ type: "ui.request", requestId: "ui-2" }]);
		workers[1]!.exit(0);
	});

	it("waits for a failed initialization worker to exit before releasing its slot", async () => {
		const worker = new FakeWorker();
		worker.exitOnKill = false;
		const manager = new AgentWorkerManager({
			createProcess: () => worker,
			onEvent: () => {},
			onUnexpectedExit: () => {},
		});
		const started = manager.start("session", { cwd: process.cwd() });
		const startFailure = expect(started).rejects.toMatchObject({ code: "INIT_FAILED" });
		worker.reject(0);
		await Promise.resolve();
		await Promise.resolve();
		expect(worker.killed).toBe(true);
		expect(manager.has("session")).toBe(true);
		worker.exit(1);
		await startFailure;
		expect(manager.has("session")).toBe(false);
	});

	it("waits for the utility process to exit during shutdown", async () => {
		const worker = new FakeWorker();
		worker.exitOnKill = false;
		const manager = new AgentWorkerManager({
			createProcess: () => worker,
			onEvent: () => {},
			onUnexpectedExit: () => {},
		});
		const started = manager.start("session", { cwd: process.cwd() });
		worker.respond(0, { sessionId: "session" });
		await started;
		let stopped = false;
		const stopping = manager.stop("session").then(() => {
			stopped = true;
		});
		worker.respond(1, { closing: true });
		await Promise.resolve();
		await Promise.resolve();
		expect(worker.killed).toBe(true);
		expect(stopped).toBe(false);
		worker.exit(0);
		await stopping;
		expect(stopped).toBe(true);
	});

	it("rejects pending requests and reports an unexpected worker exit", async () => {
		const worker = new FakeWorker();
		const exits: Array<[string, number]> = [];
		const manager = new AgentWorkerManager({
			createProcess: () => worker,
			onEvent: () => {},
			onUnexpectedExit: (key, code) => exits.push([key, code]),
		});
		const started = manager.start("session", { cwd: process.cwd() });
		worker.respond(0, { sessionId: "session" });
		await started;
		const pending = manager.request("session", "prompt", { text: "hello" });
		worker.exit(9);
		await expect(pending).rejects.toMatchObject({ code: "WORKER_EXITED" });
		expect(exits).toEqual([["session", 9]]);
		expect(manager.has("session")).toBe(false);
	});
});
