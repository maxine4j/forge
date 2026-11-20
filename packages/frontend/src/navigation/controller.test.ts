import { createMemoryRouter, type Location } from "react-router";
import { describe, expect, it } from "vitest";

import {
	advanceModal,
	createModalNavigation,
	directModalParent,
	dismissalDepth,
	navigationState,
	nextModal,
	retainsModal,
} from "./controller.tsx";

const location = (search = "", state: unknown = null): Location => ({
	pathname: "/tasks",
	search,
	hash: "",
	state,
	key: "test",
});

describe("modal history", () => {
	it("keeps unrelated Config selection parameters beneath a direct ticket", () => {
		const linked = {
			...location("?provider=example&remove=1&ticket=TASK-1&tab=cost"),
			pathname: "/config",
			hash: "#settings",
		};
		expect(directModalParent(linked)).toMatchObject({
			pathname: "/config",
			search: "?provider=example&remove=1",
			hash: "#settings",
		});
	});
	it.each([
		"/tasks",
		"/costs",
		"/config",
		"/repos",
		"/repos/example/code",
		"/repos/example/agents/chat",
		"/repos/example/pipelines",
		"/repos/example/terminals",
	])("preserves the site-wide direct link parent at %s through reload and dismissal", async (pathname) => {
		const linked = { ...location("?filter=kept&ticket=TASK-1&tab=history"), pathname, hash: "#reading" };
		const parent = directModalParent(linked)!;
		expect(parent).toMatchObject({ pathname, search: "?filter=kept", hash: "#reading" });
		const parentUrl = pathname + parent.search + parent.hash;
		const linkedUrl = pathname + linked.search + linked.hash;
		const state = nextModal(parent, "ticket");
		expect(directModalParent({ ...linked, state })).toBeUndefined();
		const router = createMemoryRouter([{ path: "*", element: null }], {
			initialEntries: [parentUrl, { pathname, search: linked.search, hash: linked.hash, state }],
			initialIndex: 1,
		});
		const navigation = createModalNavigation(() => router.state.location, router.navigate);
		navigation.select(pathname + "?filter=kept&ticket=TASK-1&tab=chat#reading");
		navigation.dismissOwner("ticket");
		expect(router.state.location.pathname + router.state.location.search + router.state.location.hash).toBe(
			parentUrl,
		);
		await router.navigate(1);
		expect(router.state.location.pathname + router.state.location.search + router.state.location.hash).toBe(
			linkedUrl,
		);
		router.dispose();
	});

	it("records ticket switching in one owner and closes to the original parent", async () => {
		const router = createMemoryRouter([{ path: "*", element: null }], {
			initialEntries: ["/tasks?view=backlog#list"],
		});
		const navigation = createModalNavigation(() => router.state.location, router.navigate);
		navigation.open("ticket", "/tasks?view=backlog&ticket=TASK-1#list");
		const id = navigationState(router.state.location).modal?.id;
		navigation.open("ticket", "/tasks?view=backlog&ticket=TASK-2#list");
		expect(navigationState(router.state.location).modal).toMatchObject({
			id,
			depth: 2,
			parent: { url: "/tasks?view=backlog#list" },
		});
		await router.navigate(-1);
		expect(router.state.location.search).toContain("ticket=TASK-1");
		await router.navigate(1);
		navigation.dismissOwner("ticket");
		expect(router.state.location.search).toBe("?view=backlog");
		expect(router.state.location.hash).toBe("#list");
		router.dispose();
	});

	it("ignores delayed tab initialization after Back restores a modal parent", async () => {
		const router = createMemoryRouter([{ path: "*", element: null }], { initialEntries: ["/tasks?view=backlog"] });
		const navigation = createModalNavigation(() => router.state.location, router.navigate);
		navigation.open("epic", "/tasks?view=backlog&epic=EPIC-1");
		const parentKey = router.state.location.key;
		navigation.open("ticket", "/tasks?view=backlog&ticket=TASK-1");
		const ticketKey = router.state.location.key;
		await router.navigate(-1);
		navigation.select("/tasks?view=backlog&ticket=TASK-1&tab=details", true, ticketKey);
		expect(router.state.location.key).toBe(parentKey);
		expect(router.state.location.search).toContain("epic=EPIC-1");
		navigation.open("ticket", "/tasks?view=backlog&ticket=TASK-1");
		const initialKey = router.state.location.key;
		navigation.select("/tasks?view=backlog&ticket=TASK-1&tab=history");
		navigation.select("/tasks?view=backlog&ticket=TASK-1&tab=details", true, initialKey);
		expect(router.state.location.search).toContain("tab=history");
		router.dispose();
	});

	it("uses current router depth for rapid actions and suppresses unchanged selections", async () => {
		const router = createMemoryRouter([{ path: "*", element: null }], { initialEntries: ["/tasks"] });
		// Keep one controller instance while the router advances, as happens before
		// React commits a new render following a tab click.
		const navigation = createModalNavigation(() => router.state.location, router.navigate);
		navigation.open("ticket", "/tasks?ticket=TASK-1&tab=details");
		const opening = router.state.location.key;
		navigation.open("ticket", "/tasks?ticket=TASK-1&tab=details");
		expect(router.state.location.key).toBe(opening);
		navigation.select("/tasks?ticket=TASK-1&tab=history");
		const key = router.state.location.key;
		navigation.select("/tasks?ticket=TASK-1&tab=history");
		expect(router.state.location.key).toBe(key);
		navigation.select("/tasks?ticket=TASK-1&tab=cost");
		navigation.open("archive");
		navigation.dismiss();
		expect(navigationState(router.state.location).modal?.owner).toBe("ticket");
		expect(router.state.location.search).toContain("tab=cost");
		navigation.dismiss();
		expect(router.state.location.search).toBe("");
		await router.navigate(1);
		expect(router.state.location.search).toContain("tab=details");
		router.dispose();
	});

	it("retires a completed confirmation before Forward can restore it", async () => {
		const router = createMemoryRouter([{ path: "*", element: null }], { initialEntries: ["/tasks"] });
		const navigation = createModalNavigation(() => router.state.location, router.navigate);
		navigation.open("ticket", "/tasks?ticket=TASK-1&tab=details");
		navigation.select("/tasks?ticket=TASK-1&tab=history");
		navigation.open("archive");
		await navigation.completeConfirmation("ticket");
		expect(router.state.location.search).toBe("");
		await router.navigate(3);
		expect(navigationState(router.state.location).modal?.owner).toBe("ticket");
		navigation.dismiss();
		expect(router.state.location.search).toBe("");
		router.dispose();
	});

	it("returns past internal selections to the immediate modal parent", async () => {
		const router = createMemoryRouter([{ path: "*", element: null }], { initialEntries: ["/tasks?view=backlog"] });
		const epic = nextModal(router.state.location, "epic");
		await router.navigate("/tasks?view=backlog&epic=EPIC-1", { state: epic });
		const ticket = nextModal(router.state.location, "ticket");
		await router.navigate("/tasks?ticket=TASK-1&tab=details", { state: ticket });
		await router.navigate("/tasks?ticket=TASK-1&tab=chat", { state: advanceModal(ticket) });
		await router.navigate("/tasks?ticket=TASK-1&tab=history", { state: advanceModal(advanceModal(ticket)) });
		await router.navigate(-1);
		expect(router.state.location.search).toContain("tab=chat");
		await router.navigate(1);
		await router.navigate(-dismissalDepth(navigationState(router.state.location)));
		expect(router.state.location.search).toContain("epic=EPIC-1");
		await router.navigate(-1);
		expect(router.state.location.search).toBe("?view=backlog");
		router.dispose();
	});

	it("keeps confirmation ancestry and counts only the requested modal's entries", () => {
		const ticket = advanceModal(nextModal(location(), "ticket"));
		const confirmation = nextModal(location("?ticket=TASK-1&tab=chat", ticket), "archive");
		expect(dismissalDepth(confirmation)).toBe(1);
		expect(dismissalDepth(confirmation, "ticket")).toBe(3);
		expect(retainsModal(location("", confirmation), ticket.modal!.id)).toBe(true);
		expect(dismissalDepth(confirmation, "missing")).toBe(0);
	});

	it("initializes a direct link once and preserves its underlying task view", () => {
		const linked = location("?view=backlog&ticket=TASK-1&tab=history");
		const parent = directModalParent(linked)!;
		expect(parent.search).toBe("?view=backlog");
		const restored = { ...linked, state: nextModal(parent, "ticket") };
		expect(directModalParent(restored)).toBeUndefined();
		expect(directModalParent(location())).toBeUndefined();
		expect(directModalParent(location("?epic=EPIC-1"))?.search).toBe("");
	});

	it("cancelled Back retains the entry and completing it traverses exactly once", async () => {
		const router = createMemoryRouter([{ path: "*", element: null }], { initialEntries: ["/tasks"] });
		await router.navigate("/tasks", { state: nextModal(router.state.location, "create-ticket") });
		const key = router.state.location.key;
		router.getBlocker("draft", () => true);
		await router.navigate(-1);
		expect(router.state.location.key).toBe(key);
		router.state.blockers.get("draft")!.reset!();
		expect(router.state.location.key).toBe(key);
		await router.navigate(-1);
		router.state.blockers.get("draft")!.proceed!();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(navigationState(router.state.location).modal).toBeUndefined();
		router.dispose();
	});
});
