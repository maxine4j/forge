export class PipelineError extends Error {
	constructor(
		readonly code:
			| "pipeline-invalid"
			| "pipeline-busy"
			| "pipeline-not-found"
			| "pipeline-unavailable"
			| "docker-unavailable",
		readonly detail?: string,
	) {
		super(code);
	}
}
