export class ModelProviderError extends Error {
	constructor(
		readonly code:
			| "invalid-provider"
			| "provider-conflict"
			| "provider-not-found"
			| "provider-retired"
			| "provider-required",
	) {
		super(code);
		this.name = "ModelProviderError";
	}
}
