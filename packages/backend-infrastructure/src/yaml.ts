import { LineCounter, parseDocument, stringify } from "yaml";

export class YamlError extends Error {
	readonly location: string;
	constructor(file: string, line?: number, column?: number, options?: ErrorOptions) {
		super("invalid YAML/schema; check required fields, types, unknown fields, and duplicate keys", options);
		this.name = "YamlError";
		this.location = line === undefined ? file : `${file}:${line}:${column}`;
	}
}

export const stringifyYaml = (value: unknown): string => stringify(value);

/** Add file context while retaining parser diagnostics as the cause. */
export function parseYaml(source: string, file: string): unknown {
	const lineCounter = new LineCounter();

	try {
		const document = parseDocument(source, {
			uniqueKeys: true,
			lineCounter,
			version: "1.2",
		});

		const error = document.errors.at(0);
		if (error) {
			const position = lineCounter.linePos(error.pos.at(0) ?? 0);
			throw new YamlError(file, position.line, position.col, { cause: error });
		}

		if (document.warnings.length > 0)
			throw new YamlError(file, undefined, undefined, { cause: document.warnings.at(0) });

		return document.toJS({ maxAliasCount: 100 });
	} catch (error) {
		if (error instanceof YamlError) throw error;
		throw new YamlError(file, undefined, undefined, { cause: error });
	}
}
