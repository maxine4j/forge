import { expect, test } from "vitest";

import { parseTicketPlan, renderTicketPlan } from "./ticket-plan-format.ts";

const plan = `# Title
## Goals
Goal
## Scope
Scope
## Decisions
Decisions
## Acceptance criteria
Criteria
## Tests
Tests
## Ordered subtasks
### 1. First
- Files: a.ts
- Dependencies: None
- Expected changes: Change
  More detail
- Exclusions: None
- Completion criteria: Done
### 2. Second
- Files: b.ts
- Dependencies: 1
- Expected changes: Change
- Exclusions: None
- Completion criteria: Done`;

test("parses and renders independently addressable subtasks", () => {
	const parsed = parseTicketPlan(plan);
	expect(parsed?.subtasks[1]?.dependencies).toBe("1");
	expect(parsed?.subtasks[0]?.expectedChanges).toBe("Change\n  More detail");
	expect(parseTicketPlan(renderTicketPlan(parsed!))).toEqual(parsed);
});

test("rejects malformed and oversized plans while ignoring fenced headings", () => {
	expect(parseTicketPlan(plan.replace("### 2.", "### 3."))).toBeUndefined();
	expect(parseTicketPlan(plan.replace("- Files: a.ts", "- Files: "))).toBeUndefined();
	expect(parseTicketPlan(plan.replace("- Files: a.ts", "- Files: a.ts\n- Files: duplicate"))).toBeUndefined();
	expect(parseTicketPlan(plan.replace("## Tests\nTests", "## Tests\n "))).toBeUndefined();
	expect(parseTicketPlan(plan.replace("## Scope", "## Decisions"))).toBeUndefined();
	expect(parseTicketPlan(plan.replace("### 2. Second", "Unexpected\n### 2. Second"))).toBeUndefined();
	expect(parseTicketPlan(plan.replace("## Goals", "Preamble\n## Goals"))).toBeUndefined();
	expect(parseTicketPlan(plan.replaceAll("\n", "\r\n"))).toEqual(parseTicketPlan(plan));
	expect(parseTicketPlan(plan + "\n" + "x".repeat(32000))).toBeUndefined();
	expect(parseTicketPlan(plan.replace("\nGoal\n", "\nGoal\n```\n## Scope\n```\n"))).toBeDefined();
	const fenced = plan.replace(
		"- Expected changes: Change",
		"- Expected changes: Change\n  ```\n  ### 99. Example\n  - Files: example\n  ```",
	);
	expect(parseTicketPlan(renderTicketPlan(parseTicketPlan(fenced)!))).toEqual(parseTicketPlan(fenced));
});
