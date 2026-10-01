import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	Theme,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export type DesktopExtensionDialogRequest =
	| { type: "select"; title: string; options: string[] }
	| { type: "confirm"; title: string; message: string }
	| { type: "input"; title: string; placeholder?: string }
	| { type: "editor"; title: string; prefill?: string };

export type DesktopExtensionUIDiagnostic = {
	code: "unsupported_desktop_ui";
	operation: string;
	message: string;
	migration: string;
};

export class UnsupportedDesktopExtensionUIError extends Error {
	readonly diagnostic: DesktopExtensionUIDiagnostic;

	constructor(diagnostic: DesktopExtensionUIDiagnostic) {
		super(diagnostic.message);
		this.name = "UnsupportedDesktopExtensionUIError";
		this.diagnostic = diagnostic;
	}
}

export type DesktopExtensionUIHost = {
	requestDialog(
		request: DesktopExtensionDialogRequest,
		options?: ExtensionUIDialogOptions,
	): Promise<string | boolean | undefined>;
	notify(message: string, type: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	setTitle(title: string): void;
	pasteToEditor(text: string): void;
	setEditorText(text: string): void;
	getEditorText(): string;
	setWorkingMessage(message: string | undefined): void;
	setWorkingVisible(visible: boolean): void;
	setWorkingIndicator(options: WorkingIndicatorOptions | undefined): void;
	setHiddenThinkingLabel(label: string | undefined): void;
	getAllThemes(): Array<{ name: string; path: string | undefined }>;
	setTheme(name: string): { success: boolean; error?: string };
	getToolsExpanded(): boolean;
	setToolsExpanded(expanded: boolean): void;
	reportDiagnostic(diagnostic: DesktopExtensionUIDiagnostic): void;
};

type ExtensionWidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

function expectOptionalText(value: unknown, operation: string): string | undefined {
	if (value === undefined || typeof value === "string") return value;
	throw new TypeError(`Desktop extension UI returned an invalid ${operation} response`);
}

function unsupported(host: DesktopExtensionUIHost, operation: string, migration: string): never {
	const diagnostic: DesktopExtensionUIDiagnostic = {
		code: "unsupported_desktop_ui",
		operation,
		message: `Extension UI operation "${operation}" requires terminal components and is unavailable in desktop mode.`,
		migration,
	};
	host.reportDiagnostic(diagnostic);
	throw new UnsupportedDesktopExtensionUIError(diagnostic);
}

/** Build the Pi extension UI bridge for desktop hosts. */
export function createDesktopExtensionUIContext(host: DesktopExtensionUIHost): ExtensionUIContext {
	let editorText: string | undefined;
	return {
		select: async (title, options, dialogOptions) =>
			expectOptionalText(
				await host.requestDialog({ type: "select", title, options: [...options] }, dialogOptions),
				"select",
			),
		confirm: async (title, message, dialogOptions) => {
			const result = await host.requestDialog({ type: "confirm", title, message }, dialogOptions);
			if (result === undefined) return false;
			if (typeof result !== "boolean")
				throw new TypeError("Desktop extension UI returned an invalid confirm response");
			return result;
		},
		input: async (title, placeholder, dialogOptions) =>
			expectOptionalText(
				await host.requestDialog(
					{ type: "input", title, ...(placeholder === undefined ? {} : { placeholder }) },
					dialogOptions,
				),
				"input",
			),
		notify: (message, type = "info") => host.notify(message, type),
		onTerminalInput: () =>
			unsupported(
				host,
				"onTerminalInput",
				"Replace raw key handling with a named Pi command or a desktop UI control that sends a typed task/session action.",
			),
		setStatus: (key, text) => host.setStatus(key, text),
		setWorkingMessage: (message) => host.setWorkingMessage(message),
		setWorkingVisible: (visible) => host.setWorkingVisible(visible),
		setWorkingIndicator: (options) => host.setWorkingIndicator(options),
		setHiddenThinkingLabel: (label) => host.setHiddenThinkingLabel(label),
		setWidget: (
			key: string,
			content: string[] | ExtensionWidgetFactory | undefined,
			options?: ExtensionWidgetOptions,
		) => {
			if (typeof content === "function") {
				unsupported(
					host,
					"setWidget(factory)",
					"Replace the TUI component factory with a string-array widget or a desktop-owned React view driven by extension events.",
				);
			}
			host.setWidget(key, content, options);
		},
		setFooter: () =>
			unsupported(
				host,
				"setFooter",
				"Replace the TUI footer factory with status text, a serializable widget, or a desktop-owned React view.",
			),
		setHeader: () =>
			unsupported(
				host,
				"setHeader",
				"Replace the TUI header factory with status text, a serializable widget, or a desktop-owned React view.",
			),
		setTitle: (title) => host.setTitle(title),
		custom: async <_T>() =>
			unsupported(
				host,
				"custom",
				"Replace the TUI component with select, confirm, input, editor, or a desktop-owned React view driven by extension events.",
			),
		pasteToEditor: (text) => {
			editorText = `${editorText ?? host.getEditorText()}${text}`;
			host.pasteToEditor(text);
		},
		setEditorText: (text) => {
			editorText = text;
			host.setEditorText(text);
		},
		getEditorText: () => editorText ?? host.getEditorText(),
		editor: async (title, prefill) =>
			expectOptionalText(
				await host.requestDialog({ type: "editor", title, ...(prefill === undefined ? {} : { prefill }) }),
				"editor",
			),
		addAutocompleteProvider: () =>
			unsupported(
				host,
				"addAutocompleteProvider",
				"Move autocomplete rendering and keyboard interaction into a desktop-owned React editor integration.",
			),
		setEditorComponent: () =>
			unsupported(
				host,
				"setEditorComponent",
				"Replace the terminal editor factory with the desktop editor API and serializable editor text methods.",
			),
		getEditorComponent: () =>
			unsupported(
				host,
				"getEditorComponent",
				"Use desktop editor state and serializable editor text methods instead of reading a TUI component factory.",
			),
		get theme() {
			return unsupported(host, "theme", "Use desktop application theme tokens instead of the TUI Theme object.");
		},
		getAllThemes: () => host.getAllThemes(),
		getTheme: () =>
			unsupported(host, "getTheme", "Use desktop application theme tokens instead of loading a TUI Theme object."),
		setTheme: (theme) => {
			if (typeof theme !== "string") {
				return unsupported(
					host,
					"setTheme(Theme)",
					"Pass a theme name and map it to the desktop application's theme system.",
				);
			}
			return host.setTheme(theme);
		},
		getToolsExpanded: () => host.getToolsExpanded(),
		setToolsExpanded: (expanded) => host.setToolsExpanded(expanded),
	};
}
