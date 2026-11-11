import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const threads = new Map();
let sequence = 0;
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method, params) => write({ method, params });
createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (!message.method) return;
	const { id, method, params } = message;
	if (method === "initialized") return;
	let result = {};
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
			tokenUsage: { total: breakdown(thread.turns.length), last: breakdown(1), modelContextWindow: 128000 },
		};
		notify("thread/tokenUsage/updated", usage);
		notify("thread/tokenUsage/updated", usage);
		notify("item/agentMessage/delta", {
			threadId: thread.id,
			turnId: turn.id,
			itemId: `answer-${sequence}`,
			delta: "Working",
		});
		result = { turn };
		const prompt = params.input.map((part) => part.text ?? "").join("\n");
		const planning = params.collaborationMode?.mode === "plan";
		const rebase = prompt.startsWith("Rebase this branch");
		if (planning || rebase || prompt.startsWith("Implement the approved plan")) {
			if (planning) {
				if (thread.turns.length > 1 && prompt !== "Include filtering")
					throw new Error("Planner feedback must arrive verbatim");
				const item = {
					id: `plan-${sequence}`,
					type: "plan",
					text:
						"## Search plan\n\n- Implement search with filtering.\n\n" + "Acceptance detail. ".repeat(500),
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
				else git("commit", "--allow-empty", "-m", `Controlled implementation ${sequence}`);
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
				text: planning ? "Plan ready." : "Changes committed.",
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
