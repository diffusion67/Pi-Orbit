import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { McpServerEntry } from "../src/extensions/mcp/config.ts";
import type { McpManagerHandle } from "../src/extensions/mcp/index.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

function createServer() {
	const pair = createInMemoryTransportPair();
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const result =
			request.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "fake", version: "1" },
					}
				: request.method === "tools/list"
					? { tools: [{ name: "lookup", inputSchema: { type: "object", properties: {} } }] }
					: {};
		queueMicrotask(() => void pair.server.send({ jsonrpc: "2.0", id: request.id, result }));
	});
	void pair.server.start();
	return pair.client;
}

describe("MCP manager API", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	async function setup(
		config: McpServerEntry["config"] = {
			url: "https://user:password@example.invalid/mcp?token=secret",
			headers: { Authorization: "Bearer top-secret" },
			exposure: "direct",
		},
	) {
		const entry: McpServerEntry = {
			name: "private-docs",
			config,
			source: "private-test-config",
			scope: "global",
		};
		const savedPatches: unknown[] = [];
		let manager: McpManagerHandle | undefined;
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					createTransport: () => createServer(),
					updateConfig: (_entry, patch) => savedPatches.push(patch),
					onManager: (value) => {
						manager = value;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");
		if (!manager) throw new Error("MCP manager was not provided on session start");
		return { harness, manager, savedPatches };
	}

	async function setupConfigManager(projectTrusted = false, projectEntries?: Record<string, unknown>) {
		const root = mkdtempSync(join(tmpdir(), "pi-mcp-manager-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const fallbackAgentDir = join(root, "fallback-agent");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(fallbackAgentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { docs: { command: "not-run", enabled: false, env: { TOKEN: "hidden" } } } }),
		);
		const fallbackConfigPath = join(fallbackAgentDir, "mcp.json");
		const fallbackConfig = JSON.stringify({ mcpServers: { sentinel: { command: "untouched" } } });
		writeFileSync(fallbackConfigPath, fallbackConfig);
		vi.stubEnv(ENV_AGENT_DIR, fallbackAgentDir);
		let manager: McpManagerHandle | undefined;
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					agentDir,
					onManager: (value) => {
						manager = value;
					},
				}),
			],
		});
		harnesses.push(harness);
		harness.settingsManager.setProjectTrusted(projectTrusted);
		if (projectEntries) {
			const projectConfigPath = join(harness.tempDir, ".pi", "mcp.json");
			mkdirSync(join(harness.tempDir, ".pi"), { recursive: true });
			writeFileSync(projectConfigPath, JSON.stringify({ mcpServers: projectEntries }));
		}
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		if (!manager) throw new Error("MCP manager was not provided on session start");
		return { harness, manager, agentDir, fallbackConfigPath, fallbackConfig };
	}

	it("provides safe live status and exposes session operations to hosts", async () => {
		const { harness, manager, savedPatches } = await setup();
		await vi.waitFor(() => expect(manager.getServers()[0]?.state).toBe("connected"));

		const status = manager.getServers()[0];
		expect(status).toMatchObject({
			name: "private-docs",
			scope: "global",
			enabled: true,
			exposure: "direct",
			state: "connected",
			toolCount: 1,
			usesOAuth: false,
		});
		expect(JSON.stringify(status)).not.toMatch(/password|secret|top-secret|example\.invalid|private-test-config/);

		let changes = 0;
		const unsubscribe = manager.subscribe(() => changes++);
		expect(await manager.setExposure("private-docs", "deferred")).toEqual({ ok: true });
		expect(manager.getServers()[0]?.exposure).toBe("deferred");
		expect(savedPatches).toContainEqual({ exposure: "deferred" });
		expect(changes).toBeGreaterThan(0);

		expect(await manager.setEnabled("private-docs", false)).toEqual({ ok: true });
		expect(manager.getServers()[0]?.state).toBe("disabled");
		expect(savedPatches).toContainEqual({ enabled: false });
		expect(await manager.setEnabled("private-docs", true)).toEqual({ ok: true });
		await vi.waitFor(() => expect(manager.getServers()[0]?.state).toBe("connected"));
		expect(await manager.reconnect("private-docs")).toEqual({ ok: true });
		unsubscribe();
		expect(await manager.reconnect("missing")).toEqual({ ok: false, error: 'No MCP server named "missing".' });
		expect(await manager.signOut("private-docs")).toEqual({ ok: true, changed: false });

		let shownUrl = false;
		const signInResult = await manager.signIn("private-docs", {
			showAuthorizationUrl: () => {
				shownUrl = true;
			},
			promptForRedirectUrl: async () => undefined,
		});
		expect(signInResult).toEqual({ ok: false, error: 'MCP server "private-docs" does not use OAuth.' });
		expect(shownUrl).toBe(false);
		expect(harness.session.getCallableToolNames()).toContain("mcp__private_docs__lookup");
	});

	it("does not advertise provider-auth HTTP servers as OAuth", async () => {
		const { manager } = await setup({
			url: "https://example.invalid/mcp",
			auth: { provider: "private-provider" },
		});

		expect(manager.getServers()[0]?.usesOAuth).toBe(false);
		expect(
			await manager.signIn("private-docs", {
				showAuthorizationUrl: () => undefined,
				promptForRedirectUrl: async () => undefined,
			}),
		).toEqual({ ok: false, error: 'MCP server "private-docs" does not use OAuth.' });
	});

	it("validates and persists global add, update, and remove operations with explicit reload status", async () => {
		const { manager, agentDir, fallbackConfigPath, fallbackConfig } = await setupConfigManager();
		const path = join(agentDir, "mcp.json");
		const added = manager.addServer(
			"scratch",
			{ command: "not-run", enabled: false, env: { TOKEN: "credential-value" } },
			"global",
		);
		expect(added).toEqual({ ok: true, changed: true, reloadRequired: true });
		expect(manager.getServers().map((server) => server.name)).toEqual(["docs"]);

		const updated = manager.updateServer("docs", { command: "updated", enabled: false });
		expect(updated).toEqual({ ok: true, changed: true, reloadRequired: true });
		expect(manager.addServer("invalid name", { command: "x" }, "global")).toMatchObject({ ok: false });
		expect(manager.addServer("docs", { command: "shadow" }, "global")).toMatchObject({ ok: false });

		const removed = manager.removeServer("docs");
		expect(removed).toEqual({ ok: true, changed: true, reloadRequired: true });
		const config = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
		expect(config.mcpServers).toEqual({
			scratch: { command: "not-run", enabled: false, env: { TOKEN: "credential-value" } },
		});
		expect(JSON.stringify(manager.getServers())).not.toContain("credential-value");
		expect(readFileSync(fallbackConfigPath, "utf8")).toBe(fallbackConfig);
		expect(readFileSync(fallbackConfigPath, "utf8")).not.toContain("scratch");
	});

	it("enforces project trust and writes trusted project overrides at project scope", async () => {
		const untrusted = await setupConfigManager();
		expect(untrusted.manager.addServer("local-docs", { command: "x", enabled: false }, "project")).toEqual({
			ok: false,
			error: "Trust this project before adding a project MCP server.",
		});
		expect(readFileSync(join(untrusted.agentDir, "mcp.json"), "utf8")).not.toContain("local-docs");
		untrusted.harness.cleanup();
		harnesses.pop();

		const trusted = await setupConfigManager(true);
		const forbiddenConfig = { url: "https://example.invalid/mcp", auth: { provider: "private-provider" } };
		expect(trusted.manager.addServer("project-auth", forbiddenConfig, "project")).toEqual({
			ok: false,
			error: 'MCP server "project-auth": auth is only allowed in the global mcp.json',
		});
		const added = trusted.manager.addServer("docs", { command: "project-docs", enabled: false }, "project");
		expect(added).toEqual({ ok: true, changed: true, reloadRequired: true });
		const projectConfig = JSON.parse(readFileSync(join(trusted.harness.tempDir, ".pi", "mcp.json"), "utf8")) as {
			mcpServers: Record<string, unknown>;
		};
		expect(projectConfig.mcpServers.docs).toEqual({ command: "project-docs", enabled: false });

		const existingProject = await setupConfigManager(true, { docs: { command: "local-docs", enabled: false } });
		const rejectedUpdate = existingProject.manager.updateServer("docs", forbiddenConfig);
		expect(rejectedUpdate).toEqual({
			ok: false,
			error: 'MCP server "docs": auth is only allowed in the global mcp.json',
		});
		const unchanged = JSON.parse(readFileSync(join(existingProject.harness.tempDir, ".pi", "mcp.json"), "utf8")) as {
			mcpServers: Record<string, unknown>;
		};
		expect(unchanged.mcpServers.docs).toEqual({ command: "local-docs", enabled: false });
	});

	it("treats an active global-server override as project scoped and saves exposure there", async () => {
		const trusted = await setupConfigManager(true, { docs: { enabled: false, exposure: "deferred" } });
		const globalPath = join(trusted.agentDir, "mcp.json");
		const globalConfig = readFileSync(globalPath, "utf8");
		const projectPath = join(trusted.harness.tempDir, ".pi", "mcp.json");

		expect(trusted.manager.getServers()[0]).toMatchObject({
			name: "docs",
			scope: "project",
			enabled: false,
			exposure: "deferred",
		});
		expect(trusted.manager.setExposure("docs", "direct")).toEqual({ ok: true });
		expect(readFileSync(globalPath, "utf8")).toBe(globalConfig);
		expect(JSON.parse(readFileSync(projectPath, "utf8"))).toMatchObject({
			mcpServers: { docs: { enabled: false, exposure: "direct" } },
		});
	});

	it("updates and removes a project override without changing its global server", async () => {
		const trusted = await setupConfigManager(true, { docs: { enabled: false } });
		const globalPath = join(trusted.agentDir, "mcp.json");
		const globalConfig = readFileSync(globalPath, "utf8");
		const projectPath = join(trusted.harness.tempDir, ".pi", "mcp.json");

		expect(
			trusted.manager.updateServer("docs", {
				url: "https://example.invalid/mcp",
				auth: { provider: "private-provider" },
			}),
		).toEqual({
			ok: false,
			error: 'MCP server "docs": auth is only allowed in the global mcp.json',
		});
		expect(readFileSync(globalPath, "utf8")).toBe(globalConfig);
		expect(JSON.parse(readFileSync(projectPath, "utf8"))).toMatchObject({
			mcpServers: { docs: { enabled: false } },
		});

		expect(trusted.manager.updateServer("docs", { command: "project-docs", enabled: false })).toEqual({
			ok: true,
			changed: true,
			reloadRequired: true,
		});
		expect(readFileSync(globalPath, "utf8")).toBe(globalConfig);
		expect(JSON.parse(readFileSync(projectPath, "utf8"))).toMatchObject({
			mcpServers: { docs: { command: "project-docs", enabled: false } },
		});

		expect(trusted.manager.removeServer("docs")).toEqual({ ok: true, changed: true, reloadRequired: true });
		expect(readFileSync(globalPath, "utf8")).toBe(globalConfig);
		expect(JSON.parse(readFileSync(projectPath, "utf8"))).toMatchObject({ mcpServers: {} });
	});
});
