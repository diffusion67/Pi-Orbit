import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { DesktopAppService } from "../../src/main/app-service.ts";
import type { WorkerTransport } from "../../src/main/worker-manager.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

class MockWorker implements WorkerTransport {
	private messageListener?: (message: unknown) => void;
	private exitListener?: (code: number) => void;
	readonly requests: Array<{ type: string; payload: unknown }> = [];
	private sessionId: string = randomUUID();

	onMessage(listener: (message: unknown) => void): void {
		this.messageListener = listener;
	}

	onExit(listener: (code: number) => void): void {
		this.exitListener = listener;
	}

	postMessage(message: unknown): void {
		if (!isRecord(message) || typeof message.id !== "string" || typeof message.type !== "string") return;
		const { id, type, payload } = message;
		this.requests.push({ type, payload });
		if (type === "init" && isRecord(payload) && typeof payload.sessionFile === "string") {
			const match = /pi-orbit-([a-f0-9-]+)\.jsonl$/i.exec(payload.sessionFile);
			if (match?.[1]) this.sessionId = match[1];
		}
		const session = {
			sessionId: this.sessionId,
			sessionFile: join(tmpdir(), `pi-orbit-${this.sessionId}.jsonl`),
			model: null,
			messages: [],
		};
		const data =
			type === "init" || type === "history"
				? session
				: type === "model.list"
					? []
					: type === "resources.list"
						? { skills: [], templates: [], commands: [], extensions: [] }
						: type === "prompt"
							? { accepted: true }
							: type === "message"
								? { accepted: true, delivery: isRecord(payload) ? payload.deliverAs : undefined }
								: { closing: true };
		this.messageListener?.({ id, ok: true, data });
	}

	kill(): void {
		this.exitListener?.(0);
	}

	emit(event: unknown): void {
		this.messageListener?.({ type: "event", event });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function setupRepository(): Promise<{ dataDirectory: string; agentDirectory: string; projectPath: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-orbit-session-message-"));
	temporaryRoots.push(root);
	const projectPath = join(root, "project");
	const dataDirectory = join(root, "data");
	const agentDirectory = join(root, "pi");
	await mkdir(projectPath);
	await execFileAsync("git", ["-C", projectPath, "init", "-b", "main"]);
	await execFileAsync("git", ["-C", projectPath, "config", "user.name", "Pi Orbit Test"]);
	await execFileAsync("git", ["-C", projectPath, "config", "user.email", "pi-orbit@example.invalid"]);
	await writeFile(join(projectPath, "file.txt"), "test\n");
	await execFileAsync("git", ["-C", projectPath, "add", "--", "file.txt"]);
	await execFileAsync("git", ["-C", projectPath, "commit", "-m", "initial"]);
	return { dataDirectory, agentDirectory, projectPath };
}

afterEach(async () => {
	for (const root of temporaryRoots.splice(0))
		await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});

describe("session messages", () => {
	it("keeps idle prompts on prompt and queues validated steering and follow-up while running", async () => {
		const paths = await setupRepository();
		const workers: MockWorker[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new MockWorker();
				workers.push(worker);
				return worker;
			},
		});
		try {
			const project = await service.invoke("project.open", { path: paths.projectPath });
			assert.equal(project.ok, true);
			if (!project.ok || !isRecord(project.data) || typeof project.data.id !== "string")
				throw new Error("Project did not return an ID");
			const session = await service.invoke("session.create", { projectId: project.data.id });
			assert.equal(session.ok, true);
			if (!session.ok || !isRecord(session.data) || typeof session.data.id !== "string")
				throw new Error("Session did not return an ID");
			const sessionId = session.data.id;

			assert.deepEqual(
				await service.invoke("session.message", { sessionId, text: "too early", deliverAs: "steer" }),
				{ ok: false, code: "SESSION_NOT_RUNNING", message: "Session must be running to receive a message" },
			);
			assert.deepEqual(await service.invoke("session.message", { sessionId, text: "invalid", deliverAs: "later" }), {
				ok: false,
				code: "INVALID_ARGUMENT",
				message: "Invalid command or request payload",
			});

			assert.deepEqual(await service.invoke("session.prompt", { sessionId, text: "start work" }), {
				ok: true,
				data: { accepted: true },
			});
			assert.deepEqual(workers.at(-1)?.requests.at(-1), { type: "prompt", payload: { text: "start work" } });
			for (const deliverAs of ["steer", "followUp"] as const) {
				assert.deepEqual(
					await service.invoke("session.message", { sessionId, text: `queued ${deliverAs}`, deliverAs }),
					{ ok: true, data: { accepted: true, delivery: deliverAs } },
				);
			}
			assert.deepEqual(workers.at(-1)?.requests.slice(-2), [
				{ type: "message", payload: { text: "queued steer", deliverAs: "steer" } },
				{ type: "message", payload: { text: "queued followUp", deliverAs: "followUp" } },
			]);

			workers.at(-1)?.emit({ type: "state", state: "idle", sessionId });
			for (let attempt = 0; attempt < 100 && (await service.snapshot()).sessions[0]?.status !== "idle"; attempt++)
				await new Promise((resolve) => setTimeout(resolve, 10));
			assert.deepEqual(
				await service.invoke("session.message", { sessionId, text: "too late", deliverAs: "followUp" }),
				{ ok: false, code: "SESSION_NOT_RUNNING", message: "Session must be running to receive a message" },
			);
		} finally {
			await service.close();
		}
	});

	it("forwards bounded image and text attachments through prompt and streaming message commands", async () => {
		const paths = await setupRepository();
		const workers: MockWorker[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: paths.dataDirectory,
			agentDirectory: paths.agentDirectory,
			createWorkerTransport: () => {
				const worker = new MockWorker();
				workers.push(worker);
				return worker;
			},
		});
		try {
			const project = await service.invoke("project.open", { path: paths.projectPath });
			if (!project.ok || !isRecord(project.data) || typeof project.data.id !== "string")
				throw new Error("Project did not return an ID");
			const session = await service.invoke("session.create", { projectId: project.data.id });
			if (!session.ok || !isRecord(session.data) || typeof session.data.id !== "string")
				throw new Error("Session did not return an ID");
			const attachments = [
				{ type: "image" as const, name: "diagram.png", mimeType: "image/png", data: "aGVsbG8=" },
				{ type: "text" as const, name: "notes.md", text: "keep this context" },
			];
			assert.deepEqual(
				await service.invoke("session.prompt", { sessionId: session.data.id, text: "Review", attachments }),
				{
					ok: true,
					data: { accepted: true },
				},
			);
			assert.deepEqual(workers.at(-1)?.requests.at(-1), {
				type: "prompt",
				payload: { text: "Review", attachments },
			});
			workers.at(-1)?.emit({
				type: "message",
				phase: "end",
				role: "user",
				text: "",
				parts: [{ kind: "image", mimeType: "image/png" }],
				timestamp: Date.now(),
				entryId: "image-message",
			});
			let snapshot = await service.snapshot();
			for (
				let attempt = 0;
				attempt < 100 && !snapshot.messages.some((message) => message.id === "image-message");
				attempt++
			) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				snapshot = await service.snapshot();
			}
			assert.deepEqual(snapshot.messages.find((message) => message.id === "image-message")?.parts, [
				{ kind: "image", mimeType: "image/png" },
			]);
			assert.deepEqual(
				await service.invoke("session.message", {
					sessionId: session.data.id,
					text: "queue context",
					deliverAs: "followUp",
					attachments,
				}),
				{ ok: true, data: { accepted: true, delivery: "followUp" } },
			);
			assert.deepEqual(workers.at(-1)?.requests.at(-1), {
				type: "message",
				payload: { text: "queue context", deliverAs: "followUp", attachments },
			});
			assert.deepEqual(
				await service.invoke("session.prompt", { sessionId: session.data.id, text: "", attachments: [] }),
				{
					ok: false,
					code: "INVALID_ARGUMENT",
					message: "Enter a message or attach a file.",
				},
			);
		} finally {
			await service.close();
		}
	});
});
