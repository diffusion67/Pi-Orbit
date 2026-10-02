import { describe, expect, it } from "vitest";
import type { DesktopEvent } from "../../renderer/src/contract.ts";
import { extensionRequestQueue } from "../../renderer/src/extension-request-queue.ts";

function request(id: string, seq: number): Extract<DesktopEvent, { type: "extension.request" }> {
	return {
		seq,
		type: "extension.request",
		request: { id, extensionId: `extension-${id}`, title: `Dialog ${id}`, kind: "confirm" },
	};
}

describe("extension request queue", () => {
	const first = request("first", 1);
	const second = request("second", 2);
	const third = request("third", 3);

	it("keeps concurrent requests in arrival order without replacing the visible dialog", () => {
		const initial = extensionRequestQueue([], first);
		const pending = extensionRequestQueue(extensionRequestQueue(initial, second), third);
		expect(pending).toEqual([first, second, third]);
		expect(initial).toEqual([first]);
	});

	it("deduplicates request IDs without changing their position or content", () => {
		const pending = [first, second];
		expect(extensionRequestQueue(pending, request("first", 4))).toEqual(pending);
	});

	it("dismisses a queued request without losing the visible or later dialogs", () => {
		const pending = [first, second, third];
		expect(
			extensionRequestQueue(pending, {
				seq: 4,
				type: "extension.dismiss",
				requestId: second.request.id,
				reason: "timeout",
			}),
		).toEqual([first, third]);
		expect(pending).toEqual([first, second, third]);
	});

	it("advances to the next request when the visible request is dismissed", () => {
		expect(
			extensionRequestQueue([first, second], {
				seq: 3,
				type: "extension.dismiss",
				requestId: first.request.id,
				reason: "closed",
			}),
		).toEqual([second]);
	});

	it("removes only the responded request and preserves requests received while the response was pending", () => {
		const pending = extensionRequestQueue([first, second], third);
		expect(
			extensionRequestQueue(pending, {
				type: "extension.response",
				requestId: first.request.id,
				result: { ok: true, data: { accepted: true } },
			}),
		).toEqual([second, third]);
	});

	it("ignores a late response after its request was dismissed", () => {
		const pending = extensionRequestQueue([first, second], {
			seq: 3,
			type: "extension.dismiss",
			requestId: first.request.id,
			reason: "aborted",
		});
		expect(
			extensionRequestQueue(pending, {
				type: "extension.response",
				requestId: first.request.id,
				result: { ok: true, data: { accepted: true } },
			}),
		).toEqual([second]);
	});

	it.each(["UI_REQUEST_NOT_FOUND", "WORKER_NOT_RUNNING"])("advances past a stale request after %s", (code) => {
		expect(
			extensionRequestQueue([first, second], {
				type: "extension.response",
				requestId: first.request.id,
				result: { ok: false, code, message: code },
			}),
		).toEqual([second]);
	});

	it("retains the request and the queue after a retryable response failure", () => {
		const pending = [first, second];
		expect(
			extensionRequestQueue(pending, {
				type: "extension.response",
				requestId: first.request.id,
				result: { ok: false, code: "COMMAND_FAILED", message: "Try again" },
			}),
		).toEqual(pending);
	});
});
