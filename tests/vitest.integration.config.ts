import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		globalSetup: ["./tests/integration/build-bridge"],
		include: ["tests/integration/**/*.test.ts"],
	},
});
