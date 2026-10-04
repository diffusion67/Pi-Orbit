import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, OAuthAuth } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createAuthFileCredentialStore, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CustomProviderStore } from "../../src/main/custom-provider-store.ts";
import { ProviderCatalog } from "../../src/main/provider-catalog.ts";
import type { DesktopCustomProvider } from "../../src/shared/desktop-types.ts";

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

function customProvider(overrides: Partial<DesktopCustomProvider> = {}): DesktopCustomProvider {
	return {
		id: "local-gateway",
		name: "Local Gateway",
		api: "openai-completions",
		baseUrl: "http://localhost:8080/v1",
		models: [
			{
				id: "qwen-3",
				name: "Qwen 3",
				reasoning: true,
				input: ["text"],
				contextWindow: 32768,
				maxTokens: 8192,
			},
		],
		...overrides,
	};
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

	it("persists custom providers in models.json and credentials in auth.json", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-custom-provider-"));
		try {
			const modelsPath = join(directory, "models.json");
			await writeFile(
				modelsPath,
				JSON.stringify({
					providers: { external: { baseUrl: "http://external.invalid/v1" } },
					defaults: { keep: true },
				}),
			);
			const catalog = new ProviderCatalog(directory);
			const input = customProvider();
			const auth = createAuthFileCredentialStore(join(directory, "auth.json"));
			await auth.modify("external", async () => ({ type: "api_key", key: "external-key" }));
			await catalog.saveCustom(input, "!literal$TOKEN");

			const listed = (await catalog.list()).find((provider) => provider.id === input.id);
			expect(listed).toMatchObject({
				id: input.id,
				name: input.name,
				configured: true,
				credentialType: "api_key",
				apiKeyLogin: true,
				oauthLogin: false,
				models: ["local-gateway/qwen-3"],
				custom: input,
			});
			expect(JSON.stringify(listed)).not.toContain("literal$TOKEN");
			const config = JSON.parse(await readFile(modelsPath, "utf8")) as {
				providers: Record<string, Record<string, unknown>>;
				defaults: { keep: boolean };
			};
			expect(config.providers.external).toEqual({ baseUrl: "http://external.invalid/v1" });
			expect(config.defaults).toEqual({ keep: true });
			expect(config.providers[input.id]).toMatchObject({ api: input.api, baseUrl: input.baseUrl });
			expect(config.providers[input.id]?.apiKey).toBeUndefined();
			expect(await auth.read(input.id)).toEqual({
				type: "api_key",
				key: "!literal$TOKEN",
			});

			await catalog.saveCustom(customProvider({ ...input, name: "Updated Gateway" }));
			expect((await catalog.list()).find((provider) => provider.id === input.id)?.name).toBe("Updated Gateway");
			expect(await auth.read(input.id)).toEqual({
				type: "api_key",
				key: "!literal$TOKEN",
			});
			await catalog.removeCustom(input.id);
			expect((await catalog.list()).some((provider) => provider.id === input.id)).toBe(false);
			expect(await auth.read(input.id)).toBeUndefined();
			expect(await auth.read("external")).toEqual({ type: "api_key", key: "external-key" });
			expect(JSON.parse(await readFile(modelsPath, "utf8"))).toMatchObject({
				providers: { external: { baseUrl: "http://external.invalid/v1" } },
				defaults: { keep: true },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each(["anthropic-messages", "openai-completions", "openai-responses", "openai-codex-responses"] as const)(
		"loads %s custom providers through Pi ModelRuntime",
		async (api) => {
			const directory = await mkdtemp(join(tmpdir(), "pi-orbit-custom-runtime-"));
			try {
				const catalog = new ProviderCatalog(directory);
				const provider = customProvider({ id: `runtime-${api}`, api, baseUrl: "https://gateway.example.test/v1" });
				await catalog.saveCustom(provider, `credential-${api}`);
				const runtime = await ModelRuntime.create({
					authPath: join(directory, "auth.json"),
					modelsPath: join(directory, "models.json"),
					allowModelNetwork: false,
					refreshOnCreate: false,
				});

				const model = runtime.getModels(provider.id).find((entry) => entry.id === provider.models[0]?.id);
				expect(model).toMatchObject({
					id: provider.models[0]?.id,
					provider: provider.id,
					api,
					baseUrl: provider.baseUrl,
				});
				expect(runtime.getProvider(provider.id)?.name).toBe(provider.name);
				if (!model) throw new Error(`ModelRuntime did not load ${provider.id}`);
				expect(await runtime.getAuth(model)).toMatchObject({ auth: { apiKey: `credential-${api}` } });
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("keeps custom models selectable without a credential", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-custom-keyless-"));
		try {
			const catalog = new ProviderCatalog(directory);
			const provider = customProvider({ id: "keyless-local" });
			await catalog.saveCustom(provider);
			const runtime = await ModelRuntime.create({
				authPath: join(directory, "auth.json"),
				modelsPath: join(directory, "models.json"),
				allowModelNetwork: false,
				refreshOnCreate: false,
			});

			const model = runtime.getModels(provider.id).find((entry) => entry.id === provider.models[0]?.id);
			expect(model).toMatchObject({ provider: provider.id, baseUrl: provider.baseUrl });
			if (!model) throw new Error(`ModelRuntime did not load ${provider.id}`);
			expect(await runtime.getAuth(model)).toBeUndefined();
			expect((await catalog.list()).find((entry) => entry.id === provider.id)).toMatchObject({
				configured: false,
				custom: provider,
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("protects built-in and externally configured provider IDs", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-custom-provider-collision-"));
		try {
			const modelsPath = join(directory, "models.json");
			await writeFile(
				modelsPath,
				JSON.stringify({ providers: { external: { baseUrl: "http://external.invalid/v1" } } }),
			);
			const catalog = new ProviderCatalog(directory);
			await expect(catalog.saveCustom(customProvider({ id: "anthropic" }))).rejects.toThrow("built-in provider");
			await expect(catalog.saveCustom(customProvider({ id: "external" }))).rejects.toThrow("already used");
			expect(JSON.parse(await readFile(modelsPath, "utf8"))).toEqual({
				providers: { external: { baseUrl: "http://external.invalid/v1" } },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("does not publish provider metadata when credential storage fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-custom-auth-failure-"));
		try {
			await writeFile(join(directory, "auth.json"), "{broken-json");
			const catalog = new ProviderCatalog(directory);
			await expect(catalog.saveCustom(customProvider(), "new-key")).rejects.toThrow();
			expect(await new CustomProviderStore(directory).list()).toEqual([]);
			await expect(readFile(join(directory, "models.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(join(directory, "desktop-custom-providers.json"), "utf8")).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([false, true])(
		"restores the previous credential when metadata cannot be saved (existing: %s)",
		async (existing) => {
			const directory = await mkdtemp(join(tmpdir(), "pi-orbit-custom-metadata-failure-"));
			let saveFailure: ReturnType<typeof vi.spyOn> | undefined;
			try {
				const catalog = new ProviderCatalog(directory);
				const input = customProvider();
				if (existing) await catalog.saveCustom(input, "!literal$OLD");
				saveFailure = vi
					.spyOn(CustomProviderStore.prototype, "save")
					.mockImplementation(async (_input, beforeWrite) => {
						await beforeWrite?.();
						throw new Error("metadata write failed");
					});
				await expect(catalog.saveCustom({ ...input, name: "Updated" }, "new-key")).rejects.toThrow(
					"metadata write failed",
				);
				const credential = await createAuthFileCredentialStore(join(directory, "auth.json")).read(input.id);
				expect(credential).toEqual(existing ? { type: "api_key", key: "!literal$OLD" } : undefined);
				expect(await new CustomProviderStore(directory).list()).toEqual(existing ? [input] : []);
			} finally {
				saveFailure?.mockRestore();
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
});
