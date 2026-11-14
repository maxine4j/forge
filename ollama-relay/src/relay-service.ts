import { Buffer } from "node:buffer";

import type { ISleep } from "@forge/backend-infrastructure/sleep";

import type { RelayFrame } from "./types.ts";

export interface IWorkerConnection {
	send(frame: RelayFrame | Buffer): Promise<void>;
	terminate(): void;
}

export interface IInferenceResponse {
	headers(status: number, contentType: string): void;
	write(chunk: Buffer): Promise<void>;
	end(): void;
	fail(status: number, code: string, message: string): void;
}

export interface IRelayService {
	pair(worker: IWorkerConnection): boolean;
	disconnect(worker: IWorkerConnection): void;
	receive(worker: IWorkerConnection, frame: RelayFrame | Buffer): void;
	infer(body: Buffer, response: IInferenceResponse, signal: AbortSignal): void;
}

interface Inference {
	id: number;
	body?: Buffer;
	response: IInferenceResponse;
	lifetime: AbortController;
	unsubscribe(): void;
	state: "queued" | "headers" | "body" | "writing" | "cancelling";
}

export class RelayService implements IRelayService {
	private worker?: IWorkerConnection;
	private active?: Inference;
	private readonly queued: Inference[] = [];
	private nextId = 0;

	constructor(
		private readonly sleep: ISleep,
		private readonly queueDeadline = 30_000,
		private readonly upstreamDeadline = 600_000,
	) {}

	pair(worker: IWorkerConnection): boolean {
		if (this.worker) return false;
		this.worker = worker;
		return true;
	}

	disconnect(worker: IWorkerConnection): void {
		if (this.worker !== worker) return;
		this.worker = undefined;
		for (const inference of this.queued.splice(0)) {
			inference.response.fail(503, "worker_offline", "Inference worker disconnected");
			this.release(inference);
		}
		if (this.active) {
			this.active.response.fail(503, "worker_offline", "Inference worker disconnected");
			this.release(this.active);
		}
	}

	infer(body: Buffer, response: IInferenceResponse, signal: AbortSignal): void {
		if (signal.aborted) return;
		if (!this.worker) {
			response.fail(503, "worker_offline", "Inference worker is unavailable");
			return;
		}
		if (this.queued.length >= 4) {
			response.fail(429, "queue_full", "Inference queue is full");
			return;
		}
		const onAbort = () => this.cancel(inference);
		const inference: Inference = {
			id: ++this.nextId,
			body,
			response,
			lifetime: new AbortController(),
			unsubscribe: () => signal.removeEventListener("abort", onAbort),
			state: "queued",
		};
		signal.addEventListener("abort", onAbort, { once: true });
		this.queued.push(inference);
		void this.sleep(this.queueDeadline, inference.lifetime.signal).then(
			() => {
				if (inference.state !== "queued") return;
				response.fail(429, "queue_timeout", "Inference queue deadline exceeded");
				this.release(inference);
			},
			() => {},
		);
		this.dispatch();
	}

	receive(worker: IWorkerConnection, frame: RelayFrame | Buffer): void {
		if (worker !== this.worker) return;
		const inference = this.active;
		if (!inference || (!Buffer.isBuffer(frame) && inference.id !== frame.id)) {
			this.drop(worker);
			return;
		}
		if (inference.state === "cancelling") {
			if (
				!Buffer.isBuffer(frame)
				&& (frame.type === "cancelled" || frame.type === "end" || frame.type === "failed")
			)
				this.release(inference);
			return;
		}
		if (Buffer.isBuffer(frame)) {
			if (inference.state !== "body") return this.drop(worker);
			inference.state = "writing";
			void inference.response.write(frame).then(
				() => {
					if (this.active !== inference || inference.state !== "writing") return;
					inference.state = "body";
					void worker.send({ type: "ack", id: inference.id }).catch(() => this.drop(worker));
				},
				() => this.cancel(inference),
			);
			return;
		}
		if (frame.type === "headers" && inference.state === "headers") {
			inference.state = "body";
			inference.response.headers(frame.status, frame.contentType);
		} else if (frame.type === "end" && inference.state === "body") {
			inference.response.end();
			this.release(inference);
		} else if (frame.type === "failed") {
			inference.response.fail(502, "upstream_error", "Ollama request failed");
			this.release(inference);
		} else {
			this.drop(worker);
		}
	}

	private dispatch(): void {
		const worker = this.worker;
		if (!worker || this.active) return;
		const inference = this.queued.shift();
		if (!inference?.body) return;
		const body = inference.body;
		inference.body = undefined;
		this.active = inference;
		inference.state = "headers";
		// Both frames are enqueued synchronously so a cancellation always follows the body.
		void Promise.all([worker.send({ type: "request", id: inference.id }), worker.send(body)]).catch(() =>
			this.drop(worker),
		);
		void this.sleep(this.upstreamDeadline, inference.lifetime.signal).then(
			() => {
				if (this.active !== inference || inference.state === "cancelling") return;
				inference.response.fail(504, "upstream_timeout", "Ollama response deadline exceeded");
				this.cancel(inference);
			},
			() => {},
		);
	}

	private cancel(inference: Inference): void {
		if (inference.state === "queued") {
			this.release(inference);
			return;
		}
		const worker = this.worker;
		if (!worker || this.active !== inference || inference.state === "cancelling") return;
		inference.state = "cancelling";
		void worker.send({ type: "cancel", id: inference.id }).catch(() => this.drop(worker));
		void this.sleep(5000, inference.lifetime.signal).then(
			() => {
				if (this.active === inference) this.drop(worker);
			},
			() => {},
		);
	}

	private release(inference: Inference): void {
		inference.lifetime.abort();
		inference.unsubscribe();
		if (this.active === inference) this.active = undefined;
		else {
			const index = this.queued.indexOf(inference);
			if (index !== -1) this.queued.splice(index, 1);
		}
		this.dispatch();
	}

	private drop(worker: IWorkerConnection): void {
		this.disconnect(worker);
		worker.terminate();
	}
}
