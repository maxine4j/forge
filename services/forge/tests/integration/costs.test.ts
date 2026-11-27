import { expect, test } from "vitest";

import { AccessService } from "../../src/auth/access-service.ts";
import { CostService } from "../../src/cost/cost-service.ts";
import { CostStore } from "../../src/cost/cost-store.ts";
import { QuotaStore } from "../../src/cost/quota-store.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { ProjectStore } from "../../src/projects/project-store.ts";
import { TicketStore } from "../../src/tickets/ticket-store.ts";
import { TicketWorkflowStore } from "../../src/tickets/ticket-workflow-store.ts";

test("ticket summaries stay independent of repository references and retain every phase and archived zero-usage tickets", async () => {
	const db = new SqliteDatabase(":memory:");
	await db.initialize();
	try {
		const date = "2026-11-12T00:00:00.000Z";
		const projects = new ProjectStore(db);
		await projects.initialize();
		const repositoryIds = ["123e4567-e89b-42d3-a456-426614174000", "123e4567-e89b-42d3-a456-426614174001"];
		for (const id of repositoryIds) await projects.insert({ id, name: id, status: "ready", createdAt: date });
		const tickets = new TicketStore(db);
		await tickets.initialize();
		await new TicketWorkflowStore(db).initialize();
		const ticket = await tickets.insert({ title: "Working", description: "", repositoryIds: [] }, date);
		const empty = await tickets.insert(
			{ title: "Archived, no repositories", description: "", repositoryIds: [] },
			date,
		);
		await tickets.move(empty.id, { status: "done" });
		await tickets.archive(empty.id, date);
		const costs = new CostStore(db);
		await costs.initialize(date);
		const quotas = new QuotaStore(db, costs);
		await quotas.initialize();
		const weekly = {
			bucketId: "codex",
			bucket: "Codex",
			minutes: 10080 as const,
			resetsAt: "2026-11-15T00:00:00.000Z",
			observedAt: date,
			usedPercent: 10,
		};
		await quotas.capture([weekly], date);
		const common = {
			projectId: repositoryIds[0]!,
			threadId: "thread",
			startedAt: date,
			billing: {
				localCurrency: "AUD",
				monthlyPlanLocal: 30,
				usdToLocal: 1.5,
				rates: { input: 2, cached: 0.1, output: 10 },
			},
			input: 1000,
			cached: 0,
			output: 100,
		};
		for (const phase of ["planning", "implementation", "review", "rebase"] as const)
			await costs.save({ ...common, ticketId: ticket.id, phase, turnId: phase });
		await costs.save({ ...common, phase: "chat", turnId: "chat" });
		const end = "2026-11-12T00:05:00.000Z";
		await quotas.capture([{ ...weekly, observedAt: end, usedPercent: 15 }], end);
		const access = new AccessService({ owner: "owner", origin: "https://forge.test" });
		const service = new CostService(
			access,
			tickets,
			costs,
			{ limits: async () => undefined },
			() => new Date(end),
			quotas,
		);
		const owner = { username: "owner" };
		const before = await service.read(owner);
		await tickets.update(ticket.id, { title: ticket.title, description: ticket.description, repositoryIds });
		const after = await service.read(owner);
		expect(after).toEqual(before);
		expect(after.tickets[0]).toMatchObject({
			turns: 4,
			apiUsd: 0.012,
			weeklyUsagePercent: 4,
			incomplete: { api: 0, weekly: 0, effective: 0 },
		});
		expect(after.tickets[0]?.effectiveUsd).toBeCloseTo(((4 / 100) * 30) / 1.5 / 4.33);
		expect(after.chats).toMatchObject({ turns: 1, apiUsd: 0.003, weeklyUsagePercent: 1 });
		expect(after.totals).toMatchObject({ turns: 5, weeklyUsagePercent: 5 });
		expect(after.quotaAttribution).toEqual([{ bucketId: "codex", consumption: 5, allocated: 5, unallocated: 0 }]);
		expect(after.tickets[1]).toMatchObject({
			id: empty.id,
			archivedAt: date,
			turns: 0,
			apiUsd: 0,
			weeklyUsagePercent: 0,
			effectiveUsd: 0,
		});
		expect(
			(await service.readTicket(owner, ticket.id)).phases.map((phase) => [
				phase.phase,
				phase.turns,
				phase.weeklyUsagePercent,
			]),
		).toEqual([
			["planning", 1, 1],
			["implementation", 1, 1],
			["review", 1, 1],
			["rebase", 1, 1],
		]);
		expect((await service.readTicket(owner, empty.id)).ticket.turns).toBe(0);
	} finally {
		await db.close();
	}
}, 30_000);
