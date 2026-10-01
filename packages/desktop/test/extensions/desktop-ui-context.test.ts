import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createDesktopExtensionUIContext,
	type DesktopExtensionDialogRequest,
	type DesktopExtensionUIHost,
	UnsupportedDesktopExtensionUIError,
} from "../../src/extensions/ui-context.ts";

function createHost() {
	const calls: Array<{ operation: string; value: unknown }> = [];
	const diagnostics: Array<{ operation: string; migration: string }> = [];
	let editorText = "initial editor text";
	const host: DesktopExtensionUIHost = {
		requestDialog: async (request: DesktopExtensionDialogRequest, options) => {
			calls.push({ operation: "requestDialog", value: { request, options } });
			if (request.type === "confirm") return true;
			if (request.type === "select") return request.options[0];
			return request.type === "input" ? "typed input" : "edited text";
		},
		notify: (message, type) => calls.push({ operation: "notify", value: { message, type } }),
		setStatus: (key, text) => calls.push({ operation: "setStatus", value: { key, text } }),
		setWidget: (key, content, options) => calls.push({ operation: "setWidget", value: { key, content, options } }),
		setTitle: (title) => calls.push({ operation: "setTitle", value: title }),
		pasteToEditor: (text) => calls.push({ operation: "pasteToEditor", value: text }),
		setEditorText: (text) => {
			editorText = text;
			calls.push({ operation: "setEditorText", value: text });
		},
		getEditorText: () => editorText,
		setWorkingMessage: (message) => calls.push({ operation: "setWorkingMessage", value: message }),
		setWorkingVisible: (visible) => calls.push({ operation: "setWorkingVisible", value: visible }),
		setWorkingIndicator: (options) => calls.push({ operation: "setWorkingIndicator", value: options }),
		setHiddenThinkingLabel: (label) => calls.push({ operation: "setHiddenThinkingLabel", value: label }),
		getAllThemes: () => [{ name: "dark", path: undefined }],
		setTheme: (name) => ({ success: name === "dark" }),
		getToolsExpanded: () => false,
		setToolsExpanded: (expanded) => calls.push({ operation: "setToolsExpanded", value: expanded }),
		reportDiagnostic: ({ operation, migration }) => diagnostics.push({ operation, migration }),
	};
	return { host, calls, diagnostics };
}

describe("desktop extension UI context", () => {
	it("maps dialogs and serializable UI state to the injected desktop host", async () => {
		const { host, calls } = createHost();
		const ui = createDesktopExtensionUIContext(host);
		const abortController = new AbortController();

		assert.equal(await ui.select("Choose", ["first", "second"], { signal: abortController.signal }), "first");
		assert.equal(await ui.confirm("Continue?", "Proceed?"), true);
		assert.equal(await ui.input("Name", "placeholder"), "typed input");
		assert.equal(await ui.editor("Edit", "prefill"), "edited text");
		ui.notify("Notice", "warning");
		ui.setStatus("sync", "ready");
		ui.setWidget("task", ["line one", "line two"], { placement: "belowEditor" });
		ui.setTitle("Pi Orbit");
		ui.pasteToEditor("paste");
		assert.equal(ui.getEditorText(), "initial editor textpaste");
		ui.setEditorText("replacement");
		assert.equal(ui.getEditorText(), "replacement");
		ui.setWorkingMessage("Working");
		ui.setWorkingVisible(false);
		ui.setWorkingIndicator({ frames: ["*"] });
		ui.setHiddenThinkingLabel("Reasoning");
		assert.deepEqual(ui.getAllThemes(), [{ name: "dark", path: undefined }]);
		assert.deepEqual(ui.setTheme("dark"), { success: true });
		assert.equal(ui.getToolsExpanded(), false);
		ui.setToolsExpanded(true);

		assert.equal(calls.filter((call) => call.operation === "requestDialog").length, 4);
		assert.equal(
			calls.some((call) => call.operation === "setWidget"),
			true,
		);
		assert.equal(
			calls.some((call) => call.operation === "setTitle"),
			true,
		);
		assert.deepEqual(
			calls.filter((call) => call.operation === "pasteToEditor"),
			[{ operation: "pasteToEditor", value: "paste" }],
		);
	});

	it("diagnoses terminal-only operations and includes actionable migration guidance", async () => {
		const { host, diagnostics } = createHost();
		const ui = createDesktopExtensionUIContext(host);

		assert.throws(() => ui.onTerminalInput(() => undefined), UnsupportedDesktopExtensionUIError);
		await assert.rejects(
			ui.custom<number>(() => {
				throw new Error("must not invoke terminal factory");
			}),
			{
				name: "UnsupportedDesktopExtensionUIError",
			},
		);
		assert.throws(() =>
			ui.setWidget("custom", () => {
				throw new Error("must not invoke widget factory");
			}),
		);
		assert.throws(() =>
			ui.setFooter(() => {
				throw new Error("must not invoke footer factory");
			}),
		);
		assert.throws(() =>
			ui.setHeader(() => {
				throw new Error("must not invoke header factory");
			}),
		);
		assert.throws(() =>
			ui.addAutocompleteProvider(() => {
				throw new Error("must not invoke autocomplete factory");
			}),
		);
		assert.throws(() =>
			ui.setEditorComponent(() => {
				throw new Error("must not invoke editor factory");
			}),
		);
		assert.throws(() => ui.getEditorComponent());
		assert.throws(() => ui.getTheme("dark"));
		assert.throws(() => ui.theme);
		assert.throws(() => ui.setTheme({} as never), UnsupportedDesktopExtensionUIError);

		assert.deepEqual(
			diagnostics.map((diagnostic) => diagnostic.operation),
			[
				"onTerminalInput",
				"custom",
				"setWidget(factory)",
				"setFooter",
				"setHeader",
				"addAutocompleteProvider",
				"setEditorComponent",
				"getEditorComponent",
				"getTheme",
				"theme",
				"setTheme(Theme)",
			],
		);
		assert.equal(
			diagnostics.every((diagnostic) => diagnostic.migration.length > 20),
			true,
		);
	});

	it("keeps extension editor reads consistent with a write in the same desktop bridge", () => {
		const { host } = createHost();
		const ui = createDesktopExtensionUIContext({
			...host,
			getEditorText: () => "stale renderer snapshot",
		});

		assert.equal(ui.getEditorText(), "stale renderer snapshot");
		ui.setEditorText("new draft");
		assert.equal(ui.getEditorText(), "new draft");
		ui.setEditorText("");
		assert.equal(ui.getEditorText(), "");
	});

	it("maps a cancelled confirmation to false", async () => {
		const { host } = createHost();
		const ui = createDesktopExtensionUIContext({ ...host, requestDialog: async () => undefined });

		assert.equal(await ui.confirm("Continue?", "Proceed?"), false);
	});
});
