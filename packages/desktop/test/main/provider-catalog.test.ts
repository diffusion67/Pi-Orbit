import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, OAuthAuth } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createAuthFileCredentialStore } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ProviderCatalog } from "../../src/main/provider-catalog.ts";

function fakeOAuthModels(credentials: CredentialStore) {
	const models = builtinModels({ credentials });
	const provider = models.getProvider("anthropic");
	if (!provider) throw new Error("Anthropic provider is missing");
	const oauth: OAuthAuth = {
		name: "Test OAuth",
		login: async (interaction) => {
			interaction.notify({
				type: "device_code",
				userCode: "test-user-code",
				verificationUri: "https://example.invalid/verify",
			});
			const code = await interaction.prompt({ type: "manual_code", message: "Enter the test code" });
			return {
				type: "oauth",
				access: `access-${code}`,
				refresh: "test-refresh-token",
				expires: Date.now() + 60_000,
			};
		},
		refresh: async (credential) => credential,
		toAuth: async (credential) => ({ apiKey: credential.access }),
	};
	models.setProvider({ ...provider, auth: { ...provider.auth, oauth } });
	return models;
}

describe("ProviderCatalog", () => {
	it("lists built-in models and configures credentials before any session exists", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-providers-"));
		try {
			const catalog = new ProviderCatalog(directory);
			const initial = await catalog.list();
			const anthropic = initial.find((provider) => provider.id === "anthropic");
			expect(anthropic).toBeDefined();
			expect(anthropic?.models.some((model) => model.startsWith("anthropic/"))).toBe(true);
			await catalog.configure("anthropic", "test-local-credential");
			expect((await catalog.list()).find((provider) => provider.id === "anthropic")?.configured).toBe(true);
			await catalog.configure("anthropic", "!literal$KEY");
			expect(await createAuthFileCredentialStore(join(directory, "auth.json")).read("anthropic")).toEqual({
				type: "api_key",
				key: "!literal$KEY",
			});
			await catalog.clear("anthropic");
			expect((await catalog.list()).find((provider) => provider.id === "anthropic")?.configured).toBe(false);
			await expect(catalog.configure("unknown-provider", "key")).rejects.toThrow("Unknown provider");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("runs fake OAuth interaction and stores its credential through Pi's model auth API", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-oauth-"));
		try {
			const catalog = new ProviderCatalog(directory, fakeOAuthModels);
			const events: unknown[] = [];
			await catalog.login("anthropic", {
				prompt: async () => "test-authorization-code",
				notify: (event) => events.push(event),
			});
			expect(events).toEqual([
				{ type: "device_code", userCode: "test-user-code", verificationUri: "https://example.invalid/verify" },
			]);
			expect(await createAuthFileCredentialStore(join(directory, "auth.json")).read("anthropic")).toMatchObject({
				type: "oauth",
				access: "access-test-authorization-code",
				refresh: "test-refresh-token",
			});
			expect((await catalog.list()).find((provider) => provider.id === "anthropic")?.credentialType).toBe("oauth");
			await catalog.clear("anthropic");
			expect((await catalog.list()).find((provider) => provider.id === "anthropic")?.configured).toBe(false);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
