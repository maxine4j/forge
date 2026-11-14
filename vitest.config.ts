import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts", "ollama-relay/src/**/*.test.ts"] } });
