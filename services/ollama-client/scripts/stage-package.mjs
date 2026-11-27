import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);
const infrastructure = new URL("../../../packages/backend-infrastructure/", import.meta.url);
const output = new URL("package/", dist);
const internal = new URL("infrastructure/", output);
const { name, dependencies, version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
const { dependencies: infrastructureDependencies } = JSON.parse(
	await readFile(new URL("package.json", infrastructure)),
);

const release = process.argv[2] ?? version;
if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(release))
	throw new Error("Package version must use X.Y.Z with no leading zeroes");

await mkdir(new URL("ollama/", internal), { recursive: true });
for (const name of [
	"logger",
	"process-main",
	"sleep",
	"ollama/pairing-token",
	"ollama/pairing-socket",
	"ollama/types",
]) {
	await copyFile(new URL(`dist/${name}.js`, infrastructure), new URL(`${name}.js`, internal));
}
const files = (await readdir(dist)).filter((file) => file.endsWith(".js"));
for (const file of files) {
	const source = await readFile(new URL(file, dist), "utf8");
	await writeFile(
		new URL(file, output),
		source.replaceAll(/(["'])@forge\/backend-infrastructure\/([\w/-]+)\1/gu, "$1./infrastructure/$2.js$1"),
	);
}
await writeFile(
	new URL("package.json", output),
	JSON.stringify(
		{
			name,
			version: release,
			description: "Run a local Ollama worker for the Forge inference relay.",
			type: "module",
			bin: { "forge-ollama-client": "worker-main.js" },
			engines: { node: ">=24 <25" },
			files: [...files, "infrastructure"],
			repository: {
				type: "git",
				url: "git+https://github.com/maxine4j/forge.git",
				directory: "services/ollama-client",
			},
			publishConfig: { registry: "https://npm.pkg.github.com" },
			dependencies: { pino: infrastructureDependencies.pino, ws: dependencies.ws },
		},
		null,
		"\t",
	) + "\n",
);
