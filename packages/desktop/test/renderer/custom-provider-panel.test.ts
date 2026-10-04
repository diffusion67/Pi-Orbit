import { describe, expect, it } from "vitest";
import { buildCustomProvider } from "../../renderer/src/custom-provider-form.ts";

type Draft = Parameters<typeof buildCustomProvider>[0];

function draft(overrides: Partial<Draft> = {}): Draft {
	return {
		id: "custom-api",
		name: "Custom API",
		api: "openai-responses",
		baseUrl: "https://api.example.com/v1",
		models: [
			{ id: "model-a", name: "Model A", reasoning: true, image: true, contextWindow: "32768", maxTokens: "4096" },
		],
		...overrides,
	};
}

describe("custom provider form validation", () => {
	it("builds a provider with a generated ID and the selected model capabilities", () => {
		const result = buildCustomProvider(draft({ id: "", name: "Example API" }));
		expect(result).toEqual({
			provider: {
				id: "example-api",
				name: "Example API",
				api: "openai-responses",
				baseUrl: "https://api.example.com/v1",
				models: [
					{
						id: "model-a",
						name: "Model A",
						reasoning: true,
						input: ["text", "image"],
						contextWindow: 32768,
						maxTokens: 4096,
					},
				],
			},
		});
	});

	it.each([
		"https://user:secret@example.com/v1",
		"https://example.com/v1?token=secret",
		"https://example.com/v1#fragment",
		"file:///tmp/api",
	])("rejects unsafe or unsupported base URL %s", (baseUrl) => {
		expect(buildCustomProvider(draft({ baseUrl }))).toEqual({
			error: "Enter a valid HTTP or HTTPS base URL up to 2048 characters long.",
		});
	});

	it("rejects duplicate model IDs and output limits larger than context", () => {
		const duplicate = draft({
			models: [
				{ id: "same", name: "First", reasoning: false, image: false, contextWindow: "100", maxTokens: "50" },
				{ id: "same", name: "Second", reasoning: false, image: false, contextWindow: "100", maxTokens: "50" },
			],
		});
		expect(buildCustomProvider(duplicate)).toEqual({ error: "Model IDs must be unique." });
		expect(
			buildCustomProvider(
				draft({
					models: [{ id: "a", name: "A", reasoning: false, image: false, contextWindow: "100", maxTokens: "101" }],
				}),
			),
		).toEqual({
			error: "Model limits must be whole numbers up to 100,000,000, and max output tokens cannot exceed the context window.",
		});
	});

	it("rejects values outside command schema bounds", () => {
		expect(buildCustomProvider(draft({ id: "x".repeat(129) }))).toEqual({
			error: "Use a provider ID of up to 128 letters, numbers, dots, underscores, or hyphens.",
		});
		expect(
			buildCustomProvider(
				draft({
					models: Array.from({ length: 101 }, (_, index) => ({
						id: String(index),
						name: "Model",
						reasoning: false,
						image: false,
						contextWindow: "10",
						maxTokens: "1",
					})),
				}),
			),
		).toEqual({ error: "Add between 1 and 100 models." });
	});

	it("keeps a provider ID fixed while editing", () => {
		expect(buildCustomProvider(draft({ id: "changed" }), "stable-id")).toMatchObject({
			provider: { id: "stable-id" },
		});
	});
});
