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
		result = { thread };
	}
	if (method === "thread/resume" || method === "thread/read") {
		const thread = threads.get(params.threadId);
		result = { thread: { ...thread, turns: params.excludeTurns || !params.includeTurns ? [] : thread.turns } };
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
		notify("turn/started", { threadId: thread.id, turn });
		notify("item/agentMessage/delta", {
			threadId: thread.id,
			turnId: turn.id,
			itemId: `answer-${sequence}`,
			delta: "Working",
		});
		result = { turn };
		const prompt = params.input.map((part) => part.text ?? "").join("\n");
		if (prompt.includes("FORGE_RESULT")) {
			const run = Number(/"run":(\d+)/u.exec(prompt)?.[1]);
			let artifact;
			if (prompt.includes("Planning skill"))
				artifact = {
					kind: "plan",
					run,
					text:
						"Plan: implement search with filtering and behavioral tests. Files: search.ts, search.test.ts. Validate with repository checks.\n"
						+ "Acceptance detail. ".repeat(500),
				};
			else {
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
				if (prompt.includes("Rebase the ticket branch")) git("rebase", "--keep-empty", "main");
				else git("commit", "--allow-empty", "-m", `Controlled implementation ${sequence}`);
				artifact = {
					kind: "complete",
					run,
					commit: git("rev-parse", "HEAD"),
					validation: "Controlled fixture: Git committed state verified; no authenticated inference",
				};
			}
			if (prompt.includes("Rebase the ticket branch"))
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
				text: "FORGE_RESULT\n" + JSON.stringify(artifact),
			});
			turn.status = "completed";
			notify("turn/completed", { threadId: thread.id, turn });
		}
	}
	if (method === "turn/interrupt") {
		const thread = threads.get(params.threadId);
		const turn = thread.turns.at(-1);
		turn.status = "interrupted";
		notify("turn/completed", { threadId: thread.id, turn });
	}
	write({ id, result });
});
