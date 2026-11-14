import type { Buffer } from "node:buffer";

import type { IOllamaClient } from "./worker-session.ts";

export class OllamaClient implements IOllamaClient {
	constructor(
		private readonly origin: string,
		private readonly request: typeof fetch,
	) {}

	async infer(body: Buffer, signal: AbortSignal): Promise<Response> {
		return await this.request(`${this.origin}/v1/responses`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Accept-Encoding": "identity" },
			body: new Uint8Array(body),
			redirect: "error",
			signal,
		});
	}

	async hasLocalModel(signal: AbortSignal): Promise<boolean> {
		const response = await this.request(`${this.origin}/api/tags`, { redirect: "error", signal });
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error("Ollama model list is unavailable");
		}
		const payload: unknown = await response.json();
		return (
			!!payload
			&& typeof payload === "object"
			&& "models" in payload
			&& Array.isArray(payload.models)
			&& payload.models.some(
				(model: unknown) =>
					!!model
					&& typeof model === "object"
					&& "name" in model
					&& typeof model.name === "string"
					&& model.name.length > 0
					&& !model.name.endsWith(":cloud")
					&& !("remote_host" in model && model.remote_host),
			)
		);
	}
}
