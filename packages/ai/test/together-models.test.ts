import { afterEach, describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/openai-completions.ts";
import { getModel, getSupportedThinkingLevels, normalizeContext } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalTogetherApiKey = process.env.TOGETHER_API_KEY;

afterEach(() => {
	if (originalTogetherApiKey === undefined) {
		delete process.env.TOGETHER_API_KEY;
	} else {
		process.env.TOGETHER_API_KEY = originalTogetherApiKey;
	}
});

describe("Together models", () => {
	it("registers the default Kimi K3 model via OpenAI-compatible Chat Completions API", () => {
		const model = getModel("together", "moonshotai/Kimi-K3");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("together");
		expect(model.baseUrl).toBe("https://api.together.ai/v1");
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null });
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1048576);
		expect(model.maxTokens).toBe(131072);
		expect(model.cost).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 0,
		});
		expect(model.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "together",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
		});
	});

	it("models Together reasoning controls from the Together API surface", () => {
		const gptOss = getModel("together", "openai/gpt-oss-120b");
		expect(gptOss.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			max: null,
			xhigh: null,
		});
		expect(gptOss.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		});

		const minimax = getModel("together", "MiniMaxAI/MiniMax-M2.7");
		expect(minimax.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null });
		expect(minimax.compat?.thinkingFormat).toBeUndefined();
		expect(minimax.compat?.supportsReasoningEffort).toBe(false);
	});

	it("supports documented reasoning controls for the current DeepSeek V4 Pro revision", () => {
		const deepSeekV4 = getModel("together", "deepseek-ai/DeepSeek-V4-Pro-0813");
		expect(deepSeekV4).toBeDefined();
		expect(deepSeekV4.thinkingLevelMap).toEqual({
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
		});
		expect(deepSeekV4.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "together",
		});
		expect(getSupportedThinkingLevels(deepSeekV4)).toEqual(["off", "high"]);
	});

	it.each(["off", "high"] as const)("sends the DeepSeek V4 Pro %s reasoning control", async (reasoning) => {
		const model = getModel("together", "deepseek-ai/DeepSeek-V4-Pro-0813");
		const context = normalizeContext({
			messages: [{ role: "user", content: "Hello", timestamp: 0 }],
		});
		let payload: unknown;

		await streamSimple(model, context, {
			apiKey: "test-together-key",
			reasoning: reasoning === "off" ? undefined : reasoning,
			onPayload: (request) => {
				payload = request;
				throw new Error("payload captured");
			},
		}).result();

		expect(payload).toMatchObject({
			model: "deepseek-ai/DeepSeek-V4-Pro-0813",
			reasoning: { enabled: reasoning !== "off" },
		});
		if (reasoning === "off") {
			expect(payload).not.toHaveProperty("reasoning_effort");
		} else {
			expect(payload).toHaveProperty("reasoning_effort", reasoning);
		}
	});

	it("resolves TOGETHER_API_KEY from the environment", () => {
		process.env.TOGETHER_API_KEY = "test-together-key";

		expect(findEnvKeys("together")).toEqual(["TOGETHER_API_KEY"]);
		expect(getEnvApiKey("together")).toBe("test-together-key");
	});
});
