import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, win32 } from "node:path";
import type { IPtyForkOptions, IWindowsPtyForkOptions } from "node-pty";
import * as nodePty from "node-pty";

const allowedPrograms = new Set(["htop", "less", "more", "nano", "nvim", "top", "vi", "vim"]);
const maxInputLength = 65_536;

export type TerminalState = "running" | "exited";
export type TerminalHandle = {
	readonly id: string;
	readonly cwd: string;
	readonly command?: string;
	readonly state: TerminalState;
};

type Disposable = { dispose(): void };
type PtyExit = { exitCode: number; signal?: number };
type TerminalPty = {
	onData(listener: (data: string) => void): Disposable;
	onExit(listener: (event: PtyExit) => void): Disposable;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
};
type PtyOptions = IPtyForkOptions | IWindowsPtyForkOptions;
type PtySpawner = (file: string, args: string[], options: PtyOptions) => TerminalPty;

type RunningTerminal = {
	readonly handle: TerminalHandle;
	readonly pty: TerminalPty;
	readonly dataSubscription: Disposable;
	readonly exitSubscription: Disposable;
};

export class TerminalServiceError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "TerminalServiceError";
		this.code = code;
	}
}

/** Owns the application's PTYs; renderer requests can select only an interactive shell or a fixed program. */
export class TerminalService {
	private readonly terminals = new Map<string, RunningTerminal>();
	private readonly spawnPty: PtySpawner;
	private readonly onOutput: (terminalId: string, text: string) => void;
	private readonly onExit: (terminalId: string, event: PtyExit) => void;
	private readonly platform: NodeJS.Platform;
	private readonly environment: NodeJS.ProcessEnv;

	constructor(options: {
		spawn?: PtySpawner;
		onOutput: (terminalId: string, text: string) => void;
		onExit?: (terminalId: string, event: PtyExit) => void;
		platform?: NodeJS.Platform;
		environment?: NodeJS.ProcessEnv;
	}) {
		this.spawnPty = options.spawn ?? nodePty.spawn;
		this.onOutput = options.onOutput;
		this.onExit = options.onExit ?? (() => undefined);
		this.platform = options.platform ?? process.platform;
		this.environment = options.environment ?? process.env;
	}

	async start(cwd: string, command?: string): Promise<TerminalHandle> {
		if (typeof cwd !== "string" || cwd.trim().length === 0) {
			throw new TerminalServiceError("INVALID_CWD", "A project working directory is required");
		}
		if (command !== undefined && (typeof command !== "string" || !allowedPrograms.has(command))) {
			throw new TerminalServiceError(
				"COMMAND_NOT_ALLOWED",
				"Choose an interactive shell or a supported terminal program",
			);
		}
		let canonical: string;
		try {
			canonical = await realpath(cwd);
			if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new TerminalServiceError("INVALID_CWD", "The project working directory is unavailable");
		}

		const shell = await this.resolveShell();
		const id = randomUUID();
		const args = command === undefined ? shell.interactiveArgs : shell.commandArgs(command);
		let terminal: TerminalPty;
		try {
			terminal = this.spawnPty(shell.file, args, {
				name: "xterm-256color",
				cols: 96,
				rows: 28,
				cwd: canonical,
				env: { ...this.environment, TERM: "xterm-256color" },
			});
		} catch (error) {
			throw new TerminalServiceError(
				"PTY_START_FAILED",
				error instanceof Error ? error.message : "The terminal could not be started",
			);
		}

		const handle: TerminalHandle = {
			id,
			cwd: canonical,
			...(command === undefined ? {} : { command }),
			state: "running",
		};
		const dataSubscription = terminal.onData((text) => {
			if (this.terminals.get(id)?.pty !== terminal) return;
			try {
				this.onOutput(id, text);
			} catch {
				/* A renderer disconnect must not break the PTY process. */
			}
		});
		const exitSubscription = terminal.onExit((event) => {
			const current = this.terminals.get(id);
			if (current?.pty !== terminal) return;
			this.terminals.delete(id);
			current.dataSubscription.dispose();
			current.exitSubscription.dispose();
			try {
				this.onExit(id, event);
			} catch {
				/* Exit reporting is best effort during shutdown. */
			}
		});
		this.terminals.set(id, { handle, pty: terminal, dataSubscription, exitSubscription });
		return handle;
	}

	input(terminalId: string, text: string): void {
		if (typeof text !== "string" || text.length > maxInputLength) {
			throw new TerminalServiceError("INVALID_INPUT", "Terminal input must be text under 64 KiB");
		}
		this.getTerminal(terminalId).pty.write(text);
	}

	resize(terminalId: string, cols: number, rows: number): void {
		if (
			!Number.isSafeInteger(cols) ||
			cols < 2 ||
			cols > 500 ||
			!Number.isSafeInteger(rows) ||
			rows < 1 ||
			rows > 300
		) {
			throw new TerminalServiceError("INVALID_SIZE", "Terminal size must be between 2–500 columns and 1–300 rows");
		}
		this.getTerminal(terminalId).pty.resize(cols, rows);
	}

	stop(terminalId: string): boolean {
		const terminal = this.terminals.get(terminalId);
		if (terminal === undefined) return false;
		terminal.pty.kill();
		return true;
	}

	closeAll(): void {
		for (const [id, terminal] of this.terminals) {
			this.terminals.delete(id);
			terminal.dataSubscription.dispose();
			terminal.exitSubscription.dispose();
			try {
				terminal.pty.kill();
			} catch {
				/* The child may already have exited. */
			}
		}
	}

	private getTerminal(id: string): RunningTerminal {
		const terminal = this.terminals.get(id);
		if (terminal === undefined)
			throw new TerminalServiceError("TERMINAL_NOT_RUNNING", "This terminal is no longer running");
		return terminal;
	}

	private async resolveShell(): Promise<{
		file: string;
		interactiveArgs: string[];
		commandArgs: (command: string) => string[];
	}> {
		if (this.platform === "win32") {
			const windowsRoot = this.environment.SystemRoot || "C:\\Windows";
			const file = win32.join(windowsRoot, "System32", "cmd.exe");
			return { file, interactiveArgs: ["/Q"], commandArgs: (command) => ["/Q", "/C", command] };
		}

		const userShell = this.environment.SHELL;
		const userShellName = userShell && isAbsolute(userShell) ? basename(userShell) : "";
		const candidates =
			userShellName === "bash" || userShellName === "zsh" || userShellName === "sh" || userShellName === "fish"
				? [userShell]
				: this.platform === "darwin"
					? ["/bin/zsh", "/bin/bash", "/bin/sh"]
					: ["/bin/bash", "/bin/sh"];
		for (const file of candidates) {
			if (!file) continue;
			try {
				const canonical = await realpath(file);
				await access(canonical, constants.X_OK);
				const name = basename(canonical);
				if (name !== "bash" && name !== "zsh" && name !== "sh" && name !== "fish") continue;
				return { file: canonical, interactiveArgs: ["-i"], commandArgs: (command) => ["-ic", command] };
			} catch {
				// Try the next known system shell.
			}
		}
		throw new TerminalServiceError("SHELL_UNAVAILABLE", "No supported interactive shell is installed");
	}
}
