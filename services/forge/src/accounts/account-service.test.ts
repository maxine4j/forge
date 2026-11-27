import { describe, expect, it, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import { AccountService } from "./account-service.ts";

describe("AccountService", () => {
	it("rechecks owner authorization and serializes account mutations", async () => {
		const provider = {
			status: vi.fn(async () => ({ connection: "available" as const, login: { state: "idle" as const } })),
			start: vi.fn(async () => ({
				connection: "available" as const,
				login: {
					state: "pending" as const,
					verificationUrl: "https://github.com/login/device",
					userCode: "ABCD-EFGH",
				},
			})),
			cancel: vi.fn(async () => ({ connection: "available" as const, login: { state: "cancelled" as const } })),
		};
		const service = new AccountService(
			new AccessService({ owner: "owner", origin: "https://forge.test" }),
			provider,
			provider,
		);
		await expect(service.start({ username: "intruder" }, "codex")).rejects.toThrow("Access denied");
		expect(provider.start).not.toHaveBeenCalled();
		expect(await service.start({ username: "owner" }, "codex")).toMatchObject({ login: { state: "pending" } });
		expect(await service.cancel({ username: "owner" }, "github")).toMatchObject({ login: { state: "cancelled" } });
		expect(await service.status({ username: "owner" })).toHaveProperty("codex.connection", "available");
	});
});
