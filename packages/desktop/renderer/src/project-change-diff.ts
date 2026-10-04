export type ProjectDiffLine = {
	kind: "meta" | "hunk" | "context" | "added" | "deleted";
	oldLine: number | null;
	newLine: number | null;
	text: string;
};

export function parseProjectDiff(diff: string): ProjectDiffLine[] {
	let oldLine = 0;
	let newLine = 0;
	return diff.replace(/\r\n/g, "\n").split("\n").map((text) => {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			return { kind: "hunk", oldLine: null, newLine: null, text };
		}
		if (text.startsWith("+") && !text.startsWith("+++")) return { kind: "added", oldLine: null, newLine: newLine++, text };
		if (text.startsWith("-") && !text.startsWith("---")) return { kind: "deleted", oldLine: oldLine++, newLine: null, text };
		if (text.startsWith(" ")) return { kind: "context", oldLine: oldLine++, newLine: newLine++, text };
		return { kind: "meta", oldLine: null, newLine: null, text };
	});
}

export function isBinaryProjectDiff(diff: string): boolean {
	return /^Binary files? .* (?:differ|has changed)\.?$/im.test(diff) || /^GIT binary patch$/m.test(diff);
}
