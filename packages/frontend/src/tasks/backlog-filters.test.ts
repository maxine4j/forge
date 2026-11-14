import { afterEach, expect, test, vi } from "vitest";

import { readBacklogFilters } from "./backlog-filters.ts";

afterEach(() => vi.unstubAllGlobals());

test.each([null, "broken", "null", "[]", "{}", '{"showDone":true}', '{"showDone":1,"showArchived":true}'])(
	"invalid stored filters default off: %s",
	(value) => {
		vi.stubGlobal("localStorage", { getItem: () => value });
		expect(readBacklogFilters()).toEqual({ showDone: false, showArchived: false });
	},
);

test.each([false, true])("valid stored filters preserve independent booleans: %s", (showDone) => {
	vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ showDone, showArchived: !showDone }) });
	expect(readBacklogFilters()).toEqual({ showDone, showArchived: !showDone });
});

test("unavailable storage defaults off", () => {
	vi.stubGlobal("localStorage", {
		getItem: () => {
			throw new Error("Unavailable");
		},
	});
	expect(readBacklogFilters()).toEqual({ showDone: false, showArchived: false });
});
