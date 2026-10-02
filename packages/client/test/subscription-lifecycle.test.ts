import { encodeServerMessage, type RpcTarget } from "@earendil-works/pi-protocol";
import { describe, expect, test, vi } from "vitest";
import { type ByteTransportHandlers, Client } from "../src/index.ts";
import { MemoryByteServer } from "./support.ts";

const serverId = "00000000-0000-4000-8000-000000000001";
const serverTarget = { serverId };
const sessionTarget = { serverId, sessionId: "session-1", attachmentId: "attachment-1" };
const snapshot = {
	serviceId: "test.state",
	mode: "singleton",
	instances: [{ members: [{ name: "state", kind: "state", sequence: 0, ops: [["r", { value: 0 }]] }] }],
};

async function connectClient(server: MemoryByteServer): Promise<Client> {
	return Client.connect({ serverId, transportFactory: (handlers) => server.connect(handlers) });
}

describe("subscription lifecycle", () => {
	test.each(["connect", "reconnect"] as const)(
		"preserves live hello and unsubscribe after rejected %s",
		async (method) => {
			const server = new MemoryByteServer();
			const client = await connectClient(server);
			try {
				const opening = client.subscribeService(serverTarget, "test.state", "singleton", () => {});
				server.send({ type: "response", id: "request-1", ok: true, result: snapshot });
				const subscription = await opening;
				const hello = client.hello;

				await expect(client[method]()).rejects.toThrow("already connected");
				expect(client.connected).toBe(true);
				expect(client.hello).toBe(hello);
				const disposing = subscription.dispose();
				expect(server.messages.at(-1)).toMatchObject({
					type: "request",
					target: serverTarget,
					call: { member: "unsubscribe", args: ["service-1"] },
				});
				server.send({ type: "response", id: "request-2", ok: true });
				await disposing;
			} finally {
				await client.dispose();
			}
		},
	);

	test.each<{ scope: string; target: RpcTarget }>([
		{ scope: "server", target: serverTarget },
		{ scope: "session", target: sessionTarget },
	])("unsubscribes exactly once after a cancelled $scope subscription succeeds", async ({ target }) => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		try {
			if ("sessionId" in target) server.send({ type: "attachment", attachment: target });
			const controller = new AbortController();
			const listener = vi.fn();
			const opening = client.subscribeService(target, "test.state", "singleton", listener, controller.signal);
			server.send({
				type: "service_update",
				subscriptionId: "service-1",
				update: { type: "state", member: "state", sequence: 1, ops: [["s", ["value"], 1]] },
			});
			const reason = new Error("cancel subscription");
			const rejected = expect(opening).rejects.toBe(reason);
			controller.abort(reason);
			await rejected;
			// Installation may still be pending. Unsubscribe must wait for its successful response.
			expect(server.messages).toHaveLength(3);
			expect(server.messages[2]).toEqual({ type: "cancel", id: "request-1", target });

			server.send({ type: "response", id: "request-1", ok: true, result: snapshot });
			expect(server.messages).toHaveLength(4);
			expect(server.messages[3]).toMatchObject({
				type: "request",
				id: "request-2",
				target,
				call: { member: "unsubscribe", args: ["service-1"] },
			});
			server.send({ type: "response", id: "request-2", ok: true });
			controller.abort();
			await Promise.resolve();
			expect(server.messages).toHaveLength(4);
			expect(listener).not.toHaveBeenCalled();
			expect(client.connected).toBe(true);
		} finally {
			await client.dispose();
		}
	});

	test("does not unsubscribe when a cancelled subscription fails", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const controller = new AbortController();
		const opening = client.subscribeService(serverTarget, "test.state", "singleton", () => {}, controller.signal);
		const rejected = expect(opening).rejects.toThrow("cancel subscription");
		controller.abort(new Error("cancel subscription"));
		await rejected;
		server.send({
			type: "response",
			id: "request-1",
			ok: false,
			error: { code: "cancelled", message: "subscription was not installed" },
		});
		expect(server.messages).toHaveLength(3);
		expect(client.connected).toBe(true);
		await client.dispose();
	});

	test("does not send a pre-aborted subscription", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const controller = new AbortController();
		controller.abort(new Error("already cancelled"));
		await expect(
			client.subscribeService(serverTarget, "test.state", "singleton", () => {}, controller.signal),
		).rejects.toThrow("already cancelled");
		expect(server.messages).toHaveLength(1);
		await client.dispose();
	});

	test("does not unsubscribe a cancelled subscription on a replaced session attachment", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.send({ type: "attachment", attachment: sessionTarget });
		const controller = new AbortController();
		const opening = client.subscribeService(sessionTarget, "test.state", "singleton", () => {}, controller.signal);
		const rejected = expect(opening).rejects.toThrow("cancel subscription");
		controller.abort(new Error("cancel subscription"));
		await rejected;
		server.send({ type: "attachment", attachment: { ...sessionTarget, attachmentId: "replacement" } });
		server.send({ type: "response", id: "request-1", ok: true, result: snapshot });
		expect(server.messages).toHaveLength(3);
		expect(client.connected).toBe(true);
		await client.dispose();
	});

	test("ignores a cancelled subscription response from a disconnected transport after reconnect", async () => {
		const first = new MemoryByteServer();
		const second = new MemoryByteServer();
		let previousHandlers: ByteTransportHandlers | undefined;
		const client = await Client.connect({
			serverId,
			transportFactory: (handlers) => {
				if (previousHandlers !== undefined) return second.connect(handlers);
				previousHandlers = handlers;
				return first.connect(handlers);
			},
		});
		const controller = new AbortController();
		const opening = client.subscribeService(serverTarget, "test.state", "singleton", () => {}, controller.signal);
		const rejected = expect(opening).rejects.toThrow("cancel subscription");
		controller.abort(new Error("cancel subscription"));
		await rejected;
		first.disconnect();
		await client.reconnect();
		previousHandlers!.onData(encodeServerMessage({ type: "response", id: "request-1", ok: true, result: snapshot }));
		expect(first.messages).toHaveLength(3);
		expect(second.messages).toHaveLength(1);
		expect(client.connected).toBe(true);
		await client.dispose();
	});

	test("reports late unsubscribe failures without replacing the cancellation or disconnecting", async () => {
		const server = new MemoryByteServer();
		const errors: Error[] = [];
		const client = await Client.connect({
			serverId,
			transportFactory: (handlers) => server.connect(handlers),
			onListenerError: (error) => errors.push(error),
		});
		try {
			const controller = new AbortController();
			const opening = client.subscribeService(serverTarget, "test.state", "singleton", () => {}, controller.signal);
			const reason = new Error("cancel subscription");
			const rejected = expect(opening).rejects.toBe(reason);
			controller.abort(reason);
			await rejected;
			server.send({ type: "response", id: "request-1", ok: true, result: snapshot });
			expect(server.messages[3]).toMatchObject({ call: { member: "unsubscribe" } });
			server.send({
				type: "response",
				id: "request-2",
				ok: false,
				error: { code: "internal_error", message: "cleanup failed" },
			});
			await expect.poll(() => errors).toHaveLength(1);
			expect(errors[0]).toMatchObject({ code: "internal_error", message: "cleanup failed" });
			await expect(opening).rejects.toBe(reason);
			expect(client.connected).toBe(true);
			expect(server.messages).toHaveLength(4);
		} finally {
			await client.dispose();
		}
	});

	test("keeps a completed subscription when its request signal is aborted after the response", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const controller = new AbortController();
		const opening = client.subscribeService(serverTarget, "test.state", "singleton", () => {}, controller.signal);
		server.send({ type: "response", id: "request-1", ok: true, result: snapshot });
		controller.abort();
		const subscription = await opening;
		expect(server.messages).toHaveLength(2);
		const disposing = subscription.dispose();
		server.send({ type: "response", id: "request-2", ok: true });
		await disposing;
		await subscription.dispose();
		expect(server.messages).toHaveLength(3);
		await client.dispose();
	});
});
