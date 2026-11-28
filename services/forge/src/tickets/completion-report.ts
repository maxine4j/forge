export type CompletionReport =
	| { status: "complete"; summary?: string }
	| { status: "incomplete"; summary?: string; remaining: string }
	| { status: "handoff"; handover: string };

export const reportTextLimit = 2000;
export const handoffRequestTokens = 1500;
const handoffCodeUnitLimit = 2000 * 4;

export function capHandoffText(input: string): string {
	const trimmed = input.trim();
	const before = trimmed.charCodeAt(handoffCodeUnitLimit - 1);
	const after = trimmed.charCodeAt(handoffCodeUnitLimit);
	const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
	return trimmed.slice(0, handoffCodeUnitLimit - Number(splitsPair)).trimEnd();
}

type ReportField = { name: "summary" | "remaining" | "handover"; required: boolean; bounded?: boolean };

export function completionReportRequirements(hasNextSubtask = false) {
	const complete: ReportField[] = [{ name: "summary", required: hasNextSubtask, bounded: hasNextSubtask }];
	const incomplete: ReportField[] = [
		{ name: "remaining", required: true },
		{ name: "summary", required: false },
	];
	const handoff: ReportField[] = [{ name: "handover", required: true, bounded: true }];
	return { complete, incomplete, handoff };
}

/** Parse a final answer without accepting extra text or fields. */
export function parseCompletionReport(
	answer: string,
	requirements = completionReportRequirements(),
): CompletionReport | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(answer);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const value = parsed as Record<string, unknown>;
	const status = value["status"];
	if (status !== "complete" && status !== "incomplete" && status !== "handoff") return undefined;
	const fields = requirements[status];
	if (!fields || Object.keys(value).some((key) => key !== "status" && !fields.some(({ name }) => name === key)))
		return undefined;
	const validated: Partial<Record<ReportField["name"], string>> = {};
	for (const { name, required, bounded } of fields) {
		if (!(name in value) && !required) continue;
		const input = value[name];
		if (typeof input !== "string") return undefined;
		const trimmed = bounded ? capHandoffText(input) : input.trim();
		if (!trimmed || (!bounded && trimmed.length > reportTextLimit)) return undefined;
		validated[name] = trimmed;
	}
	const { summary, remaining, handover } = validated;
	if (status === "handoff" && handover) return { status, handover };
	if (status === "incomplete" && remaining) return { status, remaining, ...(summary && { summary }) };
	if (status === "complete") return { status, ...(summary && { summary }) };
	return undefined;
}
