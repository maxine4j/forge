import { agentViewSchema, type AgentItem, type AgentView } from "@forge/contracts/agents";
import { ticketWorkflowSchema, type TicketWorkflow } from "@forge/contracts/tickets";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { ResourcePoller } from "../api/resource-poller.ts";
import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { useErrorState, useFailureToast } from "../toasts/toasts.tsx";
import { AgentActivity } from "./agent-activity.tsx";
import { AgentComposer } from "./agent-composer.tsx";
import { AgentPerformanceStat } from "./agent-performance.tsx";
import { RequestCard } from "./request-card.tsx";

type ConversationScroll = {
	top: number;
	follow: boolean;
	unseen?: boolean;
	activity?: Map<string, string>;
};
type EarlierThread = { id: string; planText?: string; planMarkdown?: string };

const withSavedPlan = (items: AgentItem[], planText?: string): AgentItem[] => {
	if (!planText || items.some((item) => item.kind === "plan" && item.text.trim() === planText.trim())) return items;
	return [...items, { id: "saved-plan", role: "assistant", kind: "plan", text: planText }];
};

export const Conversation = ({
	id,
	api,
	changed,
	selected,
	messagePath,
	blocked = false,
	readOnly = false,
	drafts,
	workflowChanged,
	draftKey = id,
	earlier,
	prefix,
	suffix,
	steer = false,
	planText,
	planMarkdown,
	feedbackPending,
	planAction,
	snapshots,
	scrollStates,
	navigation,
}: {
	id: string;
	api: IWorkspaceApi;
	changed: () => void;
	selected: boolean;
	messagePath?: string;
	blocked?: boolean;
	readOnly?: boolean;
	drafts?: Map<string, string>;
	workflowChanged?: (job: TicketWorkflow) => void;
	draftKey?: string;
	earlier?: { threads: EarlierThread[]; snapshots: Map<string, AgentView> };
	prefix?: ReactNode;
	suffix?: ReactNode;
	steer?: boolean;
	planText?: string;
	planMarkdown?: string;
	feedbackPending?: (pending: boolean) => void;
	planAction?: ReactNode;
	snapshots?: Map<string, AgentView>;
	scrollStates?: Map<string, ConversationScroll>;
	navigation?: ReactNode;
}) => {
	const [view, setView] = useState<AgentView | undefined>(() => snapshots?.get(id));
	const [draft, setDraft] = useState(() => drafts?.get(draftKey) ?? "");
	const messages = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const earlierContent = useRef<HTMLDivElement>(null);
	const loadMoreButton = useRef<HTMLButtonElement>(null);
	const earlierRequest = useRef<AbortController>(undefined);
	const prepend = useRef<{ height: number; wasShort: boolean }>(undefined);
	const [earlierViews, setEarlierViews] = useState(() => new Map(earlier?.snapshots));
	const [loadingEarlier, setLoadingEarlier] = useState(false);
	const [earlierFailed, setEarlierFailed] = useState(false);
	const nextEarlier = earlier?.threads.findLast(({ id }) => !earlierViews.has(id));
	const scrollState = scrollStates?.get(id);
	const position = useRef<ConversationScroll>(scrollState ?? { top: 0, follow: true });
	const [following, setFollowing] = useState(scrollState?.follow ?? true);
	const [unseen, setUnseen] = useState(scrollState?.unseen ?? false);
	useLayoutEffect(() => {
		scrollStates?.set(id, position.current);
	}, [id, scrollStates]);
	useLayoutEffect(() => {
		if (!view) return;
		const previous = position.current.activity;
		if (previous && !position.current.follow && view.items.some((item) => previous.get(item.id) !== item.text)) {
			position.current.unseen = true;
			setUnseen(true);
		}
		position.current.activity = new Map(view.items.map((item) => [item.id, item.text]));
	}, [view]);
	const resumeFollowing = () => {
		position.current.follow = true;
		position.current.unseen = false;
		setFollowing(true);
		setUnseen(false);
		scroll();
	};
	const scroll = () => {
		const element = messages.current;
		if (element && element.clientHeight > 0)
			element.scrollTop = position.current.follow ? element.scrollHeight : position.current.top;
	};
	useLayoutEffect(() => {
		const viewport = messages.current;
		const anchor = prepend.current;
		prepend.current = undefined;
		if (!anchor || !earlierContent.current || !viewport?.clientHeight) return;
		if (anchor.wasShort && viewport.scrollHeight > viewport.clientHeight) {
			position.current.follow = false;
			setFollowing(false);
		} else if (!position.current.follow) {
			position.current.top += earlierContent.current.getBoundingClientRect().height - anchor.height;
		}
	}, [earlierViews]);
	useLayoutEffect(() => {
		scroll();
	});
	useEffect(() => {
		const observer = new ResizeObserver(scroll);
		if (content.current) observer.observe(content.current);
		if (messages.current) observer.observe(messages.current);
		return () => observer.disconnect();
	}, []);
	useEffect(() => () => earlierRequest.current?.abort(), []);
	const loadEarlier = async () => {
		if (!earlier || !nextEarlier || earlierRequest.current) return;
		const request = new AbortController();
		const { signal } = request;
		earlierRequest.current = request;
		setLoadingEarlier(true);
		setEarlierFailed(false);
		try {
			const path = `agents/${nextEarlier.id}`;
			let snapshot = await api.read(path, agentViewSchema, "GET", undefined, signal);
			if (!signal.aborted && !["idle", "creating", "running", "waiting"].includes(snapshot.thread.status))
				snapshot = await api.read(`${path}/resume`, agentViewSchema, "POST", {}, signal);
			if (signal.aborted) return;
			if (snapshot.thread.status === "uncertain") throw new Error("History recovery incomplete");
			const viewport = messages.current;
			if (viewport?.clientHeight && earlierContent.current) {
				position.current.top = viewport.scrollTop;
				prepend.current = {
					height: earlierContent.current.getBoundingClientRect().height,
					wasShort: viewport.scrollHeight <= viewport.clientHeight,
				};
			}
			if (
				document.activeElement === loadMoreButton.current
				&& earlier.threads.every(({ id }) => id === nextEarlier.id || earlierViews.has(id))
			)
				viewport?.focus({ preventScroll: true });
			earlier.snapshots.set(nextEarlier.id, snapshot);
			setEarlierViews((previous) => new Map(previous).set(nextEarlier.id, snapshot));
		} catch {
			if (!signal.aborted) setEarlierFailed(true);
		} finally {
			earlierRequest.current = undefined;
			if (!signal.aborted) setLoadingEarlier(false);
		}
	};
	const [, setError] = useErrorState();
	const [busy, setBusy] = useState(false);
	const [connected, setConnected] = useState(false);
	const poller = useRef<ResourcePoller<AgentView> | undefined>(undefined);
	const acting = useRef(false);
	const [loadingHistory, setLoadingHistory] = useState(true);
	const [historyFailed, setHistoryFailed] = useState(false);
	const historyNeeded = useRef(true);
	const recoveryBlocked = useRef(false);
	const selection = useRef(selected);
	useEffect(() => {
		const resource = new ResourcePoller(
			async (signal) => {
				if (selection.current && historyNeeded.current) setLoadingHistory(true);
				const value = await api.read(`agents/${id}`, agentViewSchema);
				if (signal.aborted) return value;
				if (!selection.current || recoveryBlocked.current) return value;
				const status = value.thread.status;
				const recover = historyNeeded.current || status === "uncertain";
				historyNeeded.current = false;
				if (!recover || ["idle", "creating", "running", "waiting"].includes(status)) return value;
				setLoadingHistory(true);
				try {
					const recovered = await api.read(`agents/${id}/resume`, agentViewSchema, "POST", {});
					if (recovered.thread.status === "uncertain") throw new Error("History recovery incomplete");
					if (!signal.aborted) {
						historyNeeded.current = false;
						setHistoryFailed(false);
						setError("");
					}
					return recovered;
				} catch {
					recoveryBlocked.current = true;
					if (!signal.aborted) {
						setHistoryFailed(true);
						setError(
							"Could not load chat history. Retry loading history, or create a new chat if recovery keeps failing. This chat’s work is retained.",
						);
					}
					return value;
				}
			},
			(value) => {
				snapshots?.set(id, value);
				setView(value);
				setLoadingHistory(false);
				changed();
			},
			(message) => {
				setLoadingHistory(false);
				setError(message);
			},
		);
		poller.current = resource;
		resource.refresh();
		const events = new EventSource(`/api/agents/${id}/events`);
		events.onopen = () => {
			setConnected(true);
			resource.refresh();
		};
		events.onmessage = () => resource.refresh();
		events.onerror = () => {
			setConnected(false);
			resource.refresh();
		};
		return () => {
			resource.stop();
			events.close();
			poller.current = undefined;
		};
	}, [api, id, changed, snapshots, setError]);
	useEffect(() => {
		selection.current = selected;
		if (!selected) return;
		historyNeeded.current = true;
		recoveryBlocked.current = false;
		poller.current?.refresh();
	}, [selected]);
	const act = (suffix: string, body: unknown, sent = false) => {
		if (acting.current || !poller.current || readOnly) return;
		acting.current = true;
		if (sent && messagePath) feedbackPending?.(true);
		setBusy(true);
		setError("");
		void poller.current
			.mutate(async () => {
				try {
					let value: AgentView;
					if (suffix === "messages" && messagePath) {
						const job = await api.read(messagePath, ticketWorkflowSchema, "POST", body);
						workflowChanged?.(job);
						value = await api.read(`agents/${id}`, agentViewSchema);
					} else value = await api.read(`agents/${id}/${suffix}`, agentViewSchema, "POST", body);
					if (sent) {
						setDraft("");
						drafts?.delete(draftKey);
					}
					return value;
				} finally {
					// Refresh may reload history, but never replays messages or approval replies.
					poller.current?.refresh();
				}
			})
			.finally(() => {
				if (sent && messagePath) feedbackPending?.(false);
				acting.current = false;
				setBusy(false);
			});
	};
	const status = view?.thread.status;
	const ticketChat = Boolean(messagePath);
	const active = status === "running" || status === "waiting";
	const sendable =
		ticketChat
		&& status
		&& !blocked
		&& !readOnly
		&& !loadingHistory
		&& !historyFailed
		&& (!steer || !view?.requests.length)
		&& (steer ? status === "running" : !["creating", "running", "waiting", "uncertain"].includes(status));
	const eligiblePlanAction =
		!busy && !blocked && !loadingHistory && !historyFailed && status === "completed" && planAction;
	const displayStatus = status === "uncertain" ? (historyFailed ? "unavailable" : "loading") : status;
	const failureNotice =
		view?.turnFailure === "provider-request"
			? "The model request failed. Check that Forge can reach the inference endpoint and that the selected model supports Codex requests."
			: view?.turnFailure === "context-window"
				? "This turn exceeded the model's context window. Try a shorter prompt or start a new chat."
				: "Codex could not complete this turn.";
	useFailureToast(selected && status === "failed" ? failureNotice : undefined, view?.thread.turnId);
	return (
		<section className='agent-conversation' aria-label='Chat conversation'>
			{(!ticketChat || historyFailed) && (
				<div className='agent-chat-heading'>
					{navigation}
					{!ticketChat && (
						<div>
							<span className={`agent-status agent-status-${displayStatus}`}>
								{displayStatus ?? "loading"}
							</span>
						</div>
					)}
					<div className='agent-actions'>
						{historyFailed && (
							<button
								disabled={busy || loadingHistory}
								onClick={() => {
									recoveryBlocked.current = false;
									historyNeeded.current = true;
									setLoadingHistory(true);
									setError("");
									poller.current?.refresh();
								}}
							>
								Retry loading history
							</button>
						)}
						{!ticketChat && active && !readOnly && (
							<button disabled={busy || !view?.thread.turnId} onClick={() => act("interrupt", {})}>
								Interrupt
							</button>
						)}
					</div>
				</div>
			)}
			{!connected && (
				<p className='agent-notice' role='status'>
					Reconnecting to live updates…
				</p>
			)}

			{loadingHistory && (
				<p className='agent-notice' role='status'>
					Loading history…
				</p>
			)}
			{!ticketChat && view?.truncated && <p className='agent-notice'>Some history or output was omitted.</p>}
			<div className='agent-history'>
				<div
					ref={messages}
					onScroll={() => {
						const element = messages.current;
						if (element && element.clientHeight > 0) {
							position.current.top = element.scrollTop;
							position.current.follow =
								element.scrollHeight - element.scrollTop - element.clientHeight < 80;
							setFollowing(position.current.follow);
							if (position.current.follow) {
								position.current.unseen = false;
								setUnseen(false);
							}
						}
					}}
					className='agent-messages'
					tabIndex={0}
					aria-label='Conversation history'
				>
					<div ref={content}>
						{earlier?.threads.length ? (
							<div ref={earlierContent} className='agent-earlier-history'>
								{nextEarlier && (
									<div className='agent-load-more'>
										<button
											ref={loadMoreButton}
											type='button'
											aria-disabled={loadingEarlier}
											onClick={loadEarlier}
										>
											{loadingEarlier ? "Loading…" : "Load more"}
										</button>
										{earlierFailed && (
											<p role='status'>Could not load earlier messages. Try again.</p>
										)}
									</div>
								)}
								{earlier.threads.map(({ id, planText, planMarkdown }) => {
									const snapshot = earlierViews.get(id);
									if (!snapshot) return null;
									return (
										<AgentActivity
											key={id}
											items={withSavedPlan(snapshot.items, planText)}
											planText={planText}
											planMarkdown={planMarkdown}
										/>
									);
								})}
							</div>
						) : undefined}
						{prefix}
						{view
							&& !messagePath
							&& !loadingHistory
							&& !historyFailed
							&& status !== "uncertain"
							&& !view.items.length && (
								<p className='agent-empty'>
									Start a conversation about this repository. Each chat works in its own managed
									worktree.
								</p>
							)}
						<AgentActivity
							items={withSavedPlan(view?.items ?? [], view && !loadingHistory ? planText : undefined)}
							planText={planText}
							planMarkdown={planMarkdown}
							planAction={eligiblePlanAction}
						/>
						{suffix}

						{!ticketChat && active && (
							<p
								className={`agent-notice ${status === "running" ? "agent-working-highlight" : ""}`}
								role='status'
							>
								{status === "waiting" ? "Waiting for your response" : "Codex is working…"}
							</p>
						)}
						{!readOnly
							&& view?.requests.map((request) => (
								<RequestCard
									key={request.id}
									request={request}
									drafts={drafts}
									busy={busy || readOnly}
									reply={(input) => act("replies", input)}
								/>
							))}
					</div>
				</div>
				{!following && (
					<button
						type='button'
						className={`agent-scroll-latest${unseen ? " agent-scroll-unseen" : ""}`}
						aria-label='Scroll to latest'
						onClick={resumeFollowing}
					>
						<svg
							width='20'
							height='20'
							viewBox='0 0 24 24'
							fill='none'
							stroke='currentColor'
							strokeWidth='1.8'
							strokeLinecap='round'
							strokeLinejoin='round'
							aria-hidden='true'
						>
							<path d='M12 4v16m-6-6 6 6 6-6' />
						</svg>
					</button>
				)}
			</div>
			{view && <AgentPerformanceStat key={view.thread.turnId ?? view.thread.status} view={view} />}
			{view && (
				<AgentComposer
					id={id}
					api={api}
					draft={draft}
					disabled={busy || readOnly}
					sendable={Boolean(sendable)}
					interrupt={
						ticketChat && active && !readOnly
							? { action: () => act("interrupt", {}), disabled: !view.thread.turnId }
							: undefined
					}
					completions={!readOnly}
					contextWindow={messagePath ? view.contextWindow : undefined}
					compactionThresholdTokens={view.compactionThresholdTokens}
					change={(value) => {
						setDraft(value);
						drafts?.set(draftKey, value);
					}}
					send={() =>
						act(
							"messages",
							{
								text: draft,
								...(steer && status === "running" ? { expectedTurnId: view.thread.turnId } : {}),
							},
							true,
						)
					}
				/>
			)}
		</section>
	);
};
