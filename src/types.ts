import type { IGitRuntime } from "./repositories/git-transport.ts";
export interface StartOptions {
	/** Alternate composition tests can control the CLI boundary without changing HTTP/TLS policy. */
	git?: IGitRuntime;
}
