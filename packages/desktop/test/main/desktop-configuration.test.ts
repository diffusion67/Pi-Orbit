import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppService } from "../../src/main/app-service.ts";
import type { WorkerTransport } from "../../src/main/worker-manager.ts";
import type { DesktopCustomProvider, DesktopEvent } from "../../src/shared/desktop-types.ts";

const roots: string[] = [];
class UnusedWorker implements WorkerTransport {
	onMessage(): void {}
	onExit(): void {}
	postMessage(): void {}
	kill(): void {}
}

async function openService(chooseProjectDirectory?: (path?: string) => Promise<string | undefined>) {
	const root = await mkdtemp(join(tmpdir(), "pi-orbit-config-"));
	roots.push(root);
	return {
		root,
		service: await DesktopAppService.open({
			dataDirectory: join(root, "data"),
			agentDirectory: join(root, "agent"),
			createWorkerTransport: () => new UnusedWorker(),
			chooseProjectDirectory,
		}),
	};
}

afterEach(async () => {
	// Windows may keep the project directory locked until the Git inspection exits.
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("desktop configuration commands", () => {
	it("browses without opening a project and keeps state on cancellation", async () => {
		const choose = vi.fn(async () => selected);
		let selected: string | undefined;
		const { root, service } = await openService(choose);
		try {
			const folder = join(root, "项目 folder");
			await mkdir(folder);
			selected = folder;
			expect(await service.invoke("project.browse", { path: root })).toEqual({ ok: true, data: { path: folder } });
			expect(choose).toHaveBeenCalledWith(root);
			expect((await service.snapshot()).projects).toEqual([]);
			expect(await service.invoke("project.open", { path: folder })).toMatchObject({ ok: true });
			const before = await service.snapshot();
			selected = undefined;
			expect(await service.invoke("project.browse", {})).toEqual({ ok: true, data: { path: null } });
			expect((await service.snapshot()).activeProjectId).toBe(before.activeProjectId);
			expect(await service.invoke("project.browse", { unexpected: "field" })).toMatchObject({
				ok: false,
				code: "INVALID_ARGUMENT",
			});
		} finally {
			await service.close();
		}
	});

	it("reports an unavailable picker without changing projects", async () => {
		const { service } = await openService();
		try {
			expect(await service.invoke("project.browse", {})).toMatchObject({ ok: false, code: "DIALOG_UNAVAILABLE" });
			expect((await service.snapshot()).projects).toEqual([]);
		} finally {
			await service.close();
		}
	});

	it("adds, edits, restores and removes custom providers before opening a project without leaking a key", async () => {
		const { root, service } = await openService();
		const provider: DesktopCustomProvider = {
			id: "my-gateway",
			name: "My gateway",
			api: "openai-responses",
			baseUrl: "http://localhost:1234/v1",
			models: [
				{
					id: "my-model",
					name: "My model",
					reasoning: false,
					input: ["text"],
					contextWindow: 32768,
					maxTokens: 4096,
				},
			],
		};
		try {
			expect(await service.invoke("provider.save", { ...provider, credential: "secret-!$KEY" })).toEqual({
				ok: true,
				data: { saved: true },
			});
			const snapshot = await service.snapshot();
			expect(snapshot.providers.find((item) => item.id === provider.id)).toMatchObject({
				configured: true,
				models: ["my-gateway/my-model"],
				custom: provider,
			});
			const events: DesktopEvent[] = [];
			const unsubscribe = await service.subscribe(0, (event) => events.push(event));
			unsubscribe();
			expect(JSON.stringify(events)).not.toContain("secret-!$KEY");
			expect(await service.invoke("provider.save", { ...provider, baseUrl: "https://example.invalid/v1" })).toEqual({
				ok: true,
				data: { saved: true },
			});
		} finally {
			await service.close();
		}
		const restored = await DesktopAppService.open({
			dataDirectory: join(root, "data"),
			agentDirectory: join(root, "agent"),
			createWorkerTransport: () => new UnusedWorker(),
		});
		try {
			expect((await restored.snapshot()).providers.find((item) => item.id === provider.id)).toMatchObject({
				configured: true,
				custom: { baseUrl: "https://example.invalid/v1" },
			});
			expect(
				await restored.invoke("settings.save", {
					...(await restored.snapshot()).settings,
					defaultModel: "my-gateway/my-model",
				}),
			).toMatchObject({ ok: true });
			expect(await restored.invoke("provider.remove", { providerId: provider.id })).toEqual({
				ok: true,
				data: { removed: true },
			});
			expect((await restored.snapshot()).settings.defaultModel).toBe("");
			expect((await restored.snapshot()).providers.some((item) => item.id === provider.id)).toBe(false);
			expect(await restored.invoke("provider.remove", { providerId: "anthropic" })).toMatchObject({ ok: false });
			expect(await restored.invoke("provider.save", { ...provider, api: "invalid-protocol" })).toMatchObject({
				ok: false,
				code: "INVALID_ARGUMENT",
			});
		} finally {
			await restored.close();
		}
	});
});
