import { expect, test } from "vitest";

import { splitLines } from "./commit-view.tsx";

test("split replacements stay aligned across newline markers and unequal blocks", () => {
	const removed = { kind: "deletion" as const, text: "old", old: 1 };
	const added = { kind: "addition" as const, text: "new", new: 1 };
	const extra = { kind: "addition" as const, text: "extra", new: 2 };
	const marker = { kind: "marker" as const, text: "\\ No newline at end of file" };
	const context = { kind: "context" as const, text: "after", old: 2, new: 3 };
	expect(splitLines([removed, marker, added, extra, context])).toEqual([
		[removed, added],
		[undefined, extra],
		[marker, undefined],
		[context, context],
	]);
	expect(splitLines([added])).toEqual([[undefined, added]]);
	expect(splitLines([removed])).toEqual([[removed, undefined]]);
});
