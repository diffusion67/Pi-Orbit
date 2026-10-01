import { basename } from "node:path";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { DesktopCatalogEntry } from "../shared/desktop-types.ts";

export type DesktopResourceKind = "skill" | "template" | "command" | "extension";

export interface DesktopResourceCatalog {
	skills: DesktopCatalogEntry[];
	templates: DesktopCatalogEntry[];
	commands: DesktopCatalogEntry[];
	extensions: DesktopCatalogEntry[];
}

export function listDesktopResources(runtime: AgentSessionRuntime): DesktopResourceCatalog {
	const loader = runtime.services.resourceLoader;
	const skills = loader.getSkills().skills.map((skill) => ({
		id: skill.name,
		name: skill.name,
		description: skill.description,
		source: skill.sourceInfo.source,
		enabled: true,
	}));
	const templates = loader.getPrompts().prompts.map((template) => ({
		id: template.name,
		name: template.name,
		description: template.description,
		source: template.sourceInfo.source,
		enabled: true,
	}));

	const extensions = loader.getExtensions().extensions;
	const commandCounts = new Map<string, number>();
	for (const extension of extensions) {
		for (const command of extension.commands.values()) {
			commandCounts.set(command.name, (commandCounts.get(command.name) ?? 0) + 1);
		}
	}
	const seenCommands = new Map<string, number>();
	const usedNames = new Set<string>();
	const commands: DesktopCatalogEntry[] = [];
	for (const extension of extensions) {
		for (const command of extension.commands.values()) {
			const occurrence = (seenCommands.get(command.name) ?? 0) + 1;
			seenCommands.set(command.name, occurrence);
			let id = (commandCounts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;
			if (usedNames.has(id)) {
				let suffix = occurrence;
				do {
					suffix++;
					id = `${command.name}:${suffix}`;
				} while (usedNames.has(id));
			}
			usedNames.add(id);
			commands.push({
				id,
				name: id,
				description: command.description ?? "Extension command",
				source: command.sourceInfo.source,
				enabled: true,
			});
		}
	}

	return {
		skills,
		templates,
		commands,
		extensions: extensions.map((extension) => ({
			id: extension.path,
			name: basename(extension.path),
			description: `${extension.commands.size} command(s), ${extension.tools.size} tool(s)`,
			source: extension.sourceInfo.source,
			enabled: true,
		})),
	};
}

export function runDesktopResource(
	runtime: AgentSessionRuntime,
	kind: DesktopResourceKind,
	id: string,
	handlers: { onCommandError?: (error: unknown) => void; onCommandComplete?: () => void } = {},
): { insertedText?: string; started?: boolean } {
	const catalog = listDesktopResources(runtime);
	if (kind === "skill") {
		const item = catalog.skills.find((entry) => entry.id === id);
		if (!item) throw new Error("Skill was not found in the active Pi session");
		return { insertedText: `/skill:${item.name} ` };
	}
	if (kind === "template") {
		const item = catalog.templates.find((entry) => entry.id === id);
		if (!item) throw new Error("Prompt template was not found in the active Pi session");
		return { insertedText: `/${item.name} ` };
	}
	if (kind === "command") {
		const item = catalog.commands.find((entry) => entry.id === id);
		if (!item) throw new Error("Extension command was not found in the active Pi session");
		void Promise.resolve()
			.then(() => runtime.session.prompt(`/${item.id}`))
			.then(
				() => handlers.onCommandComplete?.(),
				(error: unknown) => handlers.onCommandError?.(error),
			);
		return { started: true };
	}
	throw new Error("An extension is a collection of tools and UI adapters; select one of its commands to run it");
}
