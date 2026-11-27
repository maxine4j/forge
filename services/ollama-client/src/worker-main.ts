import { run } from "@forge/backend-infrastructure/process-main";

import { startWorker } from "./worker-start.ts";

run("ollama-relay-worker", startWorker);
