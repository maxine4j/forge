import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { mockApi } from "./dev/mock-api.ts";

export default defineConfig(({ mode }) => ({
	cacheDir: mode === "test" ? "node_modules/.vite-test" : "node_modules/.vite",
	plugins: [react(), ...(mode === "mock" ? [mockApi()] : [])],
	server: { port: 5174, strictPort: true },
}));
