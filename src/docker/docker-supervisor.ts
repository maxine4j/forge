export interface SupervisedProcess {
	done: Promise<number>;
	stop(timeoutMs: number): Promise<void>;
}
export interface ISupervisorRuntime {
	reset(): Promise<void>;
	docker(): SupervisedProcess;
	forge(): SupervisedProcess;
	warn(message: string): void;
}
/** Docker loss never stops Forge. Shutdown drains Forge before stopping the daemon. */
export class DockerSupervisor {
	private docker: SupervisedProcess | undefined;
	private forge: SupervisedProcess | undefined;
	private stopping = false;
	constructor(private readonly runtime: ISupervisorRuntime) {}
	async start(onExit: (code: number) => void): Promise<void> {
		try {
			await this.runtime.reset();
			if (this.stopping) return;
			this.docker = this.runtime.docker();
			void this.docker.done.then(() => {
				if (!this.stopping) this.runtime.warn("Docker unavailable; Forge remains available");
			});
		} catch {
			this.runtime.warn("Docker startup failed; Forge remains available");
		}
		if (this.stopping) return;
		this.forge = this.runtime.forge();
		void this.forge.done.then((code) => {
			if (!this.stopping) onExit(code);
		});
	}
	async stop(): Promise<void> {
		this.stopping = true;
		try {
			await this.forge?.stop(18_000);
		} finally {
			await this.docker?.stop(7_000);
		}
	}
}
