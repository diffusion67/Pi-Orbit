import { join } from "node:path";
import type { AuthInteraction, Credential, CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createAuthFileCredentialStore } from "@earendil-works/pi-coding-agent";
import type { DesktopCustomProvider, DesktopProvider } from "../shared/desktop-types.ts";
import { CustomProviderStore } from "./custom-provider-store.ts";

/** Main process owns credential writes; the renderer receives only model names and status. */
export class ProviderCatalog {
	private readonly auth: CredentialStore;
	private readonly models: MutableModels;
	private readonly customProviders: CustomProviderStore;
	private customProviderIds = new Set<string>();

	constructor(
		agentDirectory: string,
		createModels: (credentials: CredentialStore) => MutableModels = (credentials) => builtinModels({ credentials }),
	) {
		this.auth = createAuthFileCredentialStore(join(agentDirectory, "auth.json"));
		this.models = createModels(this.auth);
		this.customProviders = new CustomProviderStore(agentDirectory);
	}

	async list(): Promise<DesktopProvider[]> {
		const [credentials, customProviders] = await Promise.all([this.auth.list(), this.customProviders.list()]);
		this.customProviderIds = new Set(customProviders.map((provider) => provider.id));
		const configured = new Map(credentials.map((entry) => [entry.providerId, entry.type]));
		const providers: DesktopProvider[] = this.models.getProviders().map((provider) => ({
			id: provider.id,
			name: provider.name ?? provider.id,
			configured: configured.has(provider.id),
			...(configured.has(provider.id) ? { credentialType: configured.get(provider.id)! } : {}),
			apiKeyLogin: provider.auth.apiKey?.login !== undefined,
			oauthLogin: provider.auth.oauth?.login !== undefined,
			models: this.models.getModels(provider.id).map((model) => `${model.provider}/${model.id}`),
		}));
		for (const provider of customProviders) {
			providers.push({
				id: provider.id,
				name: provider.name,
				configured: configured.has(provider.id),
				...(configured.has(provider.id) ? { credentialType: configured.get(provider.id)! } : {}),
				apiKeyLogin: true,
				oauthLogin: false,
				models: provider.models.map((model) => `${provider.id}/${model.id}`),
				custom: provider,
			});
		}
		return providers.sort((a, b) => a.name.localeCompare(b.name));
	}

	async configure(providerId: string, credential: string): Promise<void> {
		if (!(await this.isCustomProvider(providerId))) this.requireProvider(providerId);
		await this.storeCredential(providerId, credential);
	}

	private async storeCredential(providerId: string, credential: string): Promise<Credential | undefined> {
		// Pi auth.json also accepts shell and environment references. UI input is a
		// literal credential, so escape that syntax before storing it.
		const key = credential.replaceAll("$", () => "$$").replace(/^!/, "$!");
		let previous: Credential | undefined;
		await this.auth.modify(providerId, async (current) => {
			previous = current;
			return { type: "api_key", key };
		});
		return previous;
	}

	async clear(providerId: string): Promise<void> {
		if (await this.isCustomProvider(providerId)) {
			await this.auth.delete(providerId);
			return;
		}
		this.requireProvider(providerId);
		await this.models.logout(providerId);
	}

	async saveCustom(input: DesktopCustomProvider, credential?: string): Promise<void> {
		if (this.models.getProvider(input.id)) throw new Error(`Cannot replace built-in provider ${input.id}`);
		let previousCredential: Credential | undefined;
		let credentialChanged = false;
		try {
			await this.customProviders.save(
				input,
				credential
					? async () => {
							previousCredential = await this.storeCredential(input.id, credential);
							credentialChanged = true;
						}
					: undefined,
			);
		} catch (error) {
			if (credentialChanged) {
				try {
					if (previousCredential) await this.auth.modify(input.id, async () => previousCredential);
					else await this.auth.delete(input.id);
				} catch {
					throw new Error("Provider configuration could not be saved and its credential could not be restored");
				}
			}
			throw error;
		}
	}

	async removeCustom(providerId: string): Promise<void> {
		await this.customProviders.remove(providerId);
		await this.auth.delete(providerId);
	}

	async login(providerId: string, interaction: AuthInteraction): Promise<void> {
		if (await this.isCustomProvider(providerId)) throw new Error("Custom providers do not support OAuth login");
		const provider = this.requireProvider(providerId);
		if (!provider.auth.oauth?.login) throw new Error(`${provider.name} does not support OAuth login`);
		await this.models.login(providerId, "oauth", interaction);
	}

	supportsOAuthLogin(providerId: string): boolean {
		if (this.customProviderIds.has(providerId)) return false;
		const provider = this.requireProvider(providerId);
		return provider.auth.oauth?.login !== undefined;
	}

	private async isCustomProvider(providerId: string): Promise<boolean> {
		return (await this.customProviders.list()).some((provider) => provider.id === providerId);
	}

	private requireProvider(providerId: string) {
		const provider = this.models.getProvider(providerId);
		if (!provider) throw new Error(`Unknown provider ${providerId}`);
		return provider;
	}
}
