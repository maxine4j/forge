import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const threads = new Map();
let sequence = 0;
const approvals = new Map();
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method, params) => write({ method, params });
createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (!message.method) {
		const threadId = approvals.get(message.id);
		if (threadId) {
			approvals.delete(message.id);
			notify("serverRequest/resolved", { threadId, requestId: message.id });
		}
		return;
	}
	const { id, method, params } = message;
	if (method === "initialized") return;
	let result = {};
	if (method === "skills/list")
		result = {
			data: params.cwds.map((cwd) => ({
				cwd,
				errors: [],
				skills: [{ name: "review", description: "Review", path: "/skills/review/SKILL.md", enabled: true }],
			})),
		};
	if (method === "model/list")
		result = {
			data: [
				{
					model: "gpt-5.4",
					displayName: "GPT-5.4",
					isDefault: true,
					supportedReasoningEfforts: [
						{ reasoningEffort: "medium", description: "Medium thinking" },
						{ reasoningEffort: "high", description: "High thinking" },
					],
					defaultReasoningEffort: "medium",
				},
				{
					model: "gpt-5.4-mini",
					displayName: "GPT-5.4 Mini",
					isDefault: false,
					supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low thinking" }],
					defaultReasoningEffort: "low",
				},
			],
			nextCursor: null,
		};
	if (method === "initialize")
		result = {
			userAgent: "controlled-peer",
			codexHome: process.env.CODEX_HOME,
			platformFamily: "unix",
			platformOs: "linux",
		};
	if (method === "thread/start") {
		if (
			params.sandbox !== "danger-full-access"
			|| params.approvalPolicy !== "on-request"
			|| !params.cwd.includes("/worktrees/")
		)
			throw new Error("Unexpected runtime policy");
		const thread = {
			id: `codex-${++sequence}`,
			cwd: params.cwd,
			historyMode: "paginated",
			status: { type: "idle" },
			turns: [],
		};
		threads.set(thread.id, thread);
		result = { thread, model: "gpt-5.4" };
	}
	if (method === "account/rateLimits/read")
		result = {
			rateLimits: { limitId: "codex", planType: "plus", primary: { usedPercent: 40, windowDurationMins: 300 } },
		};
	if (method === "thread/resume" || method === "thread/read") {
		const thread = threads.get(params.threadId);
		if (!thread) {
			write({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } });
			return;
		}
		result = {
			thread: { ...thread, turns: params.excludeTurns || !params.includeTurns ? [] : thread.turns },
			model: "gpt-5.4",
		};
	}
	if (method === "thread/turns/list") {
		const turns = [...threads.get(params.threadId).turns].reverse().slice(0, params.limit);
		result = {
			data: turns.map((turn) => ({ ...turn, items: params.itemsView === "notLoaded" ? [] : turn.items })),
			nextCursor: null,
		};
	}
	if (method === "thread/items/list") {
		const items = threads
			.get(params.threadId)
			.turns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item })))
			.reverse();
		const offset = Number(params.cursor ?? 0);
		const end = offset + params.limit;
		result = { data: items.slice(offset, end), nextCursor: end < items.length ? String(end) : null };
	}
	if (method === "turn/start") {
		const thread = threads.get(params.threadId);
		const prompt = params.input
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const lowHeadroom =
			(prompt.includes("TASK94_LOW") || prompt.startsWith("Implement only subtask 2:"))
			&& !prompt.includes("Recovery instruction:");
		const checkpointMode = prompt.match(/TASK94_CHECKPOINT_(REPORT|UNKNOWN|CHANGED|NO_PROGRESS|AMBIGUOUS)/)?.[1];
		const highContext =
			lowHeadroom || !!checkpointMode || (prompt.includes("TASK67_CONTROLLED") && !prompt.includes("Handover:"));
		const turn = {
			id: `turn-${++sequence}`,
			status: "inProgress",
			items: [{ id: `user-${sequence}`, type: "userMessage", content: params.input }],
		};
		thread.turns.push(turn);
		thread.status = { type: "active" };
		notify("turn/started", { threadId: thread.id, turn });
		const breakdown = (turns) => ({
			inputTokens: 1000 * turns,
			cachedInputTokens: 500 * turns,
			outputTokens: 100 * turns,
			reasoningOutputTokens: 25 * turns,
			totalTokens: 1100 * turns,
		});
		const usage = {
			threadId: thread.id,
			turnId: turn.id,
			tokenUsage: {
				total: breakdown(thread.turns.length),
				last: { ...breakdown(1), totalTokens: highContext ? 8000 : 1100 },
				modelContextWindow:
					checkpointMode === "UNKNOWN" ? null : lowHeadroom ? 9000 : highContext ? 12000 : 128000,
			},
		};
		notify("thread/tokenUsage/updated", usage);
		notify("thread/tokenUsage/updated", usage);
		if (highContext && !lowHeadroom)
			notify("thread/tokenUsage/updated", {
				...usage,
				tokenUsage: { ...usage.tokenUsage, last: breakdown(1) },
			});
		notify("item/agentMessage/delta", {
			threadId: thread.id,
			turnId: turn.id,
			itemId: `answer-${sequence}`,
			delta: "Working",
		});
		result = { turn };
		if (highContext) thread.checkpointScenario = true;
		if (lowHeadroom) thread.lowHeadroom = true;
		if (checkpointMode) thread.checkpointMode = checkpointMode;
		if (prompt.includes("TASK84_CONTROLLED")) thread.completionScenario = true;
		if (prompt.includes("TASK94_INVALID")) thread.invalidScenario = true;
		const finishAfterInvalid = prompt === "$review Finish after invalid";
		if (finishAfterInvalid) thread.invalidScenario = false;
		if (thread.completionScenario && prompt.startsWith("Assess the full assignment")) {
			const item = {
				id: `answer-${sequence}`,
				type: "agentMessage",
				phase: "final_answer",
				text: JSON.stringify({ status: "incomplete", remaining: "Finish integration" }),
			};
			turn.items.push(item);
			turn.status = "completed";
			thread.status = { type: "idle" };
			notify("item/completed", { threadId: thread.id, turnId: turn.id, item });
			notify("turn/completed", { threadId: thread.id, turn });
		}
		const planning = params.collaborationMode?.mode === "plan";
		const rebase = prompt.startsWith("Rebase this branch");
		const rebaseFollowUp = prompt === "Review the rebase" || prompt === "Verify the rebase";
		const incomplete = rebase || prompt === "Review the rebase";
		const invalid =
			thread.invalidScenario
			|| prompt === "Verify the rebase"
			|| (thread.completionScenario && thread.turns.length === 1);
		const firstSubtask = prompt.startsWith("Implement only subtask 1:");
		const finalSubtask = prompt.startsWith("Implement only subtask 2:");
		const planOnly =
			"# Search plan\n\n## Goals\nSearch "
			+ thread.turns.length
			+ "\n\n## Scope\nFiltering\n\n## Decisions\nUse existing search\n\n## Acceptance criteria\nResults are filtered\n\n## Tests\nRun tests";
		if (
			planning
			|| rebase
			|| (!highContext
				&& (prompt.startsWith("Implement the approved plan")
					|| prompt.includes("TASK67_CONTROLLED")
					|| firstSubtask
					|| (finalSubtask && prompt.includes("Recover ordered work"))
					|| rebaseFollowUp
					|| thread.invalidScenario
					|| finishAfterInvalid
					|| (!thread.completionScenario && prompt.startsWith("Assess the full assignment"))
					|| prompt.includes("Recover legacy work")
					|| (thread.completionScenario && prompt === "Finish the integration")
					|| prompt.includes("TASK84_CONTROLLED")))
		) {
			if (planning) {
				if (thread.turns.length > 1 && !prompt.startsWith("Include filtering\n\n"))
					throw new Error("Planner feedback must precede guidance");
				const item = {
					id: `plan-${sequence}`,
					type: "plan",
					text: prompt.includes("TASK94_SINGLE")
						? planOnly
						: `${planOnly}\n\n## Ordered subtasks\n### 1. Search\n- Files: src/search.ts\n- Dependencies: None\n- Expected changes: Implement search revision ${thread.turns.length}\n- Exclusions: None\n- Completion criteria: Search works\n### 2. Filter\n- Files: src/filter.ts\n- Dependencies: 1\n- Expected changes: Add filtering\n- Exclusions: None\n- Completion criteria: Filtering works`,
				};
				turn.items.push(item);
				notify("item/completed", { threadId: thread.id, turnId: turn.id, item });
			} else {
				const git = (...args) =>
					execFileSync(
						"git",
						[
							"-C",
							thread.cwd,
							"-c",
							"user.name=Controlled Agent",
							"-c",
							"user.email=agent@example.com",
							...args,
						],
						{ encoding: "utf8" },
					).trim();
				if (rebase) git("rebase", "--keep-empty", "main");
				else if (
					!prompt.includes("Do not edit files or commit.")
					&& !rebaseFollowUp
					&& !thread.invalidScenario
				) {
					if (thread.completionScenario && thread.turns.length === 1) {
						writeFileSync(join(thread.cwd, "partial.txt"), "Partial implementation\n");
						git("add", "partial.txt");
					}
					git("commit", "--allow-empty", "-m", `Controlled implementation ${sequence}`);
				}
			}
			if (rebase)
				turn.items.push({
					id: `tool-${sequence}`,
					type: "commandExecution",
					command: "pnpm test",
					status: "completed",
					aggregatedOutput: "validation output\n".repeat(100000),
				});
			turn.items.push({
				id: `answer-${sequence}`,
				type: "agentMessage",
				phase: "final_answer",
				text: planning
					? "Plan ready."
					: firstSubtask
						? '{"status":"complete","summary":"Search checkpoint verified"}'
						: invalid
							? "TASK-78 is **not complete**"
							: incomplete
								? '{"status":"incomplete","remaining":"Verify the rebased changes"}'
								: JSON.stringify({ status: "complete" }),
			});
			turn.status = "completed";
			thread.status = { type: "idle" };
			turn.durationMs = 1000;
			notify("turn/completed", { threadId: thread.id, turn });
		}
	}
	if (method === "turn/steer") {
		const thread = threads.get(params.threadId);
		const turn = thread?.turns.at(-1);
		if (!turn || turn.status !== "inProgress" || turn.id !== params.expectedTurnId) {
			write({ id, error: { code: -32602, message: "Active turn mismatch" } });
			return;
		}
		const item = { id: `steer-${++sequence}`, type: "userMessage", content: params.input };
		turn.items.push(item);
		notify("item/completed", { threadId: thread.id, turnId: turn.id, item });
		if (params.input[0].text === "$review the changes") {
			const requestId = `approval-${sequence}`;
			approvals.set(requestId, thread.id);
			write({
				id: requestId,
				method: "item/commandExecution/requestApproval",
				params: {
					threadId: thread.id,
					turnId: turn.id,
					command: "git status",
				},
			});
		}
		if (
			thread.checkpointScenario
			&& params.input[0].text.startsWith("EMERGENCY: You MUST stop all work IMMEDIATELY!")
		) {
			if (thread.checkpointMode === "AMBIGUOUS") {
				write({ id, error: { code: -32603, message: "Controlled delivery failure" } });
				return;
			}
			if (thread.checkpointMode !== "NO_PROGRESS")
				execFileSync("git", [
					"-C",
					thread.cwd,
					"-c",
					"user.name=Controlled Agent",
					"-c",
					"user.email=agent@example.com",
					"commit",
					"--allow-empty",
					"-m",
					"Controlled checkpoint",
				]);
			const answer = {
				id: `handoff-${sequence}`,
				type: "agentMessage",
				phase: "final_answer",
				text: JSON.stringify({ status: "handoff", handover: "Finish controlled work" }),
			};
			if (!thread.lowHeadroom && (!thread.checkpointMode || thread.checkpointMode === "NO_PROGRESS")) {
				turn.items.push(answer);
				notify("item/completed", { threadId: thread.id, turnId: turn.id, item: answer });
			}
			turn.status = "completed";
			thread.status = { type: "idle" };
			notify("turn/completed", { threadId: thread.id, turn });
		}
		result = { turnId: turn.id };
	}
	if (method === "turn/interrupt") {
		const thread = threads.get(params.threadId);
		const turn = thread.turns.at(-1);
		turn.status = "interrupted";
		thread.status = { type: "idle" };
		notify("turn/completed", { threadId: thread.id, turn });
	}
	write({ id, result });
});
