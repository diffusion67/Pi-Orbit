import { describe, expect, it } from "vitest";
import { isWorkerMainRequest, isWorkerRequest, parseMcpServerConfigJson } from "../../src/shared/worker-protocol.ts";

describe("desktop worker protocol", () => {
	it("accepts supported commands with strict payloads", () => {
		expect(isWorkerRequest({ id: "1", type: "init", payload: { cwd: "C:/repo", tools: ["read"] } })).toBe(true);
		expect(isWorkerRequest({ id: "2", type: "prompt", payload: { text: "hello" } })).toBe(true);
		expect(isWorkerRequest({ id: "3", type: "message", payload: { text: "continue", deliverAs: "followUp" } })).toBe(
			true,
		);
		expect(isWorkerRequest({ id: "4", type: "history", payload: {} })).toBe(true);
		expect(isWorkerRequest({ id: "5", type: "auth.refresh", payload: { provider: "anthropic" } })).toBe(true);
		expect(
			isWorkerRequest({
				id: "6",
				type: "main.resolve",
				payload: { requestId: "req-1", result: { id: "task-1", status: "queued" } },
			}),
		).toBe(true);
		expect(
			isWorkerMainRequest({ action: "task.create", payload: { roleId: "builder", prompt: "inspect tests" } }),
		).toBe(true);
		expect(isWorkerMainRequest({ action: "task.wait", payload: { taskId: "task-1", timeoutMs: 60_000 } })).toBe(true);
		expect(isWorkerRequest({ id: "mcp-list", type: "mcp.list", payload: {} })).toBe(true);
		expect(isWorkerRequest({ id: "mcp-reload", type: "mcp.reload", payload: {} })).toBe(true);
		expect(
			isWorkerRequest({
				id: "mcp-add",
				type: "mcp.add",
				payload: { name: "docs", scope: "project", configJson: '{"url":"https://example.com/mcp"}' },
			}),
		).toBe(true);
		expect(isWorkerRequest({ id: "mcp-remove", type: "mcp.remove", payload: { name: "docs" } })).toBe(true);
	});

	it("rejects unknown operations and extra executable fields", () => {
		expect(isWorkerRequest({ id: "1", type: "invoke", payload: { method: "process.exit" } })).toBe(false);
		expect(isWorkerRequest({ id: "2", type: "prompt", payload: { text: "hello", execute: "process.exit" } })).toBe(
			false,
		);
		expect(isWorkerRequest({ id: "3", type: "message", payload: { text: "continue", deliverAs: "arbitrary" } })).toBe(
			false,
		);
		expect(isWorkerRequest({ id: "4", type: "history", payload: { sessionFile: "C:/arbitrary.jsonl" } })).toBe(false);
		expect(
			isWorkerRequest({ id: "5", type: "auth.refresh", payload: { provider: "anthropic", apiKey: "secret" } }),
		).toBe(false);
		expect(
			isWorkerRequest({ id: "6", type: "auth.configure", payload: { provider: "anthropic", apiKey: "secret" } }),
		).toBe(false);
		expect(
			isWorkerRequest({
				id: "7",
				type: "main.resolve",
				payload: { requestId: "req-1", result: { done: true }, error: { code: "ERROR", message: "failed" } },
			}),
		).toBe(false);
		expect(
			isWorkerRequest({
				id: "8",
				type: "main.resolve",
				payload: { requestId: "req-1", error: { code: "ERROR", message: "failed" } },
			}),
		).toBe(true);
		expect(isWorkerRequest({ id: "mcp-invalid-action", type: "mcp.invoke", payload: { method: "signOut" } })).toBe(
			false,
		);
		expect(
			isWorkerRequest({ id: "mcp-invalid-extra", type: "mcp.remove", payload: { name: "docs", config: {} } }),
		).toBe(false);
		expect(
			isWorkerMainRequest({
				action: "task.create",
				payload: { projectId: "untrusted", roleId: "builder", prompt: "inspect tests" },
			}),
		).toBe(false);
		expect(isWorkerMainRequest({ action: "task.wait", payload: { taskId: "task-1", timeoutMs: 60_001 } })).toBe(
			false,
		);
		expect(() => parseMcpServerConfigJson("{}")).toThrow("supported stdio or HTTP server");
		expect(
			parseMcpServerConfigJson('{"url":"https://example.com/mcp","headers":{"Authorization":"Bearer secret"}}'),
		).toMatchObject({ url: "https://example.com/mcp" });
		expect(() => parseMcpServerConfigJson('{"url":"https://example.com/mcp","arbitrary":"value"}')).toThrow(
			"supported stdio or HTTP server",
		);
	});
});
