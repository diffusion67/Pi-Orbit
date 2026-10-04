import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CdpConnectionClosedError, closeApp } from "./desktop-shutdown.mjs";

async function main() {
const executable = process.argv[2];
if (!executable) throw new Error("Usage: node desktop-api-smoke.mjs <installed-app-executable>");

const scratch = await mkdtemp(join(tmpdir(), "pi-orbit-installed-smoke-"));
const profile = join(scratch, "profile");
const agentDir = join(scratch, "agent");
const projectPath = join(scratch, "project");
await Promise.all([mkdir(profile, { recursive: true }), mkdir(agentDir), mkdir(projectPath)]);
const canonicalProjectPath = await realpath(projectPath);
const git = spawnSync("git", ["init", "--initial-branch=main", projectPath], { encoding: "utf8" });
if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
await writeFile(join(projectPath, "README.md"), "Pi Orbit installed artifact smoke project\n");
for (const args of [
	["-C", projectPath, "config", "user.name", "Pi Orbit Smoke"],
	["-C", projectPath, "config", "user.email", "pi-orbit-smoke@example.invalid"],
	["-C", projectPath, "add", "README.md"],
	["-C", projectPath, "commit", "-m", "desktop smoke fixture"],
]) {
	const result = spawnSync("git", args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.at(-1)} failed: ${result.stderr}`);
}

const calls = [];
const server = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const bodyText = Buffer.concat(chunks).toString("utf8");
	let body;
	try {
		body = JSON.parse(bodyText);
	} catch {
		response.writeHead(400).end("Invalid request JSON");
		return;
	}
	if (request.method !== "POST" || new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/v1/chat/completions") {
		response.writeHead(404).end("Not found");
		return;
	}
	if (request.headers.authorization !== "Bearer local-smoke-only") {
		response.writeHead(401).end("Unexpected faux provider credential");
		return;
	}
	calls.push(body);
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const serialized = JSON.stringify(body);
	if (serialized.includes("orbit-task-recovery-probe")) {
		response.write(": task response intentionally held for restart recovery probe\n\n");
		return;
	}
	for (const chunk of [
		{ id: "chatcmpl-orbit-smoke", object: "chat.completion.chunk", created: 1, model: "smoke", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
		{ id: "chatcmpl-orbit-smoke", object: "chat.completion.chunk", created: 1, model: "smoke", choices: [{ index: 0, delta: { content: "Pi Orbit faux provider response" }, finish_reason: null }] },
		{ id: "chatcmpl-orbit-smoke", object: "chat.completion.chunk", created: 1, model: "smoke", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	response.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await new Promise((resolveListen, reject) => {
	server.once("listening", resolveListen);
	server.once("error", reject);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not bind the faux provider");
const debugPort = await getUnusedPort();

await writeFile(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			"orbit-smoke": {
				name: "Pi Orbit smoke faux provider",
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				apiKey: "local-smoke-only",
				api: "openai-completions",
				models: [
					{
						id: "smoke",
						name: "Local smoke model",
						reasoning: false,
						input: ["text"],
						contextWindow: 8192,
						maxTokens: 512,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
);

const runtimeEnv = { ...process.env };
for (const name of Object.keys(runtimeEnv)) {
	// Xvfb uses XAUTHORITY to let the packaged Linux app connect to its display.
	if (name !== "XAUTHORITY" && /API_?KEY|AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|AWS_PROFILE/i.test(name)) {
		delete runtimeEnv[name];
	}
}
runtimeEnv.PI_CODING_AGENT_DIR = agentDir;
runtimeEnv.PI_AGENT_DIR = agentDir;
if (process.platform === "win32") {
	runtimeEnv.APPDATA = join(profile, "Roaming");
	runtimeEnv.LOCALAPPDATA = join(profile, "Local");
	runtimeEnv.USERPROFILE = profile;
	await Promise.all([mkdir(runtimeEnv.APPDATA, { recursive: true }), mkdir(runtimeEnv.LOCALAPPDATA, { recursive: true })]);
} else {
	runtimeEnv.HOME = profile;
	runtimeEnv.XDG_CONFIG_HOME = join(profile, ".config");
	runtimeEnv.XDG_CACHE_HOME = join(profile, ".cache");
	await Promise.all([mkdir(runtimeEnv.XDG_CONFIG_HOME, { recursive: true }), mkdir(runtimeEnv.XDG_CACHE_HOME, { recursive: true })]);
}

let appProcess;
let cdp;
try {
	appProcess = startApp(executable, debugPort, profile, runtimeEnv);
	cdp = await connectToPage(debugPort, appProcess);
	console.log("Installed smoke: connected to application");
	let snapshot = assertOk(await invoke(cdp, "app.snapshot"), "initial snapshot");
	if (!snapshot.providers.some((provider) => provider.id === "openai")) throw new Error("OpenAI auth provider missing from packaged runtime");
	assertOk(await invoke(cdp, "auth.configure", { providerId: "openai", credential: "pi-orbit-smoke-credential" }), "configure faux credential");
	snapshot = assertOk(await invoke(cdp, "app.snapshot"), "configured snapshot");
	if (!snapshot.providers.some((provider) => provider.id === "openai" && provider.configured)) throw new Error("Configured provider status was not returned");
	if (JSON.stringify(snapshot).includes("pi-orbit-smoke-credential")) throw new Error("Provider credential leaked through the desktop snapshot");
	assertOk(await invoke(cdp, "project.open", { path: projectPath }), "open temporary project");
	snapshot = assertOk(await invoke(cdp, "app.snapshot"), "project snapshot");
	const project = snapshot.projects.find((item) => item.path === canonicalProjectPath);
	if (!project) throw new Error("Project did not appear in the desktop snapshot");
	console.log("Installed smoke: authentication and project ready");
	const terminal = assertOk(await invoke(cdp, "terminal.start", { projectId: project.id }), "start installed terminal");
	if (terminal.state !== "running") throw new Error(`Installed terminal did not start: ${terminal.state}`);
	assertOk(await invoke(cdp, "terminal.input", { terminalId: terminal.id, text: "echo pi-orbit-terminal-smoke\r" }), "write to installed terminal");
	await waitFor(async () => {
		const current = assertOk(await invoke(cdp, "app.snapshot"), "terminal snapshot");
		return current.terminal?.id === terminal.id && current.terminal.output.includes("pi-orbit-terminal-smoke");
	}, "installed terminal output");
	assertOk(await invoke(cdp, "terminal.resize", { terminalId: terminal.id, cols: 100, rows: 30 }), "resize installed terminal");
	assertOk(await invoke(cdp, "terminal.stop", { terminalId: terminal.id }), "stop installed terminal");
	console.log("Installed smoke: terminal verified");
	await cdp.evaluate("document.querySelector('.top-actions .icon-button')?.click()");
	await waitFor(async () => (await cdp.evaluate("Boolean(document.querySelector('.settings-form'))")) === true, "settings form");
	await selectSettingsOption(cdp, "ctrlEnter");
	await selectSettingsOption(cdp, "light");
	await waitFor(async () => (await cdp.evaluate("document.documentElement.dataset.theme")) === "light", "light theme preview");
	await selectSettingsOption(cdp, "dark");
	await waitFor(async () => (await cdp.evaluate("document.documentElement.dataset.theme")) === "dark", "dark theme preview");
	await selectSettingsOption(cdp, "zh-CN");
	await waitFor(async () => (await cdp.evaluate("document.documentElement.lang")) === "zh-CN", "Chinese language preview");
	await cdp.evaluate("document.querySelector('.settings-form').requestSubmit()");
	await waitFor(async () => {
		const current = assertOk(await invoke(cdp, "app.snapshot"), "saved UI settings");
		return current.settings.language === "zh-CN" && current.settings.sendShortcut === "ctrlEnter" && current.settings.theme === "dark";
	}, "settings form persistence");
	console.log("Installed smoke: settings verified");
	await cdp.evaluate("document.querySelector('.modal-head .icon-button')?.click()");
	await cdp.evaluate("document.querySelector('.top-actions .icon-button')?.click()");
	await waitFor(async () => (await cdp.evaluate("Boolean(document.querySelector('.settings-form'))")) === true, "reopened settings form");
	await selectSettingsOption(cdp, "light");
	await waitFor(async () => (await cdp.evaluate("document.documentElement.dataset.theme")) === "light", "unsaved theme preview");
	await cdp.evaluate("document.querySelector('.modal-head .icon-button')?.click()");
	await waitFor(async () => (await cdp.evaluate("document.documentElement.dataset.theme")) === "dark", "saved theme restored after closing settings");
	const uiSettings = assertOk(await invoke(cdp, "app.snapshot"), "UI settings snapshot").settings;
	assertOk(await invoke(cdp, "settings.save", {
		...uiSettings,
		defaultModel: "orbit-smoke/smoke",
		confirmToolCalls: false,
		subagentsEnabled: true,
	}), "save settings");
	await waitFor(async () => (await cdp.evaluate("document.documentElement.lang")) === "zh-CN", "Chinese desktop language");
	const session = assertOk(await invoke(cdp, "session.create", { projectId: project.id, model: "orbit-smoke/smoke" }), "create faux-model session");
	console.log("Installed smoke: session created");
	await waitFor(async () => (await cdp.evaluate("document.querySelector('.rename-session-button')?.disabled === false")) === true, "active session rename action");
	await cdp.evaluate("document.querySelector('.rename-session-button').click()");
	await waitFor(async () => (await cdp.evaluate("Boolean(document.querySelector('.session-rename input'))")) === true, "session rename form");
	const longTitle = "Long session title ".repeat(12).slice(0, 200);
	await setFieldValue(cdp, ".session-rename input", longTitle);
	await cdp.evaluate("document.querySelector('.session-rename').requestSubmit()");
	await waitFor(async () => (await cdp.evaluate("document.querySelector('.conversation-head h1')?.textContent")) === longTitle, "long session title");
	const titleFits = await cdp.evaluate("document.querySelector('.conversation-head h1').getBoundingClientRect().right <= document.querySelector('.conversation-actions').getBoundingClientRect().left");
	if (!titleFits) throw new Error("A long session title overlaps conversation actions");
	await waitFor(async () => (await cdp.evaluate("Boolean(document.querySelector('.session-rename'))")) === false, "completed session rename");
	await cdp.evaluate("document.querySelector('.rename-session-button').click()");
	await waitFor(async () => (await cdp.evaluate("Boolean(document.querySelector('.session-rename input'))")) === true, "reopened session rename form");
	await setFieldValue(cdp, ".session-rename input", "Orbit smoke renamed session");
	await cdp.evaluate("document.querySelector('.session-rename').requestSubmit()");
	await waitFor(async () => assertOk(await invoke(cdp, "app.snapshot"), "renamed session").sessions.some((item) => item.id === session.id && item.title === "Orbit smoke renamed session"), "persisted session name");
	await setFieldValue(cdp, ".session-search", "definitely-no-matching-session");
	await waitFor(async () => (await cdp.evaluate("document.querySelectorAll('.session-row').length")) === 0, "empty session search");
	await setFieldValue(cdp, ".session-search", "SMOKE RENAMED");
	await waitFor(async () => (await cdp.evaluate("document.querySelectorAll('.session-row').length")) === 1, "case-insensitive session search");
	await setFieldValue(cdp, ".session-search", "");
	await setFieldValue(cdp, ".composer textarea", "orbit-first-draft");
	const otherSession = assertOk(await invoke(cdp, "session.create", { projectId: project.id, model: "orbit-smoke/smoke" }), "create second draft session");
	await waitFor(async () => (await cdp.evaluate("document.querySelector('.composer textarea')?.value")) === "", "new session has its own draft");
	await setFieldValue(cdp, ".composer textarea", "orbit-second-draft");
	assertOk(await invoke(cdp, "session.select", { sessionId: session.id }), "restore first session draft");
	await waitFor(async () => (await cdp.evaluate("document.querySelector('.composer textarea')?.value")) === "orbit-first-draft", "first draft restored after switching");
	console.log("Installed smoke: session search, rename, and independent drafts verified");
	await cdp.evaluate("window.__piOrbitDiagnostics = []; window.piOrbit.subscribe(0, event => { if (event.type === 'diagnostic') window.__piOrbitDiagnostics.push({ code: event.code, message: event.message }); })");
	await waitFor(async () => (await cdp.evaluate("Boolean(document.querySelector('.composer textarea:not([disabled])'))")) === true, "active conversation composer");
	await cdp.evaluate(`(() => {
		const textarea = document.querySelector('.composer textarea');
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
		if (!textarea || !setter) throw new Error('Conversation composer is unavailable');
		setter.call(textarea, 'orbit-session-smoke');
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	await waitFor(async () => (await cdp.evaluate("document.querySelector('.composer .send-button')?.disabled === false")) === true, "composer draft");
	await cdp.evaluate("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))");
	await delay(300);
	if (assertOk(await invoke(cdp, "app.snapshot"), "unsent shortcut snapshot").messages.some((message) => message.role === "user" && message.parts.some((part) => part.text === "orbit-session-smoke")))
		throw new Error("Enter sent a message despite the Ctrl+Enter preference");
	await cdp.evaluate("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))");
	try {
		await waitFor(async () => {
			const current = assertOk(await invoke(cdp, "app.snapshot"), "conversation snapshot");
			return current.messages.some((message) => message.role === "assistant" && message.parts.some((part) => part.text?.includes("Pi Orbit faux provider response")));
		}, "faux provider conversation");
	} catch (error) {
		const current = assertOk(await invoke(cdp, "app.snapshot"), "failed conversation snapshot");
		const diagnostics = await cdp.evaluate("window.__piOrbitDiagnostics");
		console.error(JSON.stringify({ modelCalls: calls.length, sessions: current.sessions, messages: current.messages, diagnostics }));
		throw error;
	}
	console.log("Installed smoke: conversation verified");
	const role = assertOk(await invoke(cdp, "role.save", {
		id: "desktop-smoke-role",
		name: "Desktop smoke role",
		description: "Temporary installed-artifact verification role",
		systemPrompt: "Reply briefly. Do not use tools.",
		model: "orbit-smoke/smoke",
		tools: [],
		scope: "project",
	}), "save role");
	const task = assertOk(await invoke(cdp, "task.create", {
		projectId: project.id,
		roleId: role.id,
		prompt: "orbit-task-recovery-probe",
		dependsOn: [],
	}), "create running faux-model task");
	if (task.status !== "running") throw new Error(`Expected task to be running before shutdown; got ${task.status}`);
	await waitFor(() => calls.some((request) => JSON.stringify(request).includes("orbit-task-recovery-probe")), "task request reached local faux provider");
	if (calls.length !== 2) throw new Error(`Expected exactly 2 local model requests before restart; got ${calls.length}`);
	console.log("Installed smoke: child task started");
	await setFieldValue(cdp, ".composer textarea", "orbit-restored-draft");
	await closeApp(cdp, appProcess);
	cdp = undefined;
	appProcess = undefined;

	const nextDebugPort = await getUnusedPort();
	appProcess = startApp(executable, nextDebugPort, profile, runtimeEnv);
	cdp = await connectToPage(nextDebugPort, appProcess);
	console.log("Installed smoke: restarted application");
	await waitFor(async () => (await cdp.evaluate("document.documentElement.lang")) === "zh-CN", "restored Chinese desktop language");
	await waitFor(async () => {
		const restored = assertOk(await invoke(cdp, "app.snapshot"), "recovered snapshot");
		return restored.tasks.some((item) => item.id === task.id && item.status === "review") &&
			restored.sessions.some((item) => item.id === session.id) &&
			restored.activeSessionId === session.id &&
				restored.projects.some((item) => item.id === project.id) &&
				restored.settings.language === "zh-CN" &&
				restored.settings.defaultModel === "orbit-smoke/smoke" &&
				restored.settings.sendShortcut === "ctrlEnter" &&
			restored.providers.some((item) => item.id === "openai" && item.configured) &&
			restored.roles.some((item) => item.id === role.id);
	}, "recovery of task, session, project, settings, auth, and role");

	if (!assertOk(await invoke(cdp, "app.snapshot"), "restored session name").sessions.some((item) => item.id === session.id && item.title === "Orbit smoke renamed session")) throw new Error("Session rename was lost after restart");
	await waitFor(async () => (await cdp.evaluate("document.querySelector('.composer textarea')?.value")) === "orbit-restored-draft", "first text draft restored after restart");
	assertOk(await invoke(cdp, "session.select", { sessionId: otherSession.id }), "restore second session after restart");
	await waitFor(async () => (await cdp.evaluate("document.querySelector('.composer textarea')?.value")) === "orbit-second-draft", "second text draft restored after restart");
	assertOk(await invoke(cdp, "session.select", { sessionId: session.id }), "reselect original session after draft verification");
	await waitFor(async () => (await cdp.evaluate("document.querySelector('.composer textarea')?.value")) === "orbit-restored-draft", "original draft remains isolated");
	const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
	await writeFile(join(process.cwd(), "packages/desktop/release/ui-smoke.png"), Buffer.from(screenshot.data, "base64"));
	console.log("Installed smoke: renamed sessions and text drafts survive restart");
	await delay(1500);
	if (calls.length !== 2) throw new Error(`Application replayed an interrupted model request after restart (request count ${calls.length})`);
	console.log("Installed Pi Orbit API smoke passed: terminal, local faux conversation, auth/settings/session/project-role persistence, task recovery, and no interrupted request replay.");
	await closeApp(cdp, appProcess);
	cdp = undefined;
	appProcess = undefined;
} finally {
	if (cdp) await cdp.close().catch(() => undefined);
	if (appProcess && appProcess.exitCode === null) {
		appProcess.kill();
		await Promise.race([new Promise((resolveExit) => appProcess.once("exit", resolveExit)), delay(5000)]);
	}
	server.closeAllConnections();
	await new Promise((resolveClose) => server.close(resolveClose));
	await rm(scratch, { recursive: true, force: true });
}
}

function startApp(appPath, port, userDataDir, env) {
	const child = spawn(resolve(appPath), [
		`--user-data-dir=${userDataDir}`,
		`--remote-debugging-port=${port}`,
		"--remote-allow-origins=*",
	], { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
	child.stdout.on("data", (chunk) => process.stdout.write(`App: ${chunk}`));
	child.stderr.on("data", (chunk) => process.stderr.write(`App: ${chunk}`));
	child.once("error", (error) => console.error(`Application launch error: ${error.message}`));
	return child;
}

async function connectToPage(port, child) {
	const stopAt = Date.now() + 45_000;
	let lastError;
	while (Date.now() < stopAt) {
		if (child.exitCode !== null) throw new Error(`Installed application exited before CDP was ready (code ${child.exitCode})`);
		try {
			const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) }).then((response) => response.json());
			const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
			if (target) {
				const socket = new WebSocket(target.webSocketDebuggerUrl);
				await new Promise((resolveOpen, reject) => {
					socket.addEventListener("open", resolveOpen, { once: true });
					socket.addEventListener("error", () => reject(new Error("Could not attach to the packaged application page")), { once: true });
				});
				const connection = new CdpConnection(socket);
				await waitFor(async () => (await connection.evaluate("Boolean(window.piOrbit)")) === true, "desktop preload bridge");
				return connection;
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Installed application exited")) throw error;
			lastError = error;
		}
		await delay(250);
	}
	throw new Error(`Timed out waiting for the installed application's local debugging endpoint: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function invoke(connection, command, payload) {
	const expression = `window.piOrbit.invoke(${JSON.stringify(command)}, ${JSON.stringify(payload)})`;
	return connection.evaluate(expression, true);
}

function assertOk(result, operation) {
	if (!result?.ok) throw new Error(`${operation} failed: ${result?.code ?? "UNKNOWN"} ${result?.message ?? ""}`);
	return result.data;
}

async function setFieldValue(connection, selector, value) {
	await connection.evaluate(`(() => {
		const field = document.querySelector(${JSON.stringify(selector)});
		if (!field) throw new Error('Input field is unavailable');
		const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, ${JSON.stringify(value)});
		field.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
}

async function selectSettingsOption(connection, value) {
	await connection.evaluate(`(() => {
		const select = Array.from(document.querySelectorAll('.settings-form select'))
			.find((candidate) => Array.from(candidate.options).some((option) => option.value === ${JSON.stringify(value)}));
		if (!select) throw new Error('Settings option ${value} is unavailable');
		select.value = ${JSON.stringify(value)};
		select.dispatchEvent(new Event('change', { bubbles: true }));
	})()`);
}

async function waitFor(predicate, label) {
	const stopAt = Date.now() + 45_000;
	while (Date.now() < stopAt) {
		if (await predicate()) return;
		await delay(250);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function getUnusedPort() {
	const probe = createServer();
	probe.listen(0, "127.0.0.1");
	await new Promise((resolveListen, reject) => {
		probe.once("listening", resolveListen);
		probe.once("error", reject);
	});
	const address = probe.address();
	if (!address || typeof address === "string") throw new Error("Could not allocate a debugging port");
	await new Promise((resolveClose) => probe.close(resolveClose));
	return address.port;
}

class CdpConnection {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data));
			if (message.id === undefined) return;
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
		});
		socket.addEventListener("close", () => {
			for (const pending of this.pending.values()) pending.reject(new CdpConnectionClosedError());
			this.pending.clear();
		});
	}

	send(method, params = {}) {
		const id = this.nextId++;
		return new Promise((resolveResponse, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP ${method} timed out`));
			}, 30_000);
			this.pending.set(id, {
				resolve: (response) => { clearTimeout(timer); resolveResponse(response); },
				reject: (error) => { clearTimeout(timer); reject(error); },
			});
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	async evaluate(expression, awaitPromise = false) {
		const response = await this.send("Runtime.evaluate", {
			expression,
			awaitPromise,
			returnByValue: true,
			userGesture: true,
		});
		if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "Renderer evaluation failed");
		return response.result?.value;
	}

	close() {
		this.socket.close();
		return Promise.resolve();
	}
}

await main();
