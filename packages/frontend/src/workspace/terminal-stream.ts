export interface ITerminalWriter {
	write(data: string, complete: () => void): void;
	reset(): void;
}

export class TerminalStream {
	private session: string | undefined;
	private generation = 0;
	private accepted = 0;
	private rendered = 0;
	constructor(private readonly writer: ITerminalWriter) {}
	/** Caller detaches the old socket first. Drain public xterm write queue before reset/replay. */
	async prepare(id: string): Promise<number> {
		const generation = ++this.generation;
		await new Promise<void>((resolve) => this.writer.write("", resolve));
		if (generation !== this.generation) throw new Error("Terminal attach superseded");
		if (id !== this.session) {
			this.writer.reset();
			this.session = id;
			this.accepted = 0;
			this.rendered = 0;
		} else this.rendered = this.accepted;
		return this.rendered;
	}
	output(sequence: number, data: string): void {
		if (sequence <= this.accepted) return;
		this.accepted = sequence;
		const generation = this.generation;
		this.writer.write(data, () => {
			if (generation === this.generation) this.rendered = Math.max(this.rendered, sequence);
		});
	}
	gap(through: number): void {
		this.accepted = Math.max(this.accepted, through);
		this.rendered = Math.max(this.rendered, through);
	}
	input(data: string): string[] {
		const encoder = new TextEncoder();
		const overhead = encoder.encode(JSON.stringify({ type: "input", data: "" })).length;
		const frames: string[] = [];
		let content = "";
		let bytes = overhead;
		for (const character of data) {
			const size = encoder.encode(JSON.stringify(character).slice(1, -1)).length;
			if (bytes + size > 16384) {
				frames.push(JSON.stringify({ type: "input", data: content }));
				content = "";
				bytes = overhead;
			}
			content += character;
			bytes += size;
		}
		if (content) frames.push(JSON.stringify({ type: "input", data: content }));
		return frames;
	}
}
