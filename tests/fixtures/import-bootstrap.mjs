import { Lifecycle } from "/app/dist/http/lifecycle.js";
import { GitTransport } from "/app/dist/repositories/git-transport.js";
import { start } from "/app/dist/start.js";
import { sleep } from "/app/packages/backend-infrastructure/dist/sleep.js";
const lifecycle = new Lifecycle();
for (const signal of ["SIGTERM", "SIGINT"])
	process.on(signal, async () => {
		await lifecycle.shutdown();
		process.exit(0);
	});
await start(lifecycle, {
	git: new GitTransport(sleep, { executable: process.execPath, prefix: ["/fixtures/import-git-peer.mjs"] }),
});
