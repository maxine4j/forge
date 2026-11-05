import { createLogger } from "@forge/backend-infrastructure/logger";
import { bodyParser } from "@koa/bodyparser";
import type Router from "@koa/router";
import Koa from "koa";

import { AccessDeniedError, type IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import { InvalidProjectError, ProjectNotFoundError, ProjectUnavailableError } from "../projects/errors.ts";
import type { IProjectRouter } from "../projects/project-router.ts";
import { TicketError } from "../tickets/errors.ts";
import { WorkspaceError } from "../workspaces/errors.ts";
import type { IStaticAssets } from "./static-assets.ts";

export interface IHttpApplication {
	create(extensions?: IHttpRouter[], assets?: IStaticAssets): Koa;
}
export interface IHttpRouter {
	create(): Router<{ actor: Actor }>;
}
export class HttpApplication implements IHttpApplication {
	private readonly log = createLogger(HttpApplication.name);
	constructor(
		private readonly projectRouter: IProjectRouter,
		private readonly access: IAccessService,
		private readonly now: () => number = () => performance.now(),
	) {}
	create(extensions: IHttpRouter[] = [], assets?: IStaticAssets): Koa {
		const app = new Koa();
		app.use(async (ctx, next) => {
			const started = this.now();
			let failure: unknown;
			try {
				await next();
			} catch (err) {
				failure = err;
				const badBody = err instanceof Error && "status" in err && err.status === 400;
				const tooLarge = err instanceof Error && "status" in err && err.status === 413;
				if (err instanceof TicketError) {
					ctx.status =
						err.code === "invalid-request"
							? 400
							: err.code === "ticket-not-found"
								? 404
								: err.code === "ticket-conflict"
									? 409
									: 503;
					ctx.body = { error: err.code };
				} else if (err instanceof WorkspaceError) {
					ctx.status =
						err.code === "invalid-request"
							? 400
							: err.code === "workspace-not-found" || err.code === "file-not-found"
								? 404
								: err.code === "file-conflict" || err.code === "workspace-conflict"
									? 409
									: err.code === "file-unsupported"
										? 415
										: 503;
					ctx.body = { error: err.code };
				} else if (err instanceof AccessDeniedError) {
					ctx.status = 403;
					ctx.body = { error: "access-denied" };
				} else if (err instanceof InvalidProjectError || badBody || tooLarge) {
					ctx.status = tooLarge ? 413 : 400;
					ctx.body = { error: "invalid-request" };
				} else if (err instanceof ProjectNotFoundError) {
					ctx.status = 404;
					ctx.body = { error: "project-not-found" };
				} else if (err instanceof ProjectUnavailableError) {
					ctx.status = 503;
					ctx.body = { error: "project-unavailable" };
				} else {
					ctx.status = 500;
					ctx.body = { error: "internal-error" };
				}
			} finally {
				if (ctx.path !== "/health" || ctx.status >= 400) {
					this.log[ctx.status >= 500 ? "error" : ctx.status >= 400 ? "warn" : "info"](
						{
							err: failure,
							method: ctx.method,
							path: ctx.path,
							status: ctx.status,
							durationMs: Math.round(this.now() - started),
						},
						"Request completed",
					);
				}
			}
		});
		app.use(async (ctx, next) => {
			ctx.set("cache-control", "no-store");
			ctx.set("x-content-type-options", "nosniff");
			ctx.set(
				"content-security-policy",
				"default-src 'self'; style-src-elem 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
			);
			ctx.set("referrer-policy", "no-referrer");
			if (ctx.path === "/health" && ctx.method === "GET") {
				ctx.body = { status: "up" };
				return;
			}
			ctx.state["actor"] = this.access.authorize(
				ctx.headers["x-webauth-user"],
				ctx.headers["origin"],
				!["GET", "HEAD", "OPTIONS"].includes(ctx.method),
			);
			await next();
		});
		const ordinaryBody = bodyParser({ enableTypes: ["json"], jsonLimit: "16kb" });
		// JSON escapes can expand a valid 256 KiB text file by six times.
		const fileBody = bodyParser({ enableTypes: ["json"], jsonLimit: "2mb" });
		const commitBody = bodyParser({ enableTypes: ["json"], jsonLimit: "7mb" });
		app.use((ctx, next) =>
			/^\/api\/projects\/[^/]+\/repository\/commit$/u.test(ctx.path) && ctx.method === "POST"
				? commitBody(ctx, next)
				: /^\/api\/workspaces\/[^/]+\/file$/u.test(ctx.path) && ["POST", "PUT"].includes(ctx.method)
					? fileBody(ctx, next)
					: ordinaryBody(ctx, next),
		);
		const router = this.projectRouter.create();
		app.use(router.routes()).use(router.allowedMethods());
		for (const extension of extensions) {
			const routes = extension.create();
			app.use(routes.routes()).use(routes.allowedMethods());
		}
		app.use(async (ctx) => {
			if (assets && ["GET", "HEAD"].includes(ctx.method)) {
				const file = await assets.read(ctx.path);
				if (file) {
					ctx.type = file.type;
					ctx.set("cache-control", file.immutable ? "private, max-age=31536000, immutable" : "no-store");
					ctx.body = file.bytes;
					return;
				}
			}
			ctx.status = 404;
			ctx.body = { error: "not-found" };
		});
		return app;
	}
}
