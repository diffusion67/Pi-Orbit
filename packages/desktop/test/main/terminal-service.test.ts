import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TerminalService, TerminalServiceError } from "../../src/main/terminal-service.ts";

// Service tests inject FakePty; real native PTYs are exercised by installed-app smoke tests.
vi.mock("node-pty", () => ({
	spawn: () => {
		throw new Error("TerminalService tests must inject a PTY spawner");
	},
}));

class FakePty {
	readonly writes: string[] = [];
	readonly sizes: Array<{ cols: number; rows: number }> = [];
	readonly kills: number[] = [];
	private readonly dataListeners = new Set<(text: string) => void>();
	private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

	onData(listener: (text: string) => void) {
		this.dataListeners.add(listener);
		return { dispose: () => this.dataListeners.delete(listener) };
	}

	onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
		this.exitListeners.add(listener);
		return { dispose: () => this.exitListeners.delete(listener) };
	}

	write(text: string): void {
		this.writes.push(text);
	}
	resize(cols: number, rows: number): void {
		this.sizes.push({ cols, rows });
	}
	kill(): void {
		this.kills.push(1);
		this.emitExit({ exitCode: 0 });
	}
	emitData(text: string): void {
		for (const listener of this.dataListeners) listener(text);
	}
	emitExit(event: { exitCode: number; signal?: number }): void {
		for (const listener of this.exitListeners) listener(event);
	}
}

describe("TerminalService", () => {
	it.skipIf(process.platform === "win32")("starts a POSIX sh alias whose executable is dash", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-orbit-dash-"));
		const executable = join(cwd, "dash");
		const shell = join(cwd, "sh");
		const spawn = vi.fn(() => new FakePty());
		const service = new TerminalService({
			spawn,
			onOutput: () => undefined,
			platform: "linux",
			environment: { SHELL: shell },
		});
		try {
			await writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });
			await symlink(executable, shell);
			await service.start(cwd);
			expect(spawn).toHaveBeenCalledWith(await realpath(executable), ["-i"], expect.any(Object));
		} finally {
			service.closeAll();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("uses the canonical project directory when started through a directory alias", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-terminal-"));
		const alias = `${directory}-alias`;
		const spawn = vi.fn(() => new FakePty());
		const service = new TerminalService({ spawn, onOutput: () => undefined, platform: "win32" });
		try {
			await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
			const canonicalCwd = await realpath(directory);
			const handle = await service.start(alias);
			expect(handle.cwd).toBe(canonicalCwd);
			expect(spawn).toHaveBeenCalledWith(expect.any(String), ["/Q"], expect.objectContaining({ cwd: canonicalCwd }));
		} finally {
			service.closeAll();
			await rm(alias, { recursive: true, force: true });
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		{ SystemRoot: "D:\\Windows", expected: "D:\\Windows\\System32\\cmd.exe" },
		{ SystemRoot: "", expected: "C:\\Windows\\System32\\cmd.exe" },
	])("resolves the Windows shell independently of the host: $expected", async ({ SystemRoot, expected }) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-orbit-terminal-"));
		const spawn = vi.fn(() => new FakePty());
		const service = new TerminalService({
			spawn,
			onOutput: () => undefined,
			platform: "win32",
			environment: { SystemRoot },
		});
		try {
			await service.start(cwd);
			expect(spawn).toHaveBeenCalledWith(expected, ["/Q"], expect.any(Object));
		} finally {
			service.closeAll();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("starts an OS shell in the project directory and forwards PTY input, size, output, and exit", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-orbit-terminal-"));
		const pty = new FakePty();
		const output = vi.fn();
		const exited = vi.fn();
		const spawned = vi.fn((_file: string, _args: string[], _options: unknown) => pty);
		const service = new TerminalService({
			spawn: spawned,
			onOutput: output,
			onExit: exited,
			platform: "win32",
			environment: { SystemRoot: "C:\\Windows" },
		});
		try {
			const canonicalCwd = await realpath(cwd);
			const handle = await service.start(cwd);
			expect(handle).toMatchObject({ cwd: canonicalCwd, state: "running" });
			expect(spawned).toHaveBeenCalledWith(
				"C:\\Windows\\System32\\cmd.exe",
				["/Q"],
				expect.objectContaining({ cwd: canonicalCwd, cols: 96, rows: 28, name: "xterm-256color" }),
			);
			service.input(handle.id, "echo ready\r");
			service.resize(handle.id, 120, 38);
			pty.emitData("ready\r\n");
			expect(pty.writes).toEqual(["echo ready\r"]);
			expect(pty.sizes).toEqual([{ cols: 120, rows: 38 }]);
			expect(output).toHaveBeenCalledWith(handle.id, "ready\r\n");
			pty.emitExit({ exitCode: 7, signal: 1 });
			expect(exited).toHaveBeenCalledWith(handle.id, { exitCode: 7, signal: 1 });
			expect(() => service.input(handle.id, "after exit")).toThrowError(TerminalServiceError);
		} finally {
			service.closeAll();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("allows fixed terminal programs but rejects shell text and arguments", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-orbit-terminal-"));
		const pty = new FakePty();
		const spawn = vi.fn((_file: string, _args: string[], _options: unknown) => pty);
		const service = new TerminalService({
			spawn,
			onOutput: () => undefined,
			platform: "win32",
			environment: { SystemRoot: "C:\\Windows" },
		});
		try {
			await expect(service.start(cwd, "vim; whoami")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
			await expect(service.start(cwd, "vim notes.txt")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
			expect(spawn).not.toHaveBeenCalled();
			const handle = await service.start(cwd, "vim");
			expect(spawn).toHaveBeenCalledWith("C:\\Windows\\System32\\cmd.exe", ["/Q", "/C", "vim"], expect.any(Object));
			service.stop(handle.id);
			expect(pty.kills).toHaveLength(1);
		} finally {
			service.closeAll();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("validates directories, terminal ids, input size, and dimensions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-orbit-terminal-"));
		const pty = new FakePty();
		const service = new TerminalService({
			spawn: () => pty,
			onOutput: () => undefined,
			platform: "win32",
			environment: { SystemRoot: "C:\\Windows" },
		});
		try {
			await expect(service.start(join(directory, "missing"))).rejects.toMatchObject({ code: "INVALID_CWD" });
			const handle = await service.start(directory);
			service.input(handle.id, "");
			await expect(Promise.resolve().then(() => service.input(handle.id, "x".repeat(65_537)))).rejects.toMatchObject(
				{ code: "INVALID_INPUT" },
			);
			await expect(Promise.resolve().then(() => service.resize(handle.id, 1, 20))).rejects.toMatchObject({
				code: "INVALID_SIZE",
			});
			await expect(Promise.resolve().then(() => service.resize(handle.id, 80, 301))).rejects.toMatchObject({
				code: "INVALID_SIZE",
			});
			expect(service.stop("unknown-terminal")).toBe(false);
		} finally {
			service.closeAll();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("closes every active PTY when the application shuts down", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-orbit-terminal-"));
		const terminals = [new FakePty(), new FakePty()];
		let index = 0;
		const service = new TerminalService({
			spawn: () => terminals[index++],
			onOutput: () => undefined,
			platform: "win32",
			environment: { SystemRoot: "C:\\Windows" },
		});
		try {
			const first = await service.start(cwd);
			const second = await service.start(cwd);
			service.closeAll();
			expect(terminals.map((terminal) => terminal.kills.length)).toEqual([1, 1]);
			expect(() => service.resize(first.id, 80, 24)).toThrowError(TerminalServiceError);
			expect(() => service.input(second.id, "x")).toThrowError(TerminalServiceError);
		} finally {
			service.closeAll();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
