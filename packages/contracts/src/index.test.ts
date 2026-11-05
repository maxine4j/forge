import { expect, test } from "vitest";

import { createProjectSchema, projectSchema } from "./index.ts";

test("project inputs are bounded plain values; imports accept credential-free HTTPS only", () => {
	expect(createProjectSchema.parse({ name: "  Forge  " })).toEqual({ name: "Forge" });
	for (const source of [
		"/etc",
		"file:///tmp/repo",
		"git@github.com:x/y",
		"https://user:secret@example.com/a",
		"http://example.com/a",
		"https://example.com/a?token=secret",
		"https://example.com/a#ref",
	]) {
		expect(createProjectSchema.safeParse({ name: "Project", source }).success).toBe(false);
	}
	expect(createProjectSchema.safeParse({ name: "x", source: "https://github.com/example/repo.git" }).success).toBe(
		true,
	);
	expect(createProjectSchema.safeParse({ name: "x", surprise: true }).success).toBe(false);
	expect(createProjectSchema.safeParse({ name: "x".repeat(121) }).success).toBe(false);
});

test("public projects reject persistence internals and raw failure diagnostics", () => {
	const value = {
		id: "123e4567-e89b-42d3-a456-426614174000",
		name: "Project",
		status: "ready",
		createdAt: "2026-11-02T00:00:00.000Z",
	};
	expect(projectSchema.parse(value)).toEqual(value);
	expect(projectSchema.safeParse({ ...value, source: "SECRET" }).success).toBe(false);
});
