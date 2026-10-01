import { join } from "node:path";
import type { AuthInteraction, CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createAuthFileCredentialStore } from "@earendil-works/pi-coding-agent";
import type { DesktopProvider } from "../shared/desktop-types.ts";

/** Main process owns credential writes; the renderer receives only model names and status. */
export class ProviderCatalog {
	private readonly auth: CredentialStore;
	private readonly models: MutableModels;

	constructor(
		agentDirectory: string,
		createModels: (credentials: CredentialStore) => MutableModels = (credentials) => builtinModels({ credentials }),
	) {
		this.auth = createAuthFileCredentialStore(join(agentDirectory, "auth.json"));
		this.models = createModels(this.auth);
	}

	async list(): Promise<DesktopProvider[]> {
		const configured = new Map((await this.auth.list()).map((entry) => [entry.providerId, entry.type]));
		return this.models
			.getProviders()
			.map((provider) => ({
				id: provider.id,
				name: provider.name ?? provider.id,
				configured: configured.has(provider.id),
				...(configured.has(provider.id) ? { credentialType: configured.get(provider.id)! } : {}),
				apiKeyLogin: provider.auth.apiKey?.login !== undefined,
				oauthLogin: provider.auth.oauth?.login !== undefined,
				models: this.models.getModels(provider.id).map((model) => `${model.provider}/${model.id}`),
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	async configure(providerId: string, credential: string): Promise<void> {
		this.requireProvider(providerId);
		// Pi auth.json also accepts shell and environment references. UI input is a
		// literal credential, so escape that syntax before storing it.
		const key = credential.replaceAll("$", () => "$$").replace(/^!/, "$!");
		await this.auth.modify(providerId, async () => ({ type: "api_key", key }));
	}

	async clear(providerId: string): Promise<void> {
		this.requireProvider(providerId);
		await this.models.logout(providerId);
	}

	async login(providerId: string, interaction: AuthInteraction): Promise<void> {
		const provider = this.requireProvider(providerId);
		if (!provider.auth.oauth?.login) throw new Error(`${provider.name} does not support OAuth login`);
		await this.models.login(providerId, "oauth", interaction);
	}

	supportsOAuthLogin(providerId: string): boolean {
		const provider = this.requireProvider(providerId);
		return provider.auth.oauth?.login !== undefined;
	}

	private requireProvider(providerId: string) {
		const provider = this.models.getProvider(providerId);
		if (!provider) throw new Error(`Unknown provider ${providerId}`);
		return provider;
	}
}
