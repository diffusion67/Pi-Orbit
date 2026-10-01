import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { DesktopRole } from "../shared/desktop-types.ts";

type Frontmatter = Record<string, unknown>;

function parseRole(content: string, id: string, scope: DesktopRole["scope"]): DesktopRole | undefined {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return undefined;
	const end = normalized.indexOf("\n---\n", 4);
	if (end < 0) return undefined;
	const metadata = parse(normalized.slice(4, end)) as unknown;
	if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
	const frontmatter = metadata as Frontmatter;
	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined;
	const tools = Array.isArray(frontmatter.tools)
		? frontmatter.tools.filter((tool): tool is string => typeof tool === "string")
		: typeof frontmatter.tools === "string"
			? frontmatter.tools
					.split(",")
					.map((tool) => tool.trim())
					.filter(Boolean)
			: [];
	return {
		id,
		name: frontmatter.name,
		description: frontmatter.description,
		model: typeof frontmatter.model === "string" ? frontmatter.model : "",
		tools,
		scope,
		systemPrompt: normalized.slice(end + 5).trim(),
	};
}

function roleFilename(role: DesktopRole): string {
	const existing = role.id.match(/^(?:user|project):([a-z0-9][a-z0-9_-]{0,127})$/);
	if (existing) return `${existing[1]}.md`;
	const slug = role.name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) throw new TypeError("Role name needs a Latin letter or number for its filename");
	return `${slug.slice(0, 128)}.md`;
}

export class RoleStore {
	private readonly userDirectory: string;

	constructor(agentDirectory: string) {
		this.userDirectory = join(agentDirectory, "agents");
	}

	private directory(scope: DesktopRole["scope"], projectPath: string): string {
		return scope === "user" ? this.userDirectory : join(projectPath, ".pi", "agents");
	}

	async list(projectPath: string): Promise<DesktopRole[]> {
		const roles: DesktopRole[] = [];
		for (const scope of ["user", "project"] as const) {
			const directory = this.directory(scope, projectPath);
			let entries: Dirent[];
			try {
				entries = await readdir(directory, { withFileTypes: true });
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
				throw error;
			}
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
				const id = `${scope}:${entry.name.slice(0, -3)}`;
				const role = parseRole(await readFile(join(directory, entry.name), "utf8"), id, scope);
				if (role) roles.push(role);
			}
		}
		return roles;
	}

	async projectRolePaths(projectPath: string): Promise<string[]> {
		return (await this.list(projectPath))
			.filter((role) => role.scope === "project")
			.map((role) => join(projectPath, ".pi", "agents", `${role.id.slice("project:".length)}.md`));
	}

	async save(role: DesktopRole, projectPath: string): Promise<DesktopRole> {
		const directory = this.directory(role.scope, projectPath);
		const filename = roleFilename(role);
		const id = `${role.scope}:${filename.slice(0, -3)}`;
		await mkdir(directory, { recursive: true });
		const file = join(directory, filename);
		let original: Frontmatter = {};
		try {
			const previous = await readFile(file, "utf8");
			const end = previous.replace(/\r\n/g, "\n").indexOf("\n---\n", 4);
			if (previous.startsWith("---\n") && end >= 0) {
				const parsed = parse(previous.slice(4, end)) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) original = parsed as Frontmatter;
			}
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
		}
		const frontmatter = {
			...original,
			name: role.name,
			description: role.description,
			...(role.model ? { model: role.model } : {}),
			tools: role.tools,
		};
		if (!role.model) delete frontmatter.model;
		const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`);
		await writeFile(temporary, `---\n${stringify(frontmatter)}---\n${role.systemPrompt.trim()}\n`, { mode: 0o600 });
		await rename(temporary, file);
		return { ...role, id };
	}
}
