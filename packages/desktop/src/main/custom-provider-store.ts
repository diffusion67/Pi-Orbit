import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DesktopCustomProvider } from "../shared/desktop-types.ts";

const API_IDS = new Set(["anthropic-messages", "openai-completions", "openai-responses", "openai-codex-responses"]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the JSONC subset accepted by Pi's models.json loader. */
function parseJsonc(source: string): unknown {
	const json = source
		.replace(/^\uFEFF/, "")
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? match);
	return JSON.parse(json) as unknown;
}

function isNotFound(error: unknown): boolean {
	return isObject(error) && error.code === "ENOENT";
}

async function readJsonFile(path: string): Promise<unknown> {
	try {
		return parseJsonc(await readFile(path, "utf8"));
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, path);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

function validateCustomProvider(input: DesktopCustomProvider): void {
	if (
		!input.id ||
		input.id.trim() !== input.id ||
		input.id.includes("/") ||
		input.id === "__proto__" ||
		input.id === "constructor" ||
		input.id === "prototype"
	) {
		throw new TypeError("Provider ID must be non-empty and cannot contain '/' or reserved object keys");
	}
	if (!input.name.trim()) throw new TypeError("Provider name is required");
	if (!API_IDS.has(input.api)) throw new TypeError(`Unsupported provider API: ${input.api}`);
	let endpoint: URL;
	try {
		endpoint = new URL(input.baseUrl);
	} catch {
		throw new TypeError("Endpoint must be a valid HTTP or HTTPS URL");
	}
	if (
		(endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash
	) {
		throw new TypeError("Endpoint must use HTTP or HTTPS and cannot contain credentials, query, or fragment");
	}
	if (input.models.length === 0) throw new TypeError("At least one model is required");
	const modelIds = new Set<string>();
	for (const model of input.models) {
		if (!model.id || model.id.trim() !== model.id) throw new TypeError("Model IDs must be non-empty and trimmed");
		if (modelIds.has(model.id)) throw new TypeError(`Duplicate model ID: ${model.id}`);
		modelIds.add(model.id);
		if (!model.name.trim()) throw new TypeError(`Model ${model.id} requires a name`);
		if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
			throw new TypeError(`Model ${model.id} context window must be positive`);
		}
		if (!Number.isFinite(model.maxTokens) || model.maxTokens <= 0 || model.maxTokens > model.contextWindow) {
			throw new TypeError(`Model ${model.id} max tokens must be positive and no greater than its context window`);
		}
		if (model.input.length === 0 || model.input.some((inputType) => inputType !== "text" && inputType !== "image")) {
			throw new TypeError(`Model ${model.id} must support text or image input`);
		}
	}
}

export class CustomProviderStore {
	private readonly modelsPath: string;
	private readonly ownershipPath: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(agentDirectory: string) {
		this.modelsPath = join(agentDirectory, "models.json");
		this.ownershipPath = join(agentDirectory, "desktop-custom-providers.json");
	}

	private async readModels(): Promise<JsonObject> {
		const value = await readJsonFile(this.modelsPath);
		if (value === undefined) return { providers: {} };
		if (!isObject(value) || !isObject(value.providers))
			throw new Error("Invalid models.json: expected an object with providers");
		return value;
	}

	private async readOwnedIds(): Promise<Set<string>> {
		const value = await readJsonFile(this.ownershipPath);
		if (value === undefined) return new Set();
		if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) {
			throw new Error("Invalid desktop-custom-providers.json");
		}
		return new Set(value);
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation, operation);
		this.queue = result.catch(() => undefined);
		return result;
	}

	list(): Promise<DesktopCustomProvider[]> {
		return this.enqueue(async () => {
			const [document, ownedIds] = await Promise.all([this.readModels(), this.readOwnedIds()]);
			const providers = document.providers as JsonObject;
			const result: DesktopCustomProvider[] = [];
			for (const id of ownedIds) {
				const config = providers[id];
				if (!isObject(config) || !Array.isArray(config.models)) continue;
				if (
					typeof config.name !== "string" ||
					typeof config.baseUrl !== "string" ||
					typeof config.api !== "string" ||
					!API_IDS.has(config.api)
				)
					continue;
				const models = config.models.flatMap((value) => {
					if (!isObject(value) || typeof value.id !== "string") return [];
					return [
						{
							id: value.id,
							name: typeof value.name === "string" ? value.name : value.id,
							reasoning: value.reasoning === true,
							input: Array.isArray(value.input)
								? value.input.filter(
										(entry): entry is "text" | "image" => entry === "text" || entry === "image",
									)
								: ["text" as const],
							contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : 128000,
							maxTokens: typeof value.maxTokens === "number" ? value.maxTokens : 16384,
						},
					];
				});
				result.push({
					id,
					name: config.name,
					api: config.api as DesktopCustomProvider["api"],
					baseUrl: config.baseUrl,
					models,
				});
			}
			return result;
		});
	}

	save(input: DesktopCustomProvider, beforeWrite?: () => Promise<void>): Promise<void> {
		return this.enqueue(async () => {
			validateCustomProvider(input);
			await mkdir(dirname(this.modelsPath), { recursive: true });
			const [document, ownedIds] = await Promise.all([this.readModels(), this.readOwnedIds()]);
			const providers = document.providers as JsonObject;
			if (Object.hasOwn(providers, input.id) && !ownedIds.has(input.id)) {
				throw new Error(`Provider ID is already used by another models.json entry: ${input.id}`);
			}
			// Validate metadata before changing credentials; commit metadata only once
			// credential storage has succeeded.
			await beforeWrite?.();
			providers[input.id] = {
				name: input.name,
				api: input.api,
				baseUrl: input.baseUrl,
				models: input.models.map((model) => ({
					id: model.id,
					name: model.name,
					reasoning: model.reasoning,
					input: model.input,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				})),
			};
			ownedIds.add(input.id);
			await writeJsonFile(this.ownershipPath, [...ownedIds].sort());
			await writeJsonFile(this.modelsPath, document);
		});
	}

	remove(providerId: string): Promise<void> {
		return this.enqueue(async () => {
			const [document, ownedIds] = await Promise.all([this.readModels(), this.readOwnedIds()]);
			if (!ownedIds.has(providerId)) throw new Error(`Unknown custom provider ${providerId}`);
			const providers = document.providers as JsonObject;
			delete providers[providerId];
			ownedIds.delete(providerId);
			await writeJsonFile(this.modelsPath, document);
			await writeJsonFile(this.ownershipPath, [...ownedIds].sort());
		});
	}
}
