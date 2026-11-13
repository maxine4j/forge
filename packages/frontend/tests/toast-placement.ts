import { expect, type Page } from "@playwright/test";

export const expectToastPlacement = async (page: Page, width: number, bottom: number) => {
	const viewport = page.locator(".forge-toast-viewport:popover-open");
	await expect(viewport).toBeVisible();
	await expect
		.poll(async () => {
			const box = (await viewport.boundingBox())!;
			const composer = page.locator(".agent-composer:visible");
			const anchor = await composer.boundingBox();
			const expected = width <= 600 && anchor ? anchor.y - 8 : bottom - 16;
			return Math.round(expected - (box.y + box.height));
		})
		.toBe(0);
};
