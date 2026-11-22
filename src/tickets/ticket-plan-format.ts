import {
	structuredTicketPlanSchema,
	ticketPlanHeadings as headings,
	ticketPlanLabels as labels,
	type StructuredTicketPlan,
} from "@forge/contracts/tickets";
export const ticketPlanGuidance = `Return a complete native Markdown plan with exactly these level-two headings in order: ${headings.join(", ")}. Include nonblank bodies describing goals, in-scope and excluded work, settled decisions and assumptions, verifiable acceptance criteria, and test cases and commands. Optionally begin with one level-one title. Under Ordered subtasks use consecutive headings like ### 1. Title. For each, include exactly one nonblank entry for ${labels.map((label) => `- ${label}: value`).join(", ")}. Indent continuation lines. Give repository-relative paths and relevant symbols; name dependencies by earlier subtask number or None.`;

export function parseTicketPlan(text: string): StructuredTicketPlan | undefined {
	if (text.length > 32000) return undefined;
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let fence: string | undefined;
	let section = -1;
	let title: string | undefined;
	const bodies: string[][] = [[], [], [], [], []];
	const tasks: StructuredTicketPlan["subtasks"] = [];
	let fields: string[][] | undefined;
	let field = -1;
	let taskTitle = "";
	const finish = () => {
		if (!fields || fields.some((value) => !value.join("\n").trim())) return false;
		tasks.push({
			number: tasks.length + 1,
			title: taskTitle,
			files: fields[0]!.join("\n").trim(),
			dependencies: fields[1]!.join("\n").trim(),
			expectedChanges: fields[2]!.join("\n").trim(),
			exclusions: fields[3]!.join("\n").trim(),
			completionCriteria: fields[4]!.join("\n").trim(),
		});
		return true;
	};
	for (const line of lines) {
		const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
		const inside = !!fence;
		if (marker && (!fence || (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length)))
			fence = fence ? undefined : marker[1];
		if (!inside && !marker) {
			const heading = line.match(/^## (.*)$/);
			if (heading) {
				if (heading[1] !== headings[section + 1]) return undefined;
				section++;
				continue;
			}
			if (section < 0) {
				if (!line.trim()) continue;
				const match = line.match(/^# (.+)$/);
				if (!match || title) return undefined;
				title = match[1]!.trim();
				continue;
			}
			if (section === 5) {
				const task = line.match(/^### (\d+)\. (.+)$/);
				if (task) {
					if ((fields && !finish()) || Number(task[1]) !== tasks.length + 1) return undefined;
					taskTitle = task[2]!.trim();
					fields = labels.map(() => []);
					field = -1;
					continue;
				}
				const entry = line.match(/^- ([^:]+):\s*(.*)$/);
				if (entry) {
					const index = labels.indexOf(entry[1] as (typeof labels)[number]);
					if (!fields || index < 0 || fields[index]!.length) return undefined;
					field = index;
					fields[index]!.push(entry[2]!);
					continue;
				}
				if (!line.trim()) {
					if (field >= 0) fields![field]!.push(line);
					continue;
				}
				if (field < 0 || !/^\s+/.test(line)) return undefined;
				fields![field]!.push(line);
				continue;
			}
			if (/^#{1,2}(?:\s|$)/.test(line)) return undefined;
		}
		if (section < 0) return undefined;
		if (section < 5) bodies[section]!.push(line);
		else {
			if (field < 0 || !/^\s+/.test(line)) return undefined;
			fields![field]!.push(line);
		}
	}
	if (fence || (section !== 4 && section !== 5) || (section === 5 && !finish())) return undefined;
	const result = structuredTicketPlanSchema.safeParse({
		title,
		goals: bodies[0]!.join("\n").trim(),
		scope: bodies[1]!.join("\n").trim(),
		decisions: bodies[2]!.join("\n").trim(),
		acceptanceCriteria: bodies[3]!.join("\n").trim(),
		tests: bodies[4]!.join("\n").trim(),
		subtasks: tasks,
	});
	return result.success ? result.data : undefined;
}
