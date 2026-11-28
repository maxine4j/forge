import { costsSchema, type Costs } from "@forge/contracts";
import {
	modelProviderHealthListSchema,
	relayMetricsListSchema,
	type ModelProvider,
	type ModelProviderHealth,
	type RelayMetrics,
} from "@forge/contracts/model-providers";
import { ticketAgentMetricsSchema, type TicketAgentMetrics } from "@forge/contracts/tickets";
import { useEffect, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import ollamaIcon from "../assets/ollama.svg";
import { InterfaceIcon } from "../navigation/interface-icon.tsx";

type Result<T> = { value?: T; failed: boolean };

export function useProviderMetrics(api: IWorkspaceApi) {
	const [health, setHealth] = useState<Result<ModelProviderHealth[]>>({ failed: false });
	const [usage, setUsage] = useState<Result<Costs>>({ failed: false });
	const [scheduler, setScheduler] = useState<Result<TicketAgentMetrics>>({ failed: false });
	const [relay, setRelay] = useState<Result<RelayMetrics[]>>({ failed: false });
	useEffect(() => {
		let active = true;
		let relayRequest = 0;
		const readRelay = () => {
			const request = ++relayRequest;
			void api.read("model-providers/relay-metrics", relayMetricsListSchema).then(
				(value) => { if (active && request === relayRequest) setRelay({ value, failed: false }); },
				() => { if (active && request === relayRequest) setRelay((old) => ({ ...old, failed: true })); },
			);
		};
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
		readHealth();
		readUsage();
		readScheduler();
		readRelay();
		const interval = window.setInterval(() => {
			if (!document.hidden) readScheduler();
		}, 10000);
		const visibility = () => {
			if (!document.hidden) { readScheduler(); readRelay(); }
		};
		const relayInterval = window.setInterval(() => { if (!document.hidden) readRelay(); }, 15000);
		document.addEventListener("visibilitychange", visibility);
		return () => {
			active = false;
			window.clearInterval(interval);
			window.clearInterval(relayInterval);
			document.removeEventListener("visibilitychange", visibility);
		};
	}, [api]);
	return { health, usage, scheduler, relay };
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
			<h2 className='task-agent-section-title'>Model providers</h2>
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
					const relay = metrics.relay.value?.find((row) => row.providerId === provider.id);
					const mac = relay?.macos;
					const running = scheduler?.running ?? 0;
					const reserved = scheduler?.reserved ?? 0;
					return (
						<article className='account-card provider-metrics-card' key={provider.id}>
							<div>
								<div className='provider-metrics-heading'>
									<div className='provider-metrics-name'>
										{provider.kind === "ollama" ? (
											<img src={ollamaIcon} alt='Ollama' width='16' height='16' />
										) : (
											<span role='img' aria-label='OpenAI'>
												<InterfaceIcon name='cloud' />
											</span>
										)}
										<h3>{provider.name}</h3>
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
										<div className='provider-metrics-capacity'>
											<progress
												aria-label={`${provider.name} reserved capacity`}
												aria-describedby={`provider-capacity-${provider.id}`}
												value={Math.min(reserved, provider.maxConcurrentAgents)}
												max={provider.maxConcurrentAgents}
											/>
											<span id={`provider-capacity-${provider.id}`}>
												Running {running} / {provider.maxConcurrentAgents}
												{metrics.scheduler.failed && " (Stale)"}
											</span>
										</div>
										{reserved !== running && <p>{reserved} slots reserved</p>}
									</>
								) : (
									<p>Running: {stateLabel(metrics.scheduler)}</p>
								)}
								{provider.contextWindow && (
									<p>Context window: {formatTokens(provider.contextWindow)}</p>
								)}
								{provider.supportedConcurrency && (
									<p>Worker concurrency: {provider.supportedConcurrency.toLocaleString()}</p>
								)}
								{provider.compactionThresholdTokens && (
									<p>
										Compaction threshold: {formatTokens(provider.compactionThresholdTokens)} tokens
									</p>
								)}
							</div>
							<div>
								<h4 className='provider-metrics-period'>
									Last 7 days {metrics.usage.value && metrics.usage.failed && "(Stale)"}
								</h4>
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
											{usage.input > 0
												&& ` (${percent.format(usage.cached / usage.input)} cached)`}
										</p>
										<p>Output: {formatTokens(usage.output)}</p>
									</>
								)}
								{usage && usage.incompleteTokens > 0 && <p>Token usage is incomplete</p>}
								{relay && <p>Relay metrics: {metrics.relay.failed ? "stale" : relay.freshness}{relay.receivedAt && ` · ${new Date(relay.receivedAt).toLocaleString()}`}</p>}
								{mac && <>
									<h4>macOS</h4>
									<p>GPU usage: {mac.gpuUtilization == null ? "Unavailable" : `${mac.gpuUtilization}%`}</p>
									<p>System memory used / total: {mac.memory ? `${((mac.memory.total - mac.memory.free) / 1073741824).toFixed(1)} / ${(mac.memory.total / 1073741824).toFixed(1)} GiB` : "Unavailable"}</p>
									<p>Chip: {mac.chipName ?? "Unavailable"}</p>
									<p>Device model: {mac.deviceModel ?? "Unavailable"}</p>
									{mac.batteryPercent != null && <p>Battery: {mac.batteryPercent}%</p>}
									<p>Power source: {mac.powerSource ?? "Unavailable"}</p>
									<p>CPU / GPU / ANE power: {mac.powerWatts == null ? "Unavailable" : `${mac.powerWatts} W`}</p>
									<p>macOS version: {mac.macosVersion ?? "Unavailable"}</p>
									<p>Ollama version: {mac.ollamaVersion ?? "Unavailable"}</p>
								</>}
							</div>
						</article>
					);
				})}
			</div>
		</section>
	);
}
