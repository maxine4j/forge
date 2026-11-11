import { expect, test, vi } from "vitest";

import type { ICodexAgentConnection } from "../accounts/codex-connection.ts";
import { CodexAgentClient } from "./codex-agent-client.ts";

const setup = (tracker?: { track: ReturnType<typeof vi.fn> }) => {
	let notify: (method: string, params: unknown) => void = () => {};
	let request: (id: string | number, method: string, params: unknown) => boolean = () => false;
	let sequence = 0;
	let requestSequence = 0;
	const rpc = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
		if (method === "thread/start")
			return {
				model: "runtime-default",
				thread: {
					id: `codex-${++sequence}`,
					historyMode: "paginated",
					turns: [],
					status: { type: "idle" },
					cwd: (params as { cwd: string }).cwd,
				},
			};
		if (method === "thread/resume")
			return {
				thread: {
					id: "codex-1",
					cwd: "/data/worktrees/one",
					historyMode: "paginated",
					status: { type: "idle" },
					turns: [],
				},
			};
		if (method === "thread/turns/list")
			return {
				data: [
					{
						id: "old",
						status: "completed",
						items: [{ id: "a", type: "agentMessage", text: "Previous answer" }],
					},
				],
				nextCursor: null,
			};
		if (method === "thread/items/list")
			return {
				data: [{ turnId: "old", item: { id: "a", type: "agentMessage", text: "Previous answer" } }],
				nextCursor: null,
			};
		if (method === "turn/start") {
			const { threadId } = params as { threadId: string };
			notify("turn/started", { threadId, turn: { id: "turn-1", status: "inProgress", items: [] } });
			return { turn: { id: "turn-1", status: "inProgress", items: [] } };
		}
		return {};
	});
	const respond = vi.fn();
	const connection: ICodexAgentConnection = {
		initialize: async () => {},
		restart: async () => {},
		close: async () => {},
		request: rpc,
		respond,
		subscribe: (listener) => {
			notify = listener;
			return () => {};
		},
		subscribeRequests: (listener) => {
			request = listener;
			return () => {};
		},
	};
	return {
		client: new CodexAgentClient(
			connection,
			async (path) => path,
			() => `request-${++requestSequence}`,
			tracker,
		),
		rpc,
		respond,
		notify: (method: string, params: unknown) => notify(method, params),
		request: (id: string | number, method: string, params: unknown) => request(id, method, params),
	};
};

test("registers usage attribution and the runtime default model before submitting the turn", async () => {
	const track = vi.fn();
	const { client, rpc } = setup({ track });
	const id = await client.start("/data/worktrees/one");
	const scope = { projectId: "project", ticketId: "FORGE-1", phase: "implementation" } as const;
	await client.send(id, "/data/worktrees/one", "Work", undefined, scope);
	expect(track).toHaveBeenCalledWith(id, scope, "runtime-default");
	expect(track.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[1]!);
});

test("steering uses the pinned active-turn protocol without starting or reviving a turn", async () => {
	const track = vi.fn();
	const { client, rpc, notify } = setup({ track });
	const id = await client.start("/data/worktrees/one");
	await client.send(id, "/data/worktrees/one", "Implement", undefined, {
		projectId: "project",
		ticketId: "FORGE-1",
		phase: "implementation",
	});
	await expect(client.steer(id, "stale", "Feedback")).rejects.toThrow("agent-conflict");
	const before = client.read(id);
	rpc.mockResolvedValueOnce({ turnId: "turn-1" });
	await client.steer(id, "turn-1", "Focus on tests");
	expect(rpc).toHaveBeenLastCalledWith("turn/steer", {
		threadId: id,
		expectedTurnId: "turn-1",
		input: [{ type: "text", text: "Focus on tests", text_elements: [] }],
	});
	expect(client.read(id)).toEqual(before);
	expect(track).toHaveBeenCalledTimes(1);
	rpc.mockImplementationOnce(async () => {
		notify("turn/completed", { threadId: id, turn: { id: "turn-1", status: "completed", items: [] } });
		return { turnId: "turn-1" };
	});
	await client.steer(id, "turn-1", "A racing message");
	expect(client.read(id).status).toBe("completed");
	await expect(client.steer(id, "turn-1", "Too late")).rejects.toThrow("agent-conflict");
	expect(rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
});

test("steering failures are never replayed and do not create activity or change turn identity", async () => {
	const { client, rpc } = setup();
	const id = await client.start("/data/worktrees/one");
	await client.send(id, "/data/worktrees/one", "Implement");
	const before = client.read(id);
	rpc.mockRejectedValueOnce(new Error("Transport lost"));
	await expect(client.steer(id, "turn-1", "Feedback")).rejects.toThrow("agent-unavailable");
	expect(client.read(id)).toEqual(before);
	expect(rpc.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(1);
	rpc.mockResolvedValueOnce({ turnId: "different" });
	await expect(client.steer(id, "turn-1", "Feedback")).rejects.toThrow("agent-conflict");
});

test("native plans have identical browser items while streaming, completed and restored", async () => {
	const { client, rpc, notify } = setup();
	const id = await client.start("/data/worktrees/one");
	await client.send(id, "/data/worktrees/one", "Plan");
	notify("item/started", { threadId: id, turnId: "turn-1", item: { id: "plan", type: "plan", text: "" } });
	notify("item/plan/delta", { threadId: id, turnId: "turn-1", itemId: "plan", delta: "# Proposed plan" });
	const streamed = client.read(id).items;
	expect(streamed).toEqual([{ id: "plan", role: "assistant", kind: "plan", text: "# Proposed plan" }]);
	notify("item/completed", {
		threadId: id,
		turnId: "turn-1",
		item: { id: "plan", type: "plan", text: "# Proposed plan" },
	});
	expect(client.read(id).items).toEqual(streamed);
	rpc.mockImplementationOnce(async () => ({
		thread: { id, historyMode: "paginated", cwd: "/data/worktrees/one", status: { type: "idle" }, turns: [] },
	}));
	rpc.mockResolvedValueOnce({ data: [{ id: "turn-1", status: "completed", items: [] }], nextCursor: null });
	rpc.mockResolvedValueOnce({
		data: [{ turnId: "turn-1", item: { id: "plan", type: "plan", text: "# Proposed plan" } }],
		nextCursor: null,
	});
	expect((await client.resume(id, "/data/worktrees/one")).items).toEqual(streamed);
});

test("planning uses native collaboration mode and captures only a completed plan item from its turn", async () => {
	const { client, rpc, notify } = setup();
	const id = await client.start("/data/worktrees/one");
	const scope = { projectId: "project", ticketId: "FORGE-1", phase: "planning" } as const;
	await client.send(id, "/data/worktrees/one", "Plan this ticket", undefined, scope);
	expect(rpc).toHaveBeenLastCalledWith(
		"turn/start",
		expect.objectContaining({
			collaborationMode: { mode: "plan", settings: { model: "runtime-default", developer_instructions: null } },
		}),
	);
	notify("item/plan/delta", { threadId: id, turnId: "turn-1", itemId: "plan", delta: "Partial" });
	expect(client.read(id).plan).toBeUndefined();
	notify("item/completed", {
		threadId: id,
		turnId: "older",
		item: { id: "previous", type: "plan", text: "Old plan" },
	});
	expect(client.read(id).plan).toBeUndefined();
	notify("item/completed", { threadId: id, turnId: "turn-1", item: { id: "plan", type: "plan", text: "# Plan" } });
	notify("turn/completed", { threadId: id, turn: { id: "turn-1", status: "completed", items: [] } });
	expect(client.read(id).plan).toBe("# Plan");
	await client.send(id, "/data/worktrees/one", "Revise", undefined, scope);
	expect(client.read(id).plan).toBeUndefined();
});

test("discovers runtime models and enabled worktree skills, searches only that worktree", async () => {
	const { client, rpc } = setup();
	rpc.mockResolvedValueOnce({
		data: [{ model: "test-model", displayName: "Test model", isDefault: true }],
		nextCursor: null,
	});
	rpc.mockResolvedValueOnce({
		data: [
			{
				cwd: "/data/worktrees/one",
				skills: [
					{ name: "review", description: "Review changes", path: "/skills/review/SKILL.md", enabled: true },
					{ name: "disabled", description: "Hidden", path: "/skills/disabled", enabled: false },
				],
				errors: [],
			},
		],
	});
	expect(await client.options("/data/worktrees/one")).toEqual({
		models: [{ id: "test-model", name: "Test model", isDefault: true }],
		skills: [{ name: "review", description: "Review changes" }],
	});
	rpc.mockResolvedValueOnce({
		files: [
			{ root: "/data/worktrees/one", path: "src/main.ts" },
			{ root: "/other", path: "secret" },
			{ root: "/data/worktrees/one", path: "../escape" },
		],
	});
	expect(await client.files("/data/worktrees/one", "main")).toEqual(["src/main.ts"]);
	expect(rpc).toHaveBeenLastCalledWith("fuzzyFileSearch", {
		query: "main",
		roots: ["/data/worktrees/one"],
		cancellationToken: null,
	});
});

test.each([
	["ask", "on-request", "user"],
	["approve-for-me", "on-request", "auto_review"],
	["full-access", "never", "user"],
] as const)(
	"applies %s permissions and selected model to the actual turn",
	async (permissions, approvalPolicy, approvalsReviewer) => {
		const { client, rpc } = setup();
		const id = await client.start("/data/worktrees/one");
		await client.send(id, "/data/worktrees/one", "Work", { model: "test-model", permissions });
		expect(rpc).toHaveBeenLastCalledWith(
			"turn/start",
			expect.objectContaining({ model: "test-model", approvalPolicy, approvalsReviewer }),
		);
	},
);

test("tool lifecycle and streamed output preserve structured command and status", async () => {
	const { client, notify } = setup();
	const id = await client.start("/data/worktrees/one");
	notify("item/started", {
		threadId: id,
		item: { id: "cmd", type: "commandExecution", command: "pnpm test", status: "inProgress" },
	});
	notify("item/commandExecution/outputDelta", { threadId: id, itemId: "cmd", delta: "Tests passing" });
	expect(client.read(id).items[0]).toMatchObject({
		title: "pnpm test",
		status: "running",
		text: expect.stringContaining("Tests passing"),
	});
	notify("item/completed", {
		threadId: id,
		item: {
			id: "cmd",
			type: "commandExecution",
			command: "pnpm test",
			status: "completed",
			aggregatedOutput: "Tests passing",
		},
	});
	expect(client.read(id).items[0]).toMatchObject({ title: "pnpm test", status: "completed" });
});

test("an interrupted turn stops unfinished tool animations, including reloaded history", async () => {
	const { client, notify, rpc } = setup();
	const id = await client.start("/data/worktrees/one");
	const item = { id: "cmd", type: "commandExecution", command: "pnpm test", status: "inProgress" };
	notify("item/started", { threadId: id, item });
	notify("turn/completed", { threadId: id, turn: { id: "turn", status: "interrupted", items: [item] } });
	expect(client.read(id).items[0]).toMatchObject({ status: "interrupted" });
	rpc.mockResolvedValueOnce({
		thread: { id, cwd: "/data/worktrees/one", historyMode: "paginated", status: { type: "idle" }, turns: [] },
	});
	rpc.mockResolvedValueOnce({ data: [{ id: "turn", status: "interrupted", items: [item] }], nextCursor: null });
	rpc.mockResolvedValueOnce({ data: [{ turnId: "turn", item }], nextCursor: null });
	expect((await client.resume(id, "/data/worktrees/one")).items[0]).toMatchObject({ status: "interrupted" });
});

test("explicit skills resolve from the worktree catalog and are supplied as structured inputs", async () => {
	const { client, rpc } = setup();
	const id = await client.start("/data/worktrees/one");
	rpc.mockResolvedValueOnce({
		data: [
			{
				cwd: "/data/worktrees/one",
				skills: [{ name: "review", description: "Review", path: "/skills/review/SKILL.md", enabled: true }],
				errors: [],
			},
		],
	});
	await client.send(id, "/data/worktrees/one", "$review changes");
	expect(rpc).toHaveBeenLastCalledWith(
		"turn/start",
		expect.objectContaining({
			input: [
				{ type: "text", text: "$review changes", text_elements: [] },
				{ type: "skill", name: "review", path: "/skills/review/SKILL.md" },
			],
		}),
	);
});

test("model discovery bounds empty paginated responses", async () => {
	const { client, rpc } = setup();
	let page = 0;
	rpc.mockImplementation(async () => {
		if (++page > 5) throw new Error("Unbounded pagination");
		return { data: [], nextCursor: `page-${page}` };
	});
	await expect(client.options("/data/worktrees/one")).rejects.toThrow("agent-unavailable");
	expect(rpc.mock.calls.length).toBeLessThanOrEqual(5);
});

test("connection loss preserves idle and completed chats without inventing active execution", async () => {
	const { client, notify } = setup();
	const idle = await client.start("/data/worktrees/one");
	const completed = await client.start("/data/worktrees/two");
	notify("turn/completed", { threadId: completed, turn: { id: "done", status: "completed", items: [] } });
	notify("connection/lost", {});
	expect(client.read(idle).status).toBe("idle");
	expect(client.read(completed).status).toBe("completed");
});
test("starts independent threads without an inner sandbox, streams items, interrupts, and resumes history", async () => {
	const { client, rpc, notify } = setup();
	const id = await client.start("/data/worktrees/one");
	expect(rpc).toHaveBeenCalledWith(
		"thread/start",
		expect.objectContaining({
			cwd: "/data/worktrees/one",
			sandbox: "danger-full-access",
			approvalPolicy: "on-request",
		}),
	);
	const other = await client.start("/data/worktrees/two");
	await Promise.all([
		client.send(id, "/data/worktrees/one", "Hello"),
		client.send(other, "/data/worktrees/two", "Other"),
	]);
	notify("item/agentMessage/delta", { threadId: id, turnId: "turn-1", itemId: "answer", delta: "Hello back" });
	expect(client.read(id)).toMatchObject({
		status: "running",
		turnId: "turn-1",
		items: [{ id: "answer", text: "Hello back", role: "assistant" }],
	});
	expect(client.read(other).items).toEqual([]);
	await client.interrupt(id, "turn-1");
	expect(rpc).toHaveBeenLastCalledWith("turn/interrupt", { threadId: id, turnId: "turn-1" });
	notify("turn/completed", { threadId: id, turn: { id: "turn-1", status: "interrupted", items: [] } });
	expect(client.read(id).status).toBe("interrupted");
	notify("connection/lost", {});
	expect(client.read(other).status).toBe("uncertain");
	expect(await client.resume(id, "/data/worktrees/one")).toMatchObject({
		status: "completed",
		items: [{ text: "Previous answer" }],
	});
	expect(rpc).toHaveBeenCalledWith(
		"thread/resume",
		expect.objectContaining({
			sandbox: "danger-full-access",
			approvalPolicy: "on-request",
			config: { features: { multi_agent: false } },
		}),
	);
});
test("routes approvals and clarification to the owning thread; stale and cross-thread replies fail", async () => {
	const { client, request, respond, notify } = setup();
	const id = await client.start("/data/worktrees/one");
	const other = await client.start("/data/worktrees/two");
	await client.send(id, "/data/worktrees/one", "Work");
	expect(
		request(42, "item/commandExecution/requestApproval", {
			threadId: id,
			turnId: "turn-1",
			itemId: "cmd",
			command: "pnpm test",
			reason: "Network",
		}),
	).toBe(true);
	expect(client.read(id)).toMatchObject({
		status: "waiting",
		requests: [{ kind: "command", description: "Network\npnpm test" }],
	});
	const requestId = client.read(id).requests[0]!.id;
	expect(() => client.reply(other, { requestId, decision: "accept" })).toThrow();
	client.reply(id, { requestId, decision: "decline" });
	expect(respond).toHaveBeenLastCalledWith(42, { decision: "decline" });
	expect(() => client.reply(id, { requestId, decision: "accept" })).toThrow();
	request("question", "item/tool/requestUserInput", {
		threadId: id,
		turnId: "turn-1",
		itemId: "q",
		questions: [
			{ id: "scope", question: "Which scope?", isSecret: false, options: [{ label: "Small", description: "" }] },
		],
	});
	client.reply(id, { requestId: client.read(id).requests[0]!.id, answers: { scope: "Small" } });
	expect(respond).toHaveBeenLastCalledWith("question", { answers: { scope: { answers: ["Small"] } } });
	request("old", "item/fileChange/requestApproval", {
		threadId: id,
		turnId: "turn-1",
		itemId: "patch",
		reason: "Edit",
	});
	notify("connection/lost", {});
	expect(client.read(id).requests).toEqual([]);
	expect(() => client.reply(id, { requestId: "old", decision: "accept" })).toThrow();
});
test("rejects invalid external responses and bounds live output with a visible truncation flag", async () => {
	const { client, notify, rpc } = setup();
	const id = await client.start("/data/worktrees/one");
	notify("item/agentMessage/delta", { threadId: id, itemId: "big", delta: "x".repeat(40000) });
	expect(client.read(id).items[0]?.text).toHaveLength(32000);
	expect(client.read(id).truncated).toBe(true);
	rpc.mockResolvedValueOnce({ thread: { id: 42 } });
	await expect(client.start("/data/worktrees/two")).rejects.toThrow("agent-unavailable");
});
test("hydrates paginated history and records a second turn even without a started notification", async () => {
	const { client, rpc, notify } = setup();
	const id = await client.start("/data/worktrees/one");
	rpc.mockResolvedValueOnce({
		thread: { id, cwd: "/data/worktrees/one", historyMode: "paginated", turns: [], status: { type: "idle" } },
	});
	rpc.mockResolvedValueOnce({
		data: [
			{ id: "old", status: "completed", items: [{ id: "history", type: "agentMessage", text: "Saved history" }] },
		],
		nextCursor: "older",
	});
	rpc.mockResolvedValueOnce({
		data: [{ turnId: "old", item: { id: "history", type: "agentMessage", text: "Saved history" } }],
		nextCursor: null,
	});
	expect(await client.resume(id, "/data/worktrees/one")).toMatchObject({
		status: "completed",
		truncated: true,
		items: [{ text: "Saved history" }],
	});
	rpc.mockResolvedValueOnce({ turn: { id: "next", status: "inProgress", items: [] } });
	await client.send(id, "/data/worktrees/one", "Next");
	expect(client.read(id)).toMatchObject({ turnId: "next", status: "running" });
	notify("turn/completed", { threadId: id, turn: { id: "next", status: "completed", items: [] } });
	rpc.mockResolvedValueOnce({ turn: { id: "third", status: "inProgress", items: [] } });
	await client.send(id, "/data/worktrees/one", "Third");
	expect(client.read(id).turnId).toBe("third");
});
test("history loads bounded item pages newest first and retains completion after large tool output", async () => {
	const { client, rpc } = setup();
	const id = await client.start("/data/worktrees/one");
	rpc.mockResolvedValueOnce({
		thread: { id, cwd: "/data/worktrees/one", historyMode: "paginated", turns: [], status: { type: "idle" } },
	});
	rpc.mockResolvedValueOnce({
		data: [
			{ id: "done", status: "completed", items: [] },
			{ id: "old", status: "completed", items: [] },
		],
		nextCursor: null,
	});
	rpc.mockResolvedValueOnce({
		data: [{ turnId: "done", item: { id: "result", type: "agentMessage", text: "FORGE_RESULT\ncomplete" } }],
		nextCursor: "older-items",
	});
	rpc.mockResolvedValueOnce({
		data: [
			{
				turnId: "done",
				item: {
					id: "tool",
					type: "commandExecution",
					command: "pnpm test",
					aggregatedOutput: "x".repeat(2 * 1024 * 1024),
					status: "completed",
				},
			},
			{ turnId: "old", item: { id: "user", type: "userMessage", content: [{ type: "text", text: "Work" }] } },
		],
		nextCursor: null,
	});
	const view = await client.resume(id, "/data/worktrees/one");
	expect(view).toMatchObject({ status: "completed", turnId: "done", truncated: true });
	expect(view.items.map((item) => item.id)).toEqual(["user", "tool", "result"]);
	expect(view.items.at(-1)?.text).toBe("FORGE_RESULT\ncomplete");
	expect(view.items[1]?.text).toHaveLength(32000);
	expect(rpc).toHaveBeenCalledWith("thread/turns/list", {
		threadId: id,
		limit: 20,
		sortDirection: "desc",
		itemsView: "notLoaded",
	});
	expect(rpc).toHaveBeenLastCalledWith("thread/items/list", {
		threadId: id,
		limit: 20,
		sortDirection: "desc",
		cursor: "older-items",
	});
});

test("history stops reading older output at the snapshot budget and keeps the newest answer", async () => {
	const { client, rpc } = setup();
	const id = await client.start("/data/worktrees/one");
	rpc.mockResolvedValueOnce({
		thread: { id, cwd: "/data/worktrees/one", historyMode: "paginated", turns: [], status: { type: "idle" } },
	});
	rpc.mockResolvedValueOnce({ data: [{ id: "done", status: "completed", items: [] }], nextCursor: null });
	rpc.mockResolvedValueOnce({
		data: [
			{ turnId: "done", item: { id: "result", type: "agentMessage", text: "Complete" } },
			...Array.from({ length: 10 }, (_, i) => ({
				turnId: "done",
				item: { id: `tool-${i}`, type: "commandExecution", aggregatedOutput: "x".repeat(32000) },
			})),
		],
		nextCursor: "more",
	});
	const view = await client.resume(id, "/data/worktrees/one");
	expect(view.truncated).toBe(true);
	expect(view.items.at(-1)?.text).toBe("Complete");
	expect(view.items.reduce((size, item) => size + item.text.length, 0)).toBeLessThanOrEqual(240000);
	expect(rpc.mock.calls.filter(([method]) => method === "thread/items/list")).toHaveLength(1);
});

test("history rejects repeated item cursors instead of looping indefinitely", async () => {
	const { client, rpc } = setup();
	const id = await client.start("/data/worktrees/one");
	rpc.mockResolvedValueOnce({
		thread: { id, cwd: "/data/worktrees/one", historyMode: "paginated", turns: [], status: { type: "idle" } },
	});
	rpc.mockResolvedValueOnce({ data: [{ id: "done", status: "completed", items: [] }], nextCursor: null });
	rpc.mockResolvedValueOnce({ data: [], nextCursor: "same" });
	rpc.mockResolvedValueOnce({ data: [], nextCursor: "same" });
	await expect(client.resume(id, "/data/worktrees/one")).rejects.toThrow("agent-unavailable");
});

test.each([0, 20])("history bounds pagination even when pages contain %s items", async (count) => {
	const { client, rpc } = setup();
	const id = await client.start("/data/worktrees/one");
	rpc.mockResolvedValueOnce({
		thread: { id, cwd: "/data/worktrees/one", historyMode: "paginated", turns: [], status: { type: "idle" } },
	});
	rpc.mockResolvedValueOnce({ data: [{ id: "done", status: "completed", items: [] }], nextCursor: null });
	let pages = 0;
	rpc.mockImplementation(async () => ({
		data: Array.from({ length: count }, (_, i) => ({
			turnId: "done",
			item: { id: `${pages}-${i}`, type: "agentMessage", text: "Answer" },
		})),
		nextCursor: `page-${++pages}`,
	}));
	const view = await client.resume(id, "/data/worktrees/one");
	expect(view.truncated).toBe(true);
	expect(view.items).toHaveLength(count * 25);
	expect(pages).toBe(25);
});

test.each(["completion", "disconnect"])("item pagination preserves a newer live %s", async (event) => {
	const { client, rpc, notify } = setup();
	const id = await client.start("/data/worktrees/one");
	rpc.mockResolvedValueOnce({
		thread: { id, cwd: "/data/worktrees/one", historyMode: "paginated", turns: [], status: { type: "active" } },
	});
	rpc.mockResolvedValueOnce({ data: [{ id: "old", status: "inProgress", items: [] }], nextCursor: null });
	rpc.mockImplementationOnce(async () => {
		if (event === "completion")
			notify("turn/completed", {
				threadId: id,
				turn: {
					id: "new",
					status: "completed",
					items: [{ id: "live", type: "agentMessage", text: "Newest answer" }],
				},
			});
		else notify("connection/lost", {});
		return {
			data: [{ turnId: "old", item: { id: "history", type: "agentMessage", text: "Older answer" } }],
			nextCursor: null,
		};
	});
	const view = await client.resume(id, "/data/worktrees/one");
	expect(view.status).toBe(event === "completion" ? "completed" : "uncertain");
	if (event === "completion") expect(view.items.at(-1)?.text).toBe("Newest answer");
});

test("terminal Codex errors stop the turn while retryable errors keep it active", async () => {
	const { client, notify } = setup();
	const id = await client.start("/data/worktrees/one");
	await client.send(id, "/data/worktrees/one", "Hello");
	notify("error", { threadId: id, turnId: "turn-1", willRetry: true, error: { message: "Retry" } });
	expect(client.read(id).status).toBe("running");
	notify("error", { threadId: id, turnId: "turn-1", willRetry: false, error: { message: "Signed out" } });
	expect(client.read(id).status).toBe("failed");
});
test("reused Codex callback IDs cannot authorize a replacement request after reconnect", async () => {
	const { client, request, notify } = setup();
	const id = await client.start("/data/worktrees/one");
	await client.send(id, "/data/worktrees/one", "Work");
	request(1, "item/commandExecution/requestApproval", { threadId: id, turnId: "turn-1", command: "First" });
	const oldId = client.read(id).requests[0]!.id;
	notify("connection/lost", {});
	await client.resume(id, "/data/worktrees/one");
	await client.send(id, "/data/worktrees/one", "Continue");
	request(1, "item/commandExecution/requestApproval", { threadId: id, turnId: "turn-1", command: "Replacement" });
	expect(client.read(id).requests[0]!.id).not.toBe(oldId);
	expect(() => client.reply(id, { requestId: oldId, decision: "accept" })).toThrow("agent-conflict");
});
test("externally resolved approval requests disappear and cannot be answered", async () => {
	const { client, request, notify } = setup();
	const id = await client.start("/data/worktrees/one");
	await client.send(id, "/data/worktrees/one", "Work");
	request(10, "item/fileChange/requestApproval", { threadId: id, turnId: "turn-1", reason: "Patch" });
	const requestId = client.read(id).requests[0]!.id;
	notify("serverRequest/resolved", { threadId: id, requestId: 10 });
	expect(client.read(id).requests).toEqual([]);
	expect(() => client.reply(id, { requestId, decision: "accept" })).toThrow("agent-conflict");
});

test.each(["systemError", "notLoaded"])("resume treats %s as uncertain", async (type) => {
	const { client, rpc } = setup();
	const id = await client.start("/data/worktrees/one");
	rpc.mockResolvedValueOnce({
		thread: { id, cwd: "/data/worktrees/one", historyMode: "paginated", status: { type }, turns: [] },
	});
	expect((await client.resume(id, "/data/worktrees/one")).status).toBe("uncertain");
	await expect(client.send(id, "/data/worktrees/one", "Work")).rejects.toThrow("agent-conflict");
});

test.each(["systemError", "notLoaded"])("live %s invalidates approvals until explicit recovery", async (type) => {
	const { client, request, notify } = setup();
	const id = await client.start("/data/worktrees/one");
	await client.send(id, "/data/worktrees/one", "Work");
	request(10, "item/commandExecution/requestApproval", { threadId: id, turnId: "turn-1", command: "pnpm test" });
	const requestId = client.read(id).requests[0]!.id;
	notify("thread/status/changed", { threadId: id, status: { type } });
	notify("thread/status/changed", { threadId: id, status: { type: "idle" } });
	expect(client.read(id)).toMatchObject({ status: "uncertain", requests: [] });
	expect(() => client.reply(id, { requestId, decision: "accept" })).toThrow("agent-conflict");
	await expect(client.send(id, "/data/worktrees/one", "Retry")).rejects.toThrow("agent-conflict");
});

test("an uncertain resume response invalidates already pending approval callbacks", async () => {
	const { client, request, rpc } = setup();
	const id = await client.start("/data/worktrees/one");
	await client.send(id, "/data/worktrees/one", "Work");
	request(10, "item/commandExecution/requestApproval", { threadId: id, turnId: "turn-1", command: "pnpm test" });
	const requestId = client.read(id).requests[0]!.id;
	rpc.mockResolvedValueOnce({
		thread: {
			id,
			cwd: "/data/worktrees/one",
			historyMode: "paginated",
			status: { type: "systemError" },
			turns: [],
		},
	});
	expect(await client.resume(id, "/data/worktrees/one")).toMatchObject({ status: "uncertain", requests: [] });
	expect(() => client.reply(id, { requestId, decision: "accept" })).toThrow("agent-conflict");
});

test("resume retains newer live completion and connection-loss notifications", async () => {
	const { client, rpc, notify } = setup();
	const id = await client.start("/data/worktrees/one");
	const resumeResponse = {
		thread: { id, cwd: "/data/worktrees/one", historyMode: "paginated", status: { type: "active" }, turns: [] },
	};
	rpc.mockResolvedValueOnce(resumeResponse);
	rpc.mockImplementationOnce(async () => {
		notify("turn/completed", {
			threadId: id,
			turn: { id: "new", status: "completed", items: [{ id: "live", type: "agentMessage", text: "New answer" }] },
		});
		return { data: [], nextCursor: null };
	});
	expect(await client.resume(id, "/data/worktrees/one")).toMatchObject({
		status: "completed",
		turnId: "new",
		items: [{ text: "New answer" }],
	});
	rpc.mockResolvedValueOnce(resumeResponse);
	rpc.mockImplementationOnce(async () => {
		notify("connection/lost", {});
		return { data: [], nextCursor: null };
	});
	expect((await client.resume(id, "/data/worktrees/one")).status).toBe("uncertain");
});
