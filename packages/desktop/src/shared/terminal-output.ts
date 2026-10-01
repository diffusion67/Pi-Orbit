type TerminalOutput = { readonly output: string; readonly outputOffset?: number };

export function appendTerminalOutput(current: TerminalOutput, text: string): { output: string; outputOffset: number } {
	const output = current.output + text;
	let dropped = Math.max(0, output.length - 1_000_000);
	// Keep a complete code point when the retained tail starts inside a surrogate pair.
	if (
		dropped > 0 &&
		output.charCodeAt(dropped) >= 0xdc00 &&
		output.charCodeAt(dropped) <= 0xdfff &&
		output.charCodeAt(dropped - 1) >= 0xd800 &&
		output.charCodeAt(dropped - 1) <= 0xdbff
	)
		dropped++;
	return { output: output.slice(dropped), outputOffset: (current.outputOffset ?? 0) + dropped };
}

export function terminalOutputDelta(
	current: TerminalOutput,
	cursor: number,
): { reset: boolean; text: string; cursor: number } {
	const offset = current.outputOffset ?? 0;
	const end = offset + current.output.length;
	const reset = cursor < offset || cursor > end;
	return { reset, text: current.output.slice(reset ? 0 : cursor - offset), cursor: end };
}
