import { run } from "./process-main.ts";
import { startWorker } from "./worker-start.ts";

run("ollama-relay-worker", startWorker);
