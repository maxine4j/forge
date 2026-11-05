import { workspaceFileSchema, workspacesSchema } from "@forge/contracts";
import { expect, test, vi } from "vitest";

import { WorkspaceApi } from "./workspace-api.ts";

test("validates responses, sanitizes transport/unknown errors and retains documented conflict codes", async () => {
	const request = vi.fn<typeof fetch>();
	const api = new WorkspaceApi(request);
	request.mockResolvedValueOnce(Response.json([{ secret: "TOKEN" }]));
	await expect(api.read("projects/id/workspaces", workspacesSchema)).rejects.toThrow("Unexpected server response");
	request.mockRejectedValueOnce(new Error("TOKEN"));
	await expect(api.read("projects/id/workspaces", workspacesSchema)).rejects.toThrow("Cannot reach Forge");
	request.mockResolvedValueOnce(Response.json({ error: "TOKEN" }, { status: 503 }));
	await expect(api.read("projects/id/workspaces", workspacesSchema)).rejects.toThrow("Request failed");
	request.mockResolvedValueOnce(Response.json({ error: "revision-conflict" }, { status: 409 }));
	await expect(api.read("pull-requests/id", workspacesSchema)).rejects.toThrow("Source refs changed. Refresh review");
});

test("save transmits exact expected content version with same-origin credentials", async () => {
	const file = { path: "file.ts", content: "updated", version: "a".repeat(64) };
	const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(file));
	const api = new WorkspaceApi(request);
	expect(await api.read("workspaces/id/file", workspaceFileSchema, "PUT", file)).toEqual(file);
	expect(request).toHaveBeenCalledWith(
		"/api/workspaces/id/file",
		expect.objectContaining({ method: "PUT", credentials: "same-origin", body: JSON.stringify(file) }),
	);
});

test.each([
	"workspace-not-found",
	"workspace-conflict",
	"workspace-unavailable",
	"no-changes",
	"pull-request-unavailable",
])("presents %s without internal workspace terminology", async (error) => {
	const api = new WorkspaceApi(async () => Response.json({ error }, { status: 503 }));
	await expect(api.read("projects/id/workspaces", workspacesSchema)).rejects.not.toThrow(/workspace/i);
});

test.each([
	["agent-not-found", "Chat no longer exists"],
	["agent-conflict", "Chat changed"],
	["agent-unavailable", "Chat unavailable"],
])("presents %s with safe chat recovery guidance", async (error, message) => {
	const api = new WorkspaceApi(async () => Response.json({ error }, { status: 503 }));
	await expect(api.read("agents/id", workspacesSchema)).rejects.toThrow(message);
});
