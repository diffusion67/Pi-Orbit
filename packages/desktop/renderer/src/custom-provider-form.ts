import type { DesktopCustomProvider } from "../../src/shared/desktop-types.ts";

export type CustomModelDraft = { id: string; name: string; reasoning: boolean; image: boolean; contextWindow: string; maxTokens: string };
export type CustomProviderDraft = { id: string; name: string; api: DesktopCustomProvider["api"]; baseUrl: string; models: CustomModelDraft[] };

export function emptyCustomModel(): CustomModelDraft { return { id: "", name: "", reasoning: false, image: false, contextWindow: "128000", maxTokens: "4096" }; }
export function emptyCustomProvider(): CustomProviderDraft { return { id: "", name: "", api: "anthropic-messages", baseUrl: "", models: [emptyCustomModel()] }; }
export function customProviderToDraft(provider: DesktopCustomProvider): CustomProviderDraft {
	return { id: provider.id, name: provider.name, api: provider.api, baseUrl: provider.baseUrl, models: provider.models.map((model) => ({ id: model.id, name: model.name, reasoning: model.reasoning, image: model.input.includes("image"), contextWindow: String(model.contextWindow), maxTokens: String(model.maxTokens) })) };
}

function slug(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function validBaseUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
	} catch { return false; }
}

export function buildCustomProvider(draft: CustomProviderDraft, editingId?: string): { provider: DesktopCustomProvider } | { error: string } {
	const id = (editingId ?? (draft.id.trim() || slug(draft.name))).trim();
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || id.length > 128) return { error: "Use a provider ID of up to 128 letters, numbers, dots, underscores, or hyphens." };
	const name = draft.name.trim();
	if (!name || name.length > 200) return { error: "Enter a provider name up to 200 characters long." };
	const baseUrl = draft.baseUrl.trim();
	if (!validBaseUrl(baseUrl) || baseUrl.length > 2048) return { error: "Enter a valid HTTP or HTTPS base URL up to 2048 characters long." };
	if (draft.models.length === 0 || draft.models.length > 100) return { error: "Add between 1 and 100 models." };
	const modelIds = new Set<string>();
	const models: DesktopCustomProvider["models"] = [];
	for (const model of draft.models) {
		const modelId = model.id.trim();
		const modelName = model.name.trim();
		const contextWindow = Number(model.contextWindow);
		const maxTokens = Number(model.maxTokens);
		if (!modelId || modelId.length > 256 || !modelName || modelName.length > 200) return { error: "Each model needs an ID up to 256 characters and a name up to 200 characters." };
		if (modelIds.has(modelId)) return { error: "Model IDs must be unique." };
		if (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || contextWindow > 100_000_000 || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 100_000_000 || maxTokens > contextWindow) return { error: "Model limits must be whole numbers up to 100,000,000, and max output tokens cannot exceed the context window." };
		modelIds.add(modelId);
		models.push({ id: modelId, name: modelName, reasoning: model.reasoning, input: model.image ? ["text", "image"] : ["text"], contextWindow, maxTokens });
	}
	return { provider: { id, name, api: draft.api, baseUrl, models } };
}
