import type { DockerContainer, DockerResources, DockerStats } from "@forge/contracts/docker";
import { z } from "zod";

import { DockerError, type IDockerCommand } from "./docker-command.ts";

const text = z.string().max(4096);
const inspection = z.object({
	Id: z.string().regex(/^[a-f0-9]{64}$/),
	Image: text,
	Name: text,
	Config: z.object({ Image: text }),
	State: z.object({ Running: z.boolean(), Status: text }),
	Mounts: z
		.array(z.object({ Type: text, Name: text.optional() }))
		.nullable()
		.transform((value) => value ?? []),
	NetworkSettings: z.object({
		Networks: z
			.record(text, z.unknown())
			.nullable()
			.transform((value) => value ?? {}),
		Ports: z
			.record(text, z.array(z.object({ HostIp: text, HostPort: text })).nullable())
			.nullable()
			.transform((value) => value ?? {}),
	}),
});
export interface DockerInspection {
	id: string;
	image: string;
	volumes: string[];
	networks: string[];
	summary: DockerContainer;
	running: boolean;
}
export interface IDockerClient {
	containers(): Promise<DockerInspection[]>;
	inspect(id: string): Promise<DockerInspection | undefined>;
	stats(): Promise<Map<string, DockerStats>>;
	resources(): Promise<DockerResources>;
	remove(kind: "container" | "volume" | "network" | "image", id: string): Promise<void>;
	imageTags(id: string): Promise<string[]>;
	prune(): Promise<void>;
	pruneVolumes(): Promise<void>;
}
const lines = (value: string) => value.split("\n").filter(Boolean);
export class DockerClient implements IDockerClient {
	constructor(private readonly command: IDockerCommand) {}
	async inspect(id: string): Promise<DockerInspection | undefined> {
		try {
			// Explicit projection excludes container environments and labels; only validated summaries leave this client.
			const value = await this.command.run([
				"container",
				"inspect",
				"--format",
				'{"Id":{{json .Id}},"Image":{{json .Image}},"Name":{{json .Name}},"Config":{"Image":{{json .Config.Image}}},"State":{"Running":{{json .State.Running}},"Status":{{json .State.Status}}},"Mounts":{{json .Mounts}},"NetworkSettings":{"Networks":{{json .NetworkSettings.Networks}},"Ports":{{json .NetworkSettings.Ports}}}}',
				id,
			]);
			const item = inspection.parse(JSON.parse(value));
			return {
				id: item.Id,
				image: item.Image,
				running: item.State.Running,
				volumes: item.Mounts.filter((mount) => mount.Type === "volume").flatMap((mount) =>
					mount.Name ? [mount.Name] : [],
				),
				networks: Object.keys(item.NetworkSettings.Networks).filter(
					(name) => !["bridge", "host", "none"].includes(name),
				),
				summary: {
					id: item.Id,
					name: item.Name.replace(/^\//, ""),
					image: item.Config.Image,
					status: item.State.Status,
					stats: null,
					ports: Object.entries(item.NetworkSettings.Ports)
						.flatMap(
							([port, bindings]) =>
								bindings?.map((binding) => `${binding.HostIp}:${binding.HostPort} → ${port}`) ?? [port],
						)
						.join(", "),
				},
			};
		} catch (error) {
			if (error instanceof DockerError && error.code === "docker-resource-missing") return undefined;
			throw new DockerError();
		}
	}
	async containers(): Promise<DockerInspection[]> {
		const ids = z
			.array(z.string().regex(/^[a-f0-9]{64}$/))
			.parse(lines(await this.command.run(["container", "ls", "--all", "--quiet", "--no-trunc"])));
		const result: DockerInspection[] = [];
		for (const id of ids) {
			const item = await this.inspect(id);
			if (item) result.push(item);
		}
		return result;
	}
	async stats(): Promise<Map<string, DockerStats>> {
		const rows = lines(await this.command.run(["stats", "--no-stream", "--no-trunc", "--format", "{{json .}}"]));
		const schema = z.object({ ID: text, CPUPerc: text, MemUsage: text, NetIO: text, BlockIO: text, PIDs: text });
		return new Map(
			rows.map((row) => {
				const item = schema.parse(JSON.parse(row));
				return [
					item.ID,
					{
						cpu: item.CPUPerc,
						memory: item.MemUsage,
						network: item.NetIO,
						block: item.BlockIO,
						processes: item.PIDs,
					},
				];
			}),
		);
	}
	async resources(): Promise<DockerResources> {
		const list = async (args: string[]) => z.array(text).parse(lines(await this.command.run(args)));
		const disk = lines(await this.command.run(["system", "df", "--format", "{{json .}}"])).map((row) =>
			z.object({ Type: text, TotalCount: z.union([text, z.number()]), Size: text }).parse(JSON.parse(row)),
		);
		return {
			containers: await list(["container", "ls", "-aq", "--no-trunc"]),
			images: [...new Set(await list(["image", "ls", "-aq", "--no-trunc"]))],
			volumes: await list(["volume", "ls", "-q"]),
			networks: (await list(["network", "ls", "--format", "{{.Name}}"])).filter(
				(name) => !["bridge", "host", "none"].includes(name),
			),
			buildCache: disk
				.filter((row) => row.Type === "Build Cache" && String(row.TotalCount) !== "0")
				.map((row) => `${row.TotalCount} entries (${row.Size})`),
		};
	}
	async remove(kind: "container" | "volume" | "network" | "image", id: string): Promise<void> {
		try {
			await this.command.run([kind, "rm", ...(kind === "container" ? ["--force", "--volumes"] : []), "--", id]);
		} catch (error) {
			if (!(error instanceof DockerError && error.code === "docker-resource-missing")) throw error;
		}
	}
	async imageTags(id: string): Promise<string[]> {
		try {
			const value = await this.command.run(["image", "inspect", "--format", "{{json .RepoTags}}", id]);
			return z.array(text).nullable().parse(JSON.parse(value)) ?? [];
		} catch (error) {
			if (error instanceof DockerError && error.code === "docker-resource-missing") return [];
			throw error;
		}
	}
	async prune(): Promise<void> {
		await this.command.run(["system", "prune", "-a", "--volumes", "--force"], 120_000);
	}
	async pruneVolumes(): Promise<void> {
		await this.command.run(["volume", "prune", "-a", "--force"], 120_000);
	}
}
