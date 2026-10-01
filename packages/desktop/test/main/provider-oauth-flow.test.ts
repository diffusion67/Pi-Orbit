import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, MutableModels, OAuthAuth } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppService } from "../../src/main/app-service.ts";
import type { WorkerTransport } from "../../src/main/worker-manager.ts";
import type { DesktopAuthEvent, DesktopEvent } from "../../src/shared/desktop-types.ts";

const temporaryRoots: string[] = [];

class UnusedWorker implements WorkerTransport {
	onMessage(): void {}
	onExit(): void {}
	postMessage(): void {}
	kill(): void {}
}

function fakeOAuthModels(credentials: CredentialStore): MutableModels {
	const models = builtinModels({ credentials });
	const provider = models.getProvider("anthropic");
	if (!provider) throw new Error("Anthropic provider is missing");
	const oauth: OAuthAuth = {
		name: "Fake OAuth",
		login: async (interaction) => {
			interaction.notify({
				type: "device_code",
				userCode: "fake-user-code",
				verificationUri: "https://example.invalid/verify",
			});
			await interaction.prompt({ type: "manual_code", message: "Paste the authorization code" });
			return {
				type: "oauth",
				access: "oauth-access-secret",
				refresh: "oauth-refresh-secret",
				expires: Date.now() + 60_000,
			};
		},
		refresh: async (credential) => credential,
		toAuth: async (credential) => ({ apiKey: credential.access }),
	};
	models.setProvider({ ...provider, auth: { ...provider.auth, oauth } });
	return models;
}

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("desktop provider OAuth flow", () => {
	it("keeps OAuth prompts and submitted codes out of durable events", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-orbit-oauth-flow-"));
		temporaryRoots.push(root);
		const authEvents: DesktopAuthEvent[] = [];
		const service = await DesktopAppService.open({
			dataDirectory: join(root, "data"),
			agentDirectory: join(root, "pi"),
			createWorkerTransport: () => new UnusedWorker(),
			createProviderModels: fakeOAuthModels,
			onAuthEvent: (event) => authEvents.push(event),
		});
		try {
			const started = await service.invoke("auth.login", { providerId: "anthropic" });
			expect(started).toMatchObject({ ok: true });
			if (!started.ok) return;
			const flowId = (started.data as { flowId: string }).flowId;
			await vi.waitFor(() =>
				expect(authEvents.some((event) => event.flowId === flowId && event.type === "prompt")).toBe(true),
			);
			const prompt = authEvents.find(
				(event): event is Extract<DesktopAuthEvent, { type: "prompt" }> =>
					event.flowId === flowId && event.type === "prompt",
			);
			expect(prompt?.prompt.type).toBe("manual_code");
			expect(authEvents.some((event) => event.flowId === flowId && event.type === "device_code")).toBe(true);
			expect(
				await service.invoke("auth.respond", {
					flowId,
					promptId: prompt!.promptId,
					value: "manual-code-secret",
				}),
			).toEqual({ ok: true, data: { accepted: true } });
			await vi.waitFor(() =>
				expect(authEvents.some((event) => event.flowId === flowId && event.type === "complete")).toBe(true),
			);

			const persistedEvents: DesktopEvent[] = [];
			const unsubscribe = await service.subscribe(0, (event) => persistedEvents.push(event));
			unsubscribe();
			const durableJson = JSON.stringify(persistedEvents);
			expect(durableJson).not.toContain("manual-code-secret");
			expect(durableJson).not.toContain("oauth-access-secret");
			expect(
				(await service.snapshot()).providers.find((provider) => provider.id === "anthropic")?.credentialType,
			).toBe("oauth");
		} finally {
			await service.close();
		}
	});
});
