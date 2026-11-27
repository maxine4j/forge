import { run } from "@forge/backend-infrastructure/process-main";

import { start } from "./start.ts";

run("ollama-relay", start);
