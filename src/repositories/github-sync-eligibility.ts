export const isForgeGithubSource = (source?: string): boolean =>
	/^https:\/\/github\.com(?::443)?\/maxine4j\/forge(?:\.git)?\/?$/iu.test(source ?? "");
