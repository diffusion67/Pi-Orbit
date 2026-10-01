import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DesktopAppService } from "../../src/main/app-service.ts";
import type { WorkerTransport } from "../../src/main/worker-manager.ts";
import type { DesktopEvent } from "../../src/shared/desktop-types.ts";

const temporaryRoots: string[] = [];

class FakeWorker implements WorkerTransport {
	private messageListener?: (message: unknown) => void;
	private exitListener?: (code: number) => void;
	private sessionId: string = randomUUID();
	readonly id = randomUUID();

	onMessage(listener: (message: unknown) => void): void {
		this.messageListener = listener;
	}

	onExit(listener: (code: number) => void): void {
		this.exitListener = listener;
	}

	postMessage(value: unknown): void {
		if (value === null || typeof value !== "object" || !("id" in value) || !("type" in value)) return;
		const id = String(value.id);
		const type = String(value.type);
		const payload =
			"payload" in value && value.payload !== null && typeof value.payload === "object" ? value.payload : undefined;
		if (type === "init" && payload && "sessionId" in payload && typeof payload.sessionId === "string") {
			this.sessionId = payload.sessionId;
		}
		const data =
			type === "init" || type === "history"
				? {
						sessionId: this.sessionId,
						sessionFile: join(tmpdir(), `pi-orbit-${this.sessionId}.jsonl`),
						model: null,
						messages: [],
					}
				: type === "resources.list"
					? { skills: [], templates: [], commands: [], extensions: [] }
					: type === "model.list"
						? []
						: { accepted: true };
		this.messageListener?.({ id, ok: true, data });
	}

	kill(): void {
		this.exitListener?.(0);
	}

	exit(code = 1): void {
		this.exitListener?.(code);
	}

	emit(event: unknown): void {
		this.messageListener?.({ type: "event", event });
	}
}

async function waitForEvent(
	events: DesktopEvent[],
	predicate: (event: DesktopEvent) => boolean,
): Promise<DesktopEvent> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const event = events.find(predicate);
		if (event) return event;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for the desktop event");
}

afterEach(async () => {
	for (const root of temporaryRoots.splice(0))
		await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});

describe("desktop worker UI request cleanup", () => {
	it("persists dismissal for an MCP OAuth prompt when its worker exits", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-orbit-ui-dismiss-test-"));
		temporaryRoots.push(root);
		const dataDirectory = join(root, "data");
		const agentDirectory = join(root, "pi");
		const projectPath = join(root, "project");
		await mkdir(projectPath);
		const workers: FakeWorker[] = [];
		const service = await DesktopAppService.open({
			dataDirectory,
			agentDirectory,
			createWorkerTransport: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
		});
		try {
			const opened = await service.invoke("project.open", { path: projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const project = opened.data as { id: string };
			const created = await service.invoke("session.create", { projectId: project.id });
			assert.equal(created.ok, true);
			if (!created.ok) return;
			const session = created.data as { id: string };
			const selected = await service.invoke("session.select", { sessionId: session.id });
			assert.equal(selected.ok, true);

			const startSequence = (await service.snapshot()).lastEventSeq;
			const events: DesktopEvent[] = [];
			const unsubscribe = await service.subscribe(startSequence, (event) => events.push(event));
			const worker = workers.at(-1);
			assert.ok(worker);
			worker.emit({
				type: "ui.request",
				requestId: "oauth-redirect",
				kind: "input",
				title: "Sign in to MCP server docs",
				placeholder: "http://127.0.0.1/callback?code=...",
			});
			const request = await waitForEvent(events, (event) => event.type === "extension.request");
			assert.equal(request.type, "extension.request");
			const requestId = request.request.id;

			worker.exit(1);
			const dismissal = await waitForEvent(
				events,
				(event) => event.type === "extension.dismiss" && event.requestId === requestId,
			);
			assert.equal(dismissal.type, "extension.dismiss");
			if (dismissal.type === "extension.dismiss") assert.equal(dismissal.reason, "closed");
			assert.ok(dismissal.seq > request.seq);

			const replayed: DesktopEvent[] = [];
			const stopReplay = await service.subscribe(startSequence, (event) => replayed.push(event));
			stopReplay();
			assert.ok(replayed.some((event) => event.type === "extension.dismiss" && event.requestId === requestId));
			unsubscribe();
		} finally {
			await service.close();
		}
	});

	it("persists dismissal for an MCP OAuth prompt before graceful shutdown", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-orbit-ui-dismiss-test-"));
		temporaryRoots.push(root);
		const dataDirectory = join(root, "data");
		const agentDirectory = join(root, "pi");
		const projectPath = join(root, "project");
		await mkdir(projectPath);
		const workers: FakeWorker[] = [];
		const openService = () =>
			DesktopAppService.open({
				dataDirectory,
				agentDirectory,
				createWorkerTransport: () => {
					const worker = new FakeWorker();
					workers.push(worker);
					return worker;
				},
			});
		const service = await openService();
		let unsubscribe = () => {};
		try {
			const opened = await service.invoke("project.open", { path: projectPath });
			assert.equal(opened.ok, true);
			if (!opened.ok) return;
			const project = opened.data as { id: string };
			const created = await service.invoke("session.create", { projectId: project.id });
			assert.equal(created.ok, true);
			if (!created.ok) return;
			const session = created.data as { id: string };
			const selected = await service.invoke("session.select", { sessionId: session.id });
			assert.equal(selected.ok, true);

			const startSequence = (await service.snapshot()).lastEventSeq;
			const events: DesktopEvent[] = [];
			unsubscribe = await service.subscribe(startSequence, (event) => events.push(event));
			const worker = workers.at(-1);
			assert.ok(worker);
			worker.emit({
				type: "ui.request",
				requestId: "oauth-redirect",
				kind: "input",
				title: "Sign in to MCP server docs",
				placeholder: "http://127.0.0.1/callback?code=...",
			});
			const request = await waitForEvent(events, (event) => event.type === "extension.request");
			assert.equal(request.type, "extension.request");
			const requestId = request.request.id;

			await service.close();
			const dismissal = events.find((event) => event.type === "extension.dismiss" && event.requestId === requestId);
			assert.ok(dismissal);
			assert.equal(dismissal.type, "extension.dismiss");
			if (dismissal.type === "extension.dismiss") assert.equal(dismissal.reason, "closed");
			assert.ok(dismissal.seq > request.seq);

			const reopened = await openService();
			try {
				const replayed: DesktopEvent[] = [];
				const stopReplay = await reopened.subscribe(startSequence, (event) => replayed.push(event));
				stopReplay();
				const replayedDismissal = replayed.find(
					(event) => event.type === "extension.dismiss" && event.requestId === requestId,
				);
				assert.ok(replayedDismissal);
			} finally {
				await reopened.close();
			}
		} finally {
			unsubscribe();
			await service.close();
		}
	});
});
