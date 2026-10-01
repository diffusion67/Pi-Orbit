import { setTimeout as delay } from "node:timers/promises";

export class CdpConnectionClosedError extends Error {
	constructor() {
		super("CDP connection closed");
		this.name = "CdpConnectionClosedError";
	}
}

export async function closeApp(connection, child) {
	try {
		const result = await connection.evaluate('window.piOrbit.invoke("app.quit", undefined)', true);
		if (!result?.ok) {
			throw new Error(`request graceful application shutdown failed: ${result?.code ?? "UNKNOWN"} ${result?.message ?? ""}`);
		}
	} catch (error) {
		// app.quit can close the debugging socket before its acknowledgement arrives.
		// A transport close is accepted only if the process subsequently exits cleanly.
		if (!(error instanceof CdpConnectionClosedError)) throw error;
	}
	await connection.close().catch(() => undefined);
	const stopAt = Date.now() + 12_000;
	while (Date.now() < stopAt && child.exitCode === null && child.signalCode === null) await delay(100);
	if (child.exitCode === null && child.signalCode === null) {
		let processExists = true;
		try {
			process.kill(child.pid, 0);
		} catch {
			processExists = false;
		}
		console.error(JSON.stringify({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed, processExists }));
		child.kill();
		throw new Error("Installed application did not exit after app.quit");
	}
	if (child.exitCode !== 0 || child.signalCode !== null) {
		throw new Error(`Installed application exited abnormally after app.quit (code ${child.exitCode}, signal ${child.signalCode})`);
	}
}
