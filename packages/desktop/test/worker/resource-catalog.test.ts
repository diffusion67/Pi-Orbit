import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { isWorkerRequest } from "../../src/shared/worker-protocol.ts";
import { listDesktopResources, runDesktopResource } from "../../src/worker/resource-catalog.ts";

const sourceInfo = {
	source: "project",
	path: "/repo/resource.md",
	scope: "project" as const,
	origin: "top-level" as const,
};

function makeRuntime(duplicateCommand = false): AgentSessionRuntime {
	const command = { name: "inspect", description: "Inspect the project", sourceInfo, handler: vi.fn() };
	const extension = {
		path: "/repo/.pi/extensions/review.ts",
		resolvedPath: "/repo/.pi/extensions/review.ts",
		sourceInfo,
		commands: new Map([["inspect", command]]),
		tools: new Map([["review", {}]]),
	};
	const extensions = duplicateCommand
		? [
				extension,
				{
					...extension,
					path: "/repo/.pi/extensions/other.ts",
					resolvedPath: "/repo/.pi/extensions/other.ts",
					commands: new Map([["inspect", { ...command, description: "Inspect again" }]]),
				},
			]
		: [extension];
	const resources = {
		getSkills: () => ({
			skills: [{ name: "review-pr", description: "Review a pull request", sourceInfo }],
			diagnostics: [],
		}),
		getPrompts: () => ({
			prompts: [{ name: "summarize", description: "Summarize changes", sourceInfo }],
			diagnostics: [],
		}),
		getExtensions: () => ({ extensions, errors: [], runtime: {} }),
	};
	return {
		services: { resourceLoader: resources },
		session: { prompt: vi.fn(async () => undefined) },
	} as unknown as AgentSessionRuntime;
}

describe("desktop resource catalog", () => {
	it("accepts only the named resource operations with validated arguments", () => {
		expect(isWorkerRequest({ id: "list", type: "resources.list", payload: {} })).toBe(true);
		expect(isWorkerRequest({ id: "run", type: "resources.run", payload: { kind: "skill", id: "review" } })).toBe(
			true,
		);
		expect(
			isWorkerRequest({ id: "run", type: "resources.run", payload: { kind: "skill", id: "review", path: "C:/" } }),
		).toBe(false);
	});

	it("lists loaded skills, prompt templates, extension commands, and extensions", () => {
		const catalog = listDesktopResources(makeRuntime());
		expect(catalog.skills).toEqual([
			{ id: "review-pr", name: "review-pr", description: "Review a pull request", source: "project", enabled: true },
		]);
		expect(catalog.templates[0]?.id).toBe("summarize");
		expect(catalog.commands[0]).toMatchObject({ id: "inspect", description: "Inspect the project", enabled: true });
		expect(catalog.extensions[0]).toMatchObject({ name: "review.ts", description: "1 command(s), 1 tool(s)" });
	});

	it("returns Pi slash syntax for skills and templates and dispatches extension commands through Pi", async () => {
		const runtime = makeRuntime();
		expect(runDesktopResource(runtime, "skill", "review-pr")).toEqual({ insertedText: "/skill:review-pr " });
		expect(runDesktopResource(runtime, "template", "summarize")).toEqual({ insertedText: "/summarize " });
		expect(runDesktopResource(runtime, "command", "inspect")).toEqual({ started: true });
		await Promise.resolve();
		expect(runtime.session.prompt).toHaveBeenCalledWith("/inspect");
	});

	it("returns before extension commands settle and reports failures through the supplied handler", async () => {
		const runtime = makeRuntime();
		const prompt = vi.spyOn(runtime.session, "prompt").mockRejectedValue(new Error("extension failed"));
		const onCommandError = vi.fn();
		expect(runDesktopResource(runtime, "command", "inspect", { onCommandError })).toEqual({ started: true });
		expect(prompt).not.toHaveBeenCalled();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(onCommandError).toHaveBeenCalledWith(expect.objectContaining({ message: "extension failed" }));
	});

	it("uses the same collision suffixes as Pi for duplicate extension command names", async () => {
		const runtime = makeRuntime(true);
		const commands = listDesktopResources(runtime).commands;
		expect(commands.map((command) => command.id)).toEqual(["inspect:1", "inspect:2"]);
		runDesktopResource(runtime, "command", "inspect:1");
		await Promise.resolve();
		expect(runtime.session.prompt).toHaveBeenCalledWith("/inspect:1");
	});

	it("rejects unknown entries and avoids treating an extension as a runnable command", async () => {
		const runtime = makeRuntime();
		expect(() => runDesktopResource(runtime, "skill", "missing")).toThrow("Skill was not found");
		expect(() => runDesktopResource(runtime, "extension", "/repo/.pi/extensions/review.ts")).toThrow(
			"select one of its commands",
		);
	});
});
