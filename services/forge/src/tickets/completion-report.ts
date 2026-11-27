export type CompletionReport =
	| { status: "complete"; summary?: string }
	| { status: "incomplete"; summary?: string; remaining: string; handover?: string };

/** Parse a final answer without accepting extra text or fields. */
export function parseCompletionReport(answer: string, checkpoint = false): CompletionReport | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(answer);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const value = parsed as Record<string, unknown>;
	if (value["status"] !== "complete" && value["status"] !== "incomplete") return undefined;
	const allowed = value["status"] === "complete" ? ["status", "summary"] : ["status", "summary", "remaining"];
	if (checkpoint && value["status"] === "incomplete") allowed.push("handover");
	if (Object.keys(value).some((key) => !allowed.includes(key))) return undefined;
	const field = (key: string, max: number): string | undefined => {
		const input = value[key];
		if (typeof input !== "string") return undefined;
		const trimmed = input.trim();
		return trimmed && trimmed.length <= max ? trimmed : undefined;
	};
	const summary = field("summary", 2000);
	if ("summary" in value && !summary) return undefined;
	if (value["status"] === "complete") return { status: "complete", ...(summary && { summary }) };
	const remaining = field("remaining", 2000);
	const handover = field("handover", 12000);
	if (!remaining || ("handover" in value && !handover)) return undefined;
	return { status: "incomplete", remaining, ...(summary && { summary }), ...(handover && { handover }) };
}
