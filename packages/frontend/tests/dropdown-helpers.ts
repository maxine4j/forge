import { expect, type Locator } from "@playwright/test";

export async function chooseDropdown(trigger: Locator, value: string | { label: string }) {
	await trigger.click();
	const popup = trigger.page().locator(`[id="${await trigger.getAttribute("aria-controls")}"]`);
	await (
		typeof value === "string"
			? popup.locator(`[role="option"][data-value=${JSON.stringify(value)}]`)
			: popup.getByRole("option", { name: value.label, exact: true })
	).click();
}

export async function expectDropdownValue(trigger: Locator, value: string) {
	await trigger.click();
	const popup = trigger.page().locator(`[id="${await trigger.getAttribute("aria-controls")}"]`);
	const selected = popup.getByRole("option", { selected: true });
	await expect(selected).toHaveAttribute("data-value", value);
	await expect(trigger).toHaveText((await selected.textContent()) ?? "");
	await trigger.press("Escape");
}
