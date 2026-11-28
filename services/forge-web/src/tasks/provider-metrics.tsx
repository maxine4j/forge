import { costsSchema, type Costs } from "@forge/contracts";
import {
	modelProviderHealthListSchema,
	type ModelProvider,
	type ModelProviderHealth,
} from "@forge/contracts/model-providers";
import { ticketAgentMetricsSchema, type TicketAgentMetrics } from "@forge/contracts/tickets";
import { useCallback, useEffect, useRef, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { InterfaceIcon } from "../navigation/interface-icon.tsx";

type Result<T> = { value?: T; failed: boolean };

export function useProviderMetrics(api: IWorkspaceApi) {
	const refreshRef = useRef<() => void>(() => {});
	const [health, setHealth] = useState<Result<ModelProviderHealth[]>>({ failed: false });
	const [usage, setUsage] = useState<Result<Costs>>({ failed: false });
	const [scheduler, setScheduler] = useState<Result<TicketAgentMetrics>>({ failed: false });
	useEffect(() => {
		let active = true;
		const readHealth = () =>
			void api.read("model-providers/health", modelProviderHealthListSchema).then(
				(value) => {
					if (active) setHealth({ value, failed: false });
				},
				() => {
					if (active) setHealth((old) => ({ ...old, failed: true }));
				},
			);
		const readUsage = () =>
			void api.read("costs?range=-7d", costsSchema).then(
				(value) => {
					if (active) setUsage({ value, failed: false });
				},
				() => {
					if (active) setUsage((old) => ({ ...old, failed: true }));
				},
			);
		const readScheduler = () =>
			void api.read("tickets/agent-metrics", ticketAgentMetricsSchema).then(
				(value) => {
					if (active) setScheduler({ value, failed: false });
				},
				() => {
					if (active) setScheduler((old) => ({ ...old, failed: true }));
				},
			);
		const refresh = () => {
			readHealth();
			readUsage();
			readScheduler();
		};
		refreshRef.current = refresh;
		refresh();
		const interval = window.setInterval(() => {
			if (!document.hidden) readScheduler();
		}, 10000);
		const visibility = () => {
			if (!document.hidden) readScheduler();
		};
		document.addEventListener("visibilitychange", visibility);
		return () => {
			active = false;
			window.clearInterval(interval);
			document.removeEventListener("visibilitychange", visibility);
			refreshRef.current = () => {};
		};
	}, [api]);
	return { health, usage, scheduler, refresh: useCallback(() => refreshRef.current(), []) };
}

const stateLabel = <T,>(result: Result<T>) =>
	result.failed ? (result.value ? "Stale" : "Unavailable") : result.value ? "" : "Loading…";

const compactNumber = new Intl.NumberFormat("en-AU", { notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-AU", { style: "percent" });
const formatTokens = (count: number) => compactNumber.format(count).toLowerCase();

export function ProviderMetrics({
	providers,
	metrics,
}: {
	providers: ModelProvider[];
	metrics: ReturnType<typeof useProviderMetrics>;
}) {
	const active = providers.filter((provider) => !provider.retired);
	return (
		<section aria-label='Model providers'>
			<h3>Model providers</h3>
			<button type='button' onClick={metrics.refresh}>
				Refresh metrics
			</button>
			{!active.length && <p>Add a model provider in Config to configure agents.</p>}
			<div className='provider-metrics-grid'>
				{active.map((provider) => {
					const health = metrics.health.value?.find((row) => row.providerId === provider.id);
					const healthLabel =
						health?.status === "healthy"
							? "Healthy"
							: health?.status === "unhealthy"
								? "Unhealthy"
								: health?.status === "usage-limits-reached"
									? "Usage limits reached"
									: undefined;
					const scheduler = metrics.scheduler.value?.providers.find((row) => row.providerId === provider.id);
					const usage = metrics.usage.value?.providers.find((row) => row.id === provider.id);
					const running = scheduler?.running ?? 0;
					const reserved = scheduler?.reserved ?? 0;
					return (
						<article className='account-card provider-metrics-card' key={provider.id}>
							<div className='provider-metrics-heading'>
								<div className='provider-metrics-name'>
									<span role='img' aria-label={provider.kind === "openai" ? "OpenAI" : "Ollama"}>
										<InterfaceIcon name={provider.kind === "openai" ? "cloud" : "laptop"} />
									</span>
									<h4>{provider.name}</h4>
								</div>
								<span className='provider-metrics-health'>
									<span
										className={`provider-health-dot ${health?.status ?? "neutral"}`}
										aria-hidden='true'
									/>{" "}
									{healthLabel ?? (stateLabel(metrics.health) || "Unavailable")}
									{healthLabel && metrics.health.failed && " (Stale)"}
								</span>
							</div>
							{metrics.scheduler.value ? (
								<>
									<p>
										Running {running} / {provider.maxConcurrentAgents}{" "}
										{metrics.scheduler.failed && "(Stale)"}
									</p>
									<progress
										aria-label={`${provider.name} reserved capacity`}
										value={Math.min(reserved, provider.maxConcurrentAgents)}
										max={provider.maxConcurrentAgents}
									/>
									{reserved !== running && <p>{reserved} slots reserved</p>}
								</>
							) : (
								<p>Running: {stateLabel(metrics.scheduler)}</p>
							)}
							{provider.contextWindow && <p>Context window: {formatTokens(provider.contextWindow)}</p>}
							{provider.supportedConcurrency && (
								<p>Worker concurrency: {provider.supportedConcurrency.toLocaleString()}</p>
							)}
							{provider.compactionThresholdTokens && (
								<p>Compaction threshold: {formatTokens(provider.compactionThresholdTokens)} tokens</p>
							)}
							<h5>Last 7 days {metrics.usage.value && metrics.usage.failed && "(Stale)"}</h5>
							{!metrics.usage.value ? (
								<p>{stateLabel(metrics.usage)}</p>
							) : !usage ? (
								<p>Unavailable</p>
							) : usage.turns === 0 ? (
								<p>No recorded usage</p>
							) : (
								<>
									<p>Turns: {usage.turns.toLocaleString()}</p>
									<p>
										Input: {formatTokens(usage.input)}
										{usage.input > 0 && ` (${percent.format(usage.cached / usage.input)} cached)`}
									</p>
									<p>Output: {formatTokens(usage.output)}</p>
								</>
							)}
							{usage && usage.incompleteTokens > 0 && <p>Token usage is incomplete</p>}
						</article>
					);
				})}
			</div>
		</section>
	);
}
