import { z } from "zod";

/** Configure before loading browser schemas; never probe eval under the production CSP. */
export const configureBrowserValidation = (): void => {
	z.config({ jitless: true });
};
