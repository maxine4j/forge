import { defaultForgeSettings, type ForgeSettings } from "@forge/contracts/settings";
import { expect, test, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import { SettingsService } from "./settings-service.ts";

const owner = { username: "owner" };
const saved: ForgeSettings = {
	localCurrency: "AUD",
	monthlyPlanLocal: 30,
	planningInstructions: "Check migrations.",
	implementationInstructions: "Run focused tests.",
	gitName: "Forge Developer",
	gitEmail: "forge@example.com",
};

const setup = (initial = { ...defaultForgeSettings }) => {
	let persisted = initial;
	const store = {
		load: async () => persisted,
		save: vi.fn(async (settings: ForgeSettings) => {
			persisted = settings;
		}),
	};
	const git = { publish: vi.fn(async () => {}) };
	const service = new SettingsService(
		store,
		git,
		new AccessService({ owner: "owner", origin: "https://forge.test" }),
	);
	return { service, store, git };
};

test("loads settings and publishes saved identity at startup, then updates and clears it", async () => {
	const { service, store, git } = setup(saved);
	await service.initialize();
	expect(service.get(owner)).toEqual(saved);
	expect(git.publish).toHaveBeenLastCalledWith({ name: saved.gitName, email: saved.gitEmail });
	const edited = {
		...saved,
		localCurrency: "AUD",
		monthlyPlanLocal: 30,
		planningInstructions: "Read the requirements.",
	};
	await expect(service.save(owner, edited)).resolves.toEqual(edited);
	expect(service.current()).toEqual(edited);
	expect(git.publish).toHaveBeenCalledTimes(1);
	const cleared = { ...edited, gitName: "", gitEmail: "" };
	await expect(service.save(owner, cleared)).resolves.toEqual(cleared);
	expect(await store.load()).toEqual(cleared);
	expect(service.gitIdentity()).toBeUndefined();
	expect(git.publish).toHaveBeenLastCalledWith(undefined);
});

test("validates access and settings before touching persisted or system configuration", async () => {
	const { service, store, git } = setup();
	await service.initialize();
	expect(() => service.get({ username: "other" })).toThrow();
	await expect(service.save({ username: "other" }, saved)).rejects.toThrow();
	await expect(service.save(owner, { ...saved, gitEmail: "" })).rejects.toMatchObject({ code: "invalid-request" });
	expect(store.save).not.toHaveBeenCalled();
	expect(git.publish).toHaveBeenCalledTimes(1);
});

test("keeps prior settings on persistence or publication failure and permits retry", async () => {
	const { service, store, git } = setup();
	await service.initialize();
	store.save.mockRejectedValueOnce(new Error("database unavailable"));
	await expect(service.save(owner, saved)).rejects.toMatchObject({ code: "settings-unavailable" });
	expect(git.publish).toHaveBeenCalledTimes(1);
	git.publish.mockRejectedValueOnce(new Error("Git config unavailable"));
	await expect(service.save(owner, saved)).rejects.toMatchObject({ code: "settings-unavailable" });
	expect(await store.load()).toEqual(defaultForgeSettings);
	expect(service.get(owner)).toEqual(defaultForgeSettings);
	await expect(service.save(owner, saved)).resolves.toEqual(saved);
	expect(service.gitIdentity()).toEqual({ name: saved.gitName, email: saved.gitEmail });
});
