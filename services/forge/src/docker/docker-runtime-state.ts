export interface IDockerRuntimeFiles {
	rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

/** Startup disposal is limited to fixed Docker roots, never persistent Forge storage. */
export class DockerRuntimeState {
	constructor(private readonly files: IDockerRuntimeFiles) {}
	async reset(): Promise<void> {
		for (const path of [
			"/var/lib/forge-docker",
			"/run/forge-docker",
			"/run/forge-docker.pid",
			"/run/forge/docker.sock",
		])
			await this.files.rm(path, { recursive: true, force: true });
	}
}
