import type { IncomingMessage, ServerResponse } from "node:http";

export interface ITelemetrySink {
	accept(input: unknown): Promise<void>;
}

/** Mounted exclusively on the separate loopback listener, never the Forge HTTP application. */
export class TelemetryReceiver {
	private writes = Promise.resolve();
	constructor(
		private readonly secret: string,
		private readonly sink: ITelemetrySink,
	) {}
	async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.headers["authorization"] !== `Bearer ${this.secret}`) {
			response.writeHead(401).end();
			return;
		}
		if (request.method !== "POST" || !["/v1/traces", "/v1/logs"].includes(request.url ?? "")) {
			response.writeHead(404).end();
			return;
		}
		if (!request.headers["content-type"]?.startsWith("application/json")) {
			response.writeHead(415).end();
			return;
		}
		try {
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of request) {
				size += Buffer.byteLength(chunk);
				if (size > 4 * 1024 * 1024) {
					response.writeHead(413).end();
					return;
				}
				chunks.push(Buffer.from(chunk));
			}
			const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const write = this.writes.then(() => this.sink.accept(input));
			this.writes = write.catch(() => {});
			await write;
			response.writeHead(200, { "content-type": "application/json" }).end("{}");
		} catch {
			response.writeHead(400).end();
		}
	}
	async close(): Promise<void> {
		await this.writes;
	}
}

export const telemetryArguments = (endpoint: string, secret: string): string[] => {
	const args: string[] = [];
	for (const signal of ["exporter", "trace_exporter"]) {
		const path = signal === "exporter" ? "logs" : "traces";
		args.push(
			"-c",
			`otel.${signal}={otlp-http={endpoint=${JSON.stringify(`${endpoint}/v1/${path}`)},protocol="json",headers={Authorization=${JSON.stringify(`Bearer ${secret}`)}}}}`,
		);
	}
	for (const setting of ["log_user_prompt=false", "log_agent_responses=false", "log_guardian_assessments=false"])
		args.push("-c", `otel.${setting}`);
	return args;
};
