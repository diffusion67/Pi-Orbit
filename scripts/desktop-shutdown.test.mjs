import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CdpConnectionClosedError, closeApp } from "../test/smoke/desktop-shutdown.mjs";

function connection(evaluate) {
	return { evaluate, close: async () => undefined };
}

test("accepts a graceful exit after the quit response", async () => {
	await closeApp(connection(async () => ({ ok: true })), { exitCode: 0, signalCode: null });
});

test("accepts a clean process exit when CDP closes before the quit acknowledgement", async () => {
	const child = { exitCode: null, signalCode: null };
	const closed = connection(async (expression, awaitPromise) => {
		assert.equal(expression, 'window.piOrbit.invoke("app.quit", undefined)');
		assert.equal(awaitPromise, true);
		throw new CdpConnectionClosedError();
	});
	const exited = delay(20).then(() => { child.exitCode = 0; });
	try {
		await closeApp(closed, child);
	} finally {
		await exited;
	}
});

test("does not hide a quit command error even when the process exits cleanly", async () => {
	await assert.rejects(
		closeApp(connection(async () => ({ ok: false, code: "QUIT_FAILED", message: "failed" })), { exitCode: 0, signalCode: null }),
		/QUIT_FAILED/,
	);
});

test("does not hide unrelated CDP errors", async () => {
	await assert.rejects(
		closeApp(connection(async () => { throw new Error("renderer failed"); }), { exitCode: 0, signalCode: null }),
		/renderer failed/,
	);
});

test("rejects a nonzero process exit even after an acknowledged quit", async () => {
	await assert.rejects(closeApp(connection(async () => ({ ok: true })), { exitCode: 1, signalCode: null }), /code 1/);
});

test("rejects a crash after CDP closes", async () => {
	await assert.rejects(
		closeApp(connection(async () => { throw new CdpConnectionClosedError(); }), { exitCode: null, signalCode: "SIGABRT" }),
		/SIGABRT/,
	);
});

test("still rejects and terminates a hung process after CDP closes", async (t) => {
	let now = 0;
	t.mock.method(Date, "now", () => { now += 13_000; return now; });
	t.mock.method(console, "error", () => undefined);
	const child = { exitCode: null, signalCode: null, killed: false, kill() { this.killed = true; } };
	await assert.rejects(
		closeApp(connection(async () => { throw new CdpConnectionClosedError(); }), child),
		/did not exit after app.quit/,
	);
	assert.equal(child.killed, true);
});
