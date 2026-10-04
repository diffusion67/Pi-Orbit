import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CustomProviderStore } from "../../src/main/custom-provider-store.ts";
import type { DesktopCustomProvider } from "../../src/shared/desktop-types.ts";

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

describe("CustomProviderStore", () => {
	it("stores custom provider entries in Pi's models.json and preserves other fields", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-custom-store-"));
		try {
			const modelsPath = join(directory, "models.json");
			await writeFile(
				modelsPath,
				`{\n // preserve an external provider\n "providers": {"external": {"baseUrl": "http://external.invalid/v1"}}, "defaults": {"keep": true},\n}`,
			);
			const store = new CustomProviderStore(directory);
			const provider = customProvider();
			await store.save(provider);
			expect(await store.list()).toEqual([provider]);
			const config = JSON.parse(await readFile(modelsPath, "utf8")) as {
				providers: Record<string, Record<string, unknown>>;
				defaults: { keep: boolean };
			};
			expect(config.providers.external).toEqual({ baseUrl: "http://external.invalid/v1" });
			expect(config.providers[provider.id]).toMatchObject({ api: provider.api, baseUrl: provider.baseUrl });
			expect(config.defaults).toEqual({ keep: true });

			const updated = customProvider({ ...provider, name: "Updated Gateway" });
			await store.save(updated);
			expect(await store.list()).toEqual([updated]);
			await store.remove(provider.id);
			expect(await store.list()).toEqual([]);
			expect(JSON.parse(await readFile(modelsPath, "utf8"))).toMatchObject({
				providers: { external: { baseUrl: "http://external.invalid/v1" } },
				defaults: { keep: true },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("refuses provider ID collisions and unsafe endpoint or token limits", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-custom-store-validation-"));
		try {
			const modelsPath = join(directory, "models.json");
			await writeFile(
				modelsPath,
				JSON.stringify({ providers: { external: { baseUrl: "http://external.invalid/v1" } } }),
			);
			const store = new CustomProviderStore(directory);
			await expect(store.save(customProvider({ id: "external" }))).rejects.toThrow("already used");
			await expect(store.save(customProvider({ id: "__proto__" }))).rejects.toThrow("reserved object keys");
			await expect(
				store.save(customProvider({ baseUrl: "https://user:secret@example.com/v1?token=secret" })),
			).rejects.toThrow("cannot contain credentials, query, or fragment");
			await expect(
				store.save(customProvider({ models: [{ ...customProvider().models[0]!, maxTokens: 32769 }] })),
			).rejects.toThrow("no greater than its context window");
			await expect(
				store.save(
					customProvider({
						models: [{ ...customProvider().models[0]!, contextWindow: Number.POSITIVE_INFINITY }],
					}),
				),
			).rejects.toThrow("context window must be positive");
			await expect(
				store.save(customProvider({ models: [{ ...customProvider().models[0]!, maxTokens: 0 }] })),
			).rejects.toThrow("max tokens must be positive");
			expect(JSON.parse(await readFile(modelsPath, "utf8"))).toEqual({
				providers: { external: { baseUrl: "http://external.invalid/v1" } },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
