export class InvalidProjectError extends Error {
	constructor() {
		super("Invalid project request");
		this.name = "InvalidProjectError";
	}
}
export class ProjectNotFoundError extends Error {
	constructor() {
		super("Project not found");
		this.name = "ProjectNotFoundError";
	}
}
export class ProjectUnavailableError extends Error {
	constructor(options?: ErrorOptions) {
		super("Project repository unavailable", options);
		this.name = "ProjectUnavailableError";
	}
}
export class ProjectStorageError extends Error {
	constructor(options?: ErrorOptions) {
		super("Project storage unavailable", options);
		this.name = "ProjectStorageError";
	}
}
