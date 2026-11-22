import { z } from "zod";

const nonblank = z.string().refine((value) => value.trim().length > 0);
export const structuredTicketPlanSchema = z.object({
	title: nonblank.optional(),
	goals: nonblank,
	scope: nonblank,
	decisions: nonblank,
	acceptanceCriteria: nonblank,
	tests: nonblank,
	subtasks: z.array(
		z.object({
			number: z.number().int().positive(),
			title: nonblank,
			files: nonblank,
			dependencies: nonblank,
			expectedChanges: nonblank,
			exclusions: nonblank,
			completionCriteria: nonblank,
		}),
	),
});
export type StructuredTicketPlan = z.infer<typeof structuredTicketPlanSchema>;

export const ticketPlanHeadings = [
	"Goals",
	"Scope",
	"Decisions",
	"Acceptance criteria",
	"Tests",
	"Ordered subtasks",
] as const;
export const ticketPlanLabels = [
	"Files",
	"Dependencies",
	"Expected changes",
	"Exclusions",
	"Completion criteria",
] as const;
export function renderTicketPlan(plan: StructuredTicketPlan): string {
	const sections = [plan.goals, plan.scope, plan.decisions, plan.acceptanceCriteria, plan.tests];
	return [
		plan.title && `# ${plan.title}`,
		...sections.map((body, i) => `## ${ticketPlanHeadings[i]}\n${body}`),
		plan.subtasks.length > 0
			&& `## Ordered subtasks\n${plan.subtasks.map((task) => `### ${task.number}. ${task.title}\n${[task.files, task.dependencies, task.expectedChanges, task.exclusions, task.completionCriteria].map((value, i) => `- ${ticketPlanLabels[i]}: ${value}`).join("\n")}`).join("\n\n")}`,
	]
		.filter(Boolean)
		.join("\n\n");
}
