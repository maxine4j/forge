import {
	accountsStatusSchema,
	accountStatusSchema,
	apiErrorSchema,
	createProjectSchema,
	projectIdSchema,
	projectSchema,
	projectsSchema,
} from "@forge/contracts";
import type { AccountProvider, AccountStatus, AccountsStatus, CreateProject, Project } from "@forge/contracts";

export interface IApiClient {
	projects(signal?: AbortSignal): Promise<Project[]>;
	create(input: CreateProject, signal?: AbortSignal): Promise<Project>;
	retry(id: string, signal?: AbortSignal): Promise<Project>;
	accounts(signal?: AbortSignal): Promise<AccountsStatus>;
	account(
		provider: AccountProvider,
		action: "login" | "retry" | "cancel",
		signal?: AbortSignal,
	): Promise<AccountStatus>;
}
export class ApiClient implements IApiClient {
	constructor(private readonly request: typeof fetch) {}
	projects(signal?: AbortSignal): Promise<Project[]> {
		return this.read("/api/projects", projectsSchema, undefined, signal);
	}
	create(input: CreateProject, signal?: AbortSignal): Promise<Project> {
		return this.read("/api/projects", projectSchema, createProjectSchema.parse(input), signal);
	}
	retry(id: string, signal?: AbortSignal): Promise<Project> {
		return this.read(`/api/projects/${projectIdSchema.parse(id)}/retry`, projectSchema, {}, signal);
	}
	async accounts(signal?: AbortSignal): Promise<AccountsStatus> {
		const value = await this.read("/api/accounts", accountsStatusSchema, undefined, signal);
		this.validateAccount("codex", value.codex);
		this.validateAccount("github", value.github);
		return value;
	}
	async account(
		provider: AccountProvider,
		action: "login" | "retry" | "cancel",
		signal?: AbortSignal,
	): Promise<AccountStatus> {
		const value = await this.read(`/api/accounts/${provider}/${action}`, accountStatusSchema, {}, signal);
		this.validateAccount(provider, value);
		return value;
	}
	private validateAccount(provider: AccountProvider, value: AccountStatus): void {
		const { state, verificationUrl, userCode } = value.login;
		const expected =
			provider === "codex" ? "https://auth.openai.com/codex/device" : "https://github.com/login/device";
		if (
			state === "pending"
				? !userCode || verificationUrl !== expected
				: verificationUrl !== undefined || userCode !== undefined
		)
			throw new Error("Unexpected server response. Refresh and try again.");
	}
	private async read<T>(
		path: string,
		schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
		body?: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		let response: Response;
		try {
			response = await this.request(path, {
				method: body === undefined ? "GET" : "POST",
				credentials: "same-origin",
				headers: {
					accept: "application/json",
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal,
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new Error("Cannot reach Forge. Check your connection and try again.");
		}
		const value: unknown = await response.json().catch(() => undefined);
		if (!response.ok) {
			const failure = apiErrorSchema.safeParse(value);
			const messages = {
				"access-denied": "Access denied. Sign in through PaaS with the configured owner account.",
				"invalid-request": "Check the project name and credential-free HTTPS import URL.",
				"project-not-found": "Project no longer exists. Refresh the list.",
				"project-unavailable":
					"Project operation failed. Check server storage and import-host configuration, then retry.",
				"internal-error": "Request failed. Try again.",
				"workspace-not-found": "Workspace no longer exists. Refresh the list.",
				"workspace-unavailable": "Workspace unavailable. Check its status and server storage.",
				"workspace-conflict": "Workspace changed. Refresh before retrying.",
				"file-not-found": "File no longer exists. Refresh the file tree.",
				"file-conflict": "File changed. Reload it before saving.",
				"file-unsupported": "File is binary, too large, or unsupported.",
			};
			throw new Error(failure.success ? messages[failure.data.error] : "Request failed. Try again.");
		}
		const result = schema.safeParse(value);
		if (!result.success) throw new Error("Unexpected server response. Refresh and try again.");
		return result.data;
	}
}
