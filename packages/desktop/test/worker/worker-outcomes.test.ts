import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { WorkerEvent, WorkerResponse } from "../../src/shared/worker-protocol.ts";
import { type DesktopWorkerPort, installDesktopWorker } from "../../src/worker/worker-host.ts";

async function workerHarness() {
	const sent: Array<WorkerEvent | WorkerResponse> = [];
	let receive: ((message: unknown) => void) | undefined;
	let publish: ((event: AgentSessionEvent) => void) | undefined;
	let finishPrompt = () => {};
	let failPrompt = (_error: unknown) => {};
	const port: DesktopWorkerPort = {
		postMessage: (message) => sent.push(message),
		on: (_event, listener) => {
			receive = listener;
			return port;
		},
	};
	const runtime = {
		diagnostics: [],
		session: {
			sessionId: "outcome-session",
			sessionManager: { getBranch: () => [] },
			bindExtensions: async () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				publish = listener;
				return () => {
					publish = undefined;
				};
			},
			prompt: () =>
				new Promise<void>((resolve, reject) => {
					finishPrompt = resolve;
					failPrompt = reject;
				}),
			abort: async () => {
				publish?.({ type: "agent_settled" });
				finishPrompt();
			},
		},
		dispose: async () => {},
	};
	const host = installDesktopWorker(port, { createRuntime: async () => runtime as unknown as AgentSessionRuntime });
	const send = (message: unknown) => receive?.(message);
	const waitResponse = async (id: string) => {
		await expect.poll(() => sent.find((message) => "id" in message && message.id === id)).toBeDefined();
		return sent.find((message) => "id" in message && message.id === id);
	};
	send({ id: "init", type: "init", payload: { cwd: process.cwd() } });
	await waitResponse("init");
	return {
		host,
		sent,
		send,
		waitResponse,
		emit: (event: AgentSessionEvent) => publish?.(event),
		finish: () => finishPrompt(),
		fail: (error: unknown) => failPrompt(error),
		terminal: () =>
			sent.flatMap((message) =>
				"event" in message &&
				message.event.type === "state" &&
				(message.event.state === "idle" || message.event.state === "failed")
					? [message.event]
					: [],
			),
	};
}

describe("desktop worker terminal outcomes", () => {
	// PR #5 review: a settled model error must not release dependent tasks as a success.
	it.each(["invalid_api_key", "overloaded_error"])(
		"reports %s as failure even when prompt resolves",
		async (error) => {
			const worker = await workerHarness();
			try {
				worker.send({ id: "prompt", type: "prompt", payload: { text: "work" } });
				await worker.waitResponse("prompt");
				worker.emit({
					type: "message_end",
					message: fauxAssistantMessage("", { stopReason: "error", errorMessage: error }),
				});
				if (error === "overloaded_error")
					worker.emit({ type: "auto_retry_end", success: false, attempt: 2, finalError: error });
				worker.emit({ type: "agent_settled" });
				worker.finish();
				await expect.poll(() => worker.terminal()).toMatchObject([{ state: "failed", message: error }]);
			} finally {
				await worker.host.close();
			}
		},
	);

	it("allows a successful retry to replace the transient failure", async () => {
		const worker = await workerHarness();
		try {
			worker.send({ id: "prompt", type: "prompt", payload: { text: "work" } });
			await worker.waitResponse("prompt");
			worker.emit({
				type: "message_end",
				message: fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			});
			worker.emit({ type: "message_end", message: fauxAssistantMessage("recovered") });
			worker.emit({ type: "agent_settled" });
			worker.finish();
			await expect.poll(() => worker.terminal()).toMatchObject([{ state: "idle", outcome: "completed" }]);
		} finally {
			await worker.host.close();
		}
	});

	it("reports cancellation without claiming successful completion", async () => {
		const worker = await workerHarness();
		try {
			worker.send({ id: "prompt", type: "prompt", payload: { text: "work" } });
			await worker.waitResponse("prompt");
			worker.send({ id: "abort", type: "abort", payload: {} });
			await worker.waitResponse("abort");
			expect(worker.terminal()).toMatchObject([{ state: "idle", outcome: "aborted" }]);
		} finally {
			await worker.host.close();
		}
	});

	it.each([
		{ error: new Error("settlement failed"), message: "settlement failed" },
		{ error: undefined, message: "undefined" },
	])("does not announce success before a settled prompt rejects: $message", async ({ error, message }) => {
		const worker = await workerHarness();
		try {
			worker.send({ id: "prompt", type: "prompt", payload: { text: "work" } });
			await worker.waitResponse("prompt");
			worker.emit({ type: "agent_settled" });
			worker.fail(error);
			await expect.poll(() => worker.terminal()).toMatchObject([{ state: "failed", message }]);
		} finally {
			await worker.host.close();
		}
	});

	it("correlates terminal outcomes with the original task run across resume", async () => {
		const worker = await workerHarness();
		try {
			worker.send({ id: "prompt-1", type: "prompt", payload: { text: "work", runId: "run-1" } });
			expect(await worker.waitResponse("prompt-1")).toMatchObject({ ok: true });
			worker.send({ id: "abort", type: "abort", payload: {} });
			await worker.waitResponse("abort");
			worker.send({ id: "prompt-2", type: "prompt", payload: { text: "continue", runId: "run-2" } });
			expect(await worker.waitResponse("prompt-2")).toMatchObject({ ok: true });
			worker.emit({ type: "message_end", message: fauxAssistantMessage("done") });
			worker.emit({ type: "agent_settled" });
			worker.finish();
			await expect
				.poll(() => worker.terminal())
				.toMatchObject([
					{ runId: "run-1", state: "idle", outcome: "aborted" },
					{ runId: "run-2", state: "idle", outcome: "completed" },
				]);
		} finally {
			await worker.host.close();
		}
	});
});
