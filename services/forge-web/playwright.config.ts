import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: "tests",
	fullyParallel: false,
	use: { baseURL: "http://127.0.0.1:5176", viewport: { width: 1280, height: 900 } },
	webServer: {
		command: "pnpm dev --mode test --host 127.0.0.1 --port 5176",
		url: "http://127.0.0.1:5176",
		reuseExistingServer: false,
	},
	outputDir: "../../artifacts/forge-browser",
	reporter: "list",
});
