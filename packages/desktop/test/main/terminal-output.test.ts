import { describe, expect, it } from "vitest";
import { appendTerminalOutput, terminalOutputDelta } from "../../src/shared/terminal-output.ts";

describe("bounded terminal output", () => {
	it("retains only the newest million characters and tracks the dropped prefix", () => {
		const state = appendTerminalOutput({ output: "a".repeat(999_999), outputOffset: 0 }, "bc");
		expect(state.output.length).toBe(1_000_000);
		expect(state.outputOffset).toBe(1);
		expect(state.output.endsWith("bc")).toBe(true);
		const next = appendTerminalOutput(state, "def");
		expect(next.output.length).toBe(1_000_000);
		expect(next.outputOffset).toBe(4);
	});
	it("writes only new characters when a full buffer rolls forward", () => {
		const next = appendTerminalOutput({ output: "a".repeat(1_000_000), outputOffset: 20 }, "new");
		expect(terminalOutputDelta(next, 1_000_020)).toEqual({ reset: false, text: "new", cursor: 1_000_023 });
		expect(terminalOutputDelta(next, 1_000_023)).toEqual({ reset: false, text: "", cursor: 1_000_023 });
	});
	it("resynchronizes an omitted prefix or truncated snapshot without replaying an old screen", () => {
		expect(terminalOutputDelta({ output: "tail", outputOffset: 20 }, 0)).toEqual({
			reset: true,
			text: "tail",
			cursor: 24,
		});
		expect(terminalOutputDelta({ output: "short", outputOffset: 0 }, 100)).toEqual({
			reset: true,
			text: "short",
			cursor: 5,
		});
	});
	it("does not retain half of a Unicode surrogate pair at the truncation boundary", () => {
		const next = appendTerminalOutput({ output: `\u{1f600}${"a".repeat(999_998)}` }, "b");
		expect(next.outputOffset).toBe(2);
		expect(next.output).toBe(`${"a".repeat(999_998)}b`);
		expect(terminalOutputDelta({ output: "\u{1f600}x", outputOffset: 7 }, 9).text).toBe("x");
	});
	it("does not lose or replay repeated output when the retained buffer text is unchanged", () => {
		let state = { output: "x".repeat(1_000_000), outputOffset: 0 };
		let cursor = state.output.length;
		let written = "";
		for (let index = 0; index < 10; index++) {
			state = appendTerminalOutput(state, "xxxxx");
			const update = terminalOutputDelta(state, cursor);
			expect(update.reset).toBe(false);
			written += update.text;
			cursor = update.cursor;
		}
		expect(written).toBe("x".repeat(50));
	});
});
