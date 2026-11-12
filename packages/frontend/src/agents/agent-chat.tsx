import {
	agentThreadsSchema,
	agentViewSchema,
	type AgentRequest,
	type AgentReply,
	type AgentThread,
	type AgentView,
} from "@forge/contracts/agents";
import { ticketWorkflowSchema, type TicketWorkflow } from "@forge/contracts/tickets";
import { createContext, useContext, useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { ResourcePoller } from "../api/resource-poller.ts";
import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { resolveRoute } from "../navigation/routes.ts";
import { AgentActivity } from "./agent-activity.tsx";
import { AgentComposer } from "./agent-composer.tsx";

type ConversationScroll = {
	top: number;
	follow: boolean;
	unseen?: boolean;
	activity?: Map<string, Map<string, string>>;
};
const TimelineActivity = createContext<((id: string, view: AgentView) => void) | undefined>(undefined);

const RequestCard = ({
	request,
	busy,
	reply,
	drafts,
}: {
	request: AgentRequest;
	busy: boolean;
	reply: (input: AgentReply) => void;
	drafts?: Map<string, string>;
}) => {
	const [answers, setAnswers] = useState<Record<string, string>>(() =>
		Object.fromEntries(
			request.questions.map((question) => [
				question.id,
				drafts?.get(`request:${request.id}:${question.id}`) ?? "",
			]),
		),
	);
	const answer = (id: string, value: string) => {
		setAnswers((current) => ({ ...current, [id]: value }));
		drafts?.set(`request:${request.id}:${id}`, value);
	};
	const formId = useId();
	return (
		<form
			className='agent-request'
			onSubmit={(event) => {
				event.preventDefault();
				reply({ requestId: request.id, answers });
			}}
		>
			<h4>
				{request.kind === "input"
					? "Input requested"
					: request.kind === "file"
						? "File change approval"
						: "Command approval"}
			</h4>
			<pre>{request.description}</pre>
			{request.questions.map((question, index) => (
				<div key={question.id} className='agent-question'>
					<label htmlFor={`${formId}-${index}`}>{question.question}</label>
					{question.secret ? (
						<input
							id={`${formId}-${index}`}
							type='password'
							required
							maxLength={4000}
							value={answers[question.id] ?? ""}
							onChange={(event) => answer(question.id, event.target.value)}
							disabled={busy}
						/>
					) : (
						<textarea
							id={`${formId}-${index}`}
							required
							maxLength={4000}
							value={answers[question.id] ?? ""}
							onChange={(event) => answer(question.id, event.target.value)}
							disabled={busy}
							rows={2}
						/>
					)}
					{!question.secret && (
						<div className='agent-actions'>
							{question.options.map((option) => (
								<button
									key={option}
									type='button'
									disabled={busy}
									onClick={() => answer(question.id, option)}
								>
									{option}
								</button>
							))}
						</div>
					)}
				</div>
			))}
			<div className='agent-actions'>
				{request.kind === "input" ? (
					<button disabled={busy || request.questions.some((question) => !answers[question.id]?.trim())}>
						Submit answers
					</button>
				) : (
					<>
						<button
							type='button'
							disabled={busy}
							onClick={() => reply({ requestId: request.id, decision: "accept" })}
						>
							Allow once
						</button>
						<button
							type='button'
							disabled={busy}
							onClick={() => reply({ requestId: request.id, decision: "decline" })}
						>
							Decline
						</button>
					</>
				)}
			</div>
		</form>
	);
};

export const Conversation = ({
	id,
	api,
	changed,
	selected,
	messagePath,
	executionSettings,
	settingsChanged,
	settingsDisabled,
	blocked = false,
	readOnly = false,
	drafts,
	workflowChanged,
	draftKey = id,
	historyOnly = false,
	prefix,
	suffix,
	steer = false,
	planText,
	planAction,
	snapshots,
	scrollState,
	navigation,
}: {
	id: string;
	api: IWorkspaceApi;
	changed: () => void;
	selected: boolean;
	messagePath?: string;
	executionSettings?: import("@forge/contracts/agents").AgentSettings;
	settingsChanged?: (settings: import("@forge/contracts/agents").AgentSettings) => void;
	settingsDisabled?: boolean;
	blocked?: boolean;
	readOnly?: boolean;
	drafts?: Map<string, string>;
	workflowChanged?: (job: TicketWorkflow) => void;
	draftKey?: string;
	historyOnly?: boolean;
	prefix?: ReactNode;
	suffix?: ReactNode;
	steer?: boolean;
	planText?: string;
	planAction?: ReactNode;
	snapshots?: Map<string, AgentView>;
	scrollState?: ConversationScroll;
	navigation?: ReactNode;
}) => {
	const [view, setView] = useState<AgentView | undefined>(() => snapshots?.get(id));
	const [draft, setDraft] = useState(() => drafts?.get(draftKey) ?? "");
	const messages = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const position = useRef<ConversationScroll>(scrollState ?? { top: 0, follow: true });
	const [following, setFollowing] = useState(scrollState?.follow ?? true);
	const [unseen, setUnseen] = useState(scrollState?.unseen ?? false);
	const parentActivity = useContext(TimelineActivity);
	const recordActivity = (threadId: string, value: AgentView) => {
		const histories = (position.current.activity ??= new Map());
		const previous = histories.get(threadId);
		const next = new Map(value.items.map((item) => [item.id, item.text]));
		if (
			(previous || histories.size > 0)
			&& value.items.some((item) => !previous?.has(item.id) || previous.get(item.id) !== item.text)
		) {
			if (!position.current.follow) {
				position.current.unseen = true;
				setUnseen(true);
			}
		}
		histories.set(threadId, next);
	};
	useLayoutEffect(() => {
		if (view) (historyOnly ? parentActivity : recordActivity)?.(id, view);
	});
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
		scroll();
	});
	useEffect(() => {
		const observer = new ResizeObserver(scroll);
		if (content.current) observer.observe(content.current);
		if (messages.current) observer.observe(messages.current);
		return () => observer.disconnect();
	}, []);
	const [error, setError] = useState("");
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
	}, [api, id, changed, snapshots]);
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
				acting.current = false;
				setBusy(false);
			});
	};
	const status = view?.thread.status;
	const active = status === "running" || status === "waiting";
	const sendable =
		status
		&& !blocked
		&& !readOnly
		&& !loadingHistory
		&& !historyFailed
		&& (!steer || !view?.requests.length)
		&& (steer ? status === "running" : !["creating", "running", "waiting", "uncertain"].includes(status));
	const eligiblePlanAction =
		!busy && !blocked && !loadingHistory && !historyFailed && status === "completed" && planAction;
	const displayStatus = status === "uncertain" ? (historyFailed ? "unavailable" : "loading") : status;
	if (historyOnly)
		return (
			<>
				{error && (
					<p role='alert' className='error'>
						{error}
					</p>
				)}
				{historyFailed && (
					<button
						disabled={loadingHistory}
						onClick={() => {
							recoveryBlocked.current = false;
							historyNeeded.current = true;
							poller.current?.refresh();
						}}
					>
						Retry loading history
					</button>
				)}
				{loadingHistory && <p role='status'>Loading planning history…</p>}
				{view?.truncated && <p className='agent-notice'>Some history or output was omitted.</p>}
				<AgentActivity items={view?.items ?? []} />
			</>
		);
	return (
		<section className='agent-conversation' aria-label='Chat conversation'>
			<div className='agent-chat-heading'>
				{navigation}
				<div>
					<span className={`agent-status agent-status-${displayStatus}`}>{displayStatus ?? "loading"}</span>
				</div>
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
					{active && !readOnly && (
						<button disabled={busy || !view?.thread.turnId} onClick={() => act("interrupt", {})}>
							Interrupt
						</button>
					)}
				</div>
			</div>
			{!connected && (
				<p className='agent-notice' role='status'>
					Reconnecting to live updates…
				</p>
			)}
			{error && (
				<p className='error' role='alert'>
					{error}
				</p>
			)}
			{loadingHistory && (
				<p className='agent-notice' role='status'>
					Loading history…
				</p>
			)}
			{view?.truncated && <p className='agent-notice'>Some history or output was omitted.</p>}
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
						<TimelineActivity.Provider value={recordActivity}>
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
								items={view?.items ?? []}
								planText={planText}
								planAction={eligiblePlanAction}
							/>
							{planText
								&& view
								&& !loadingHistory
								&& !view.items.some((item) => item.kind === "plan") && (
									<AgentActivity
										items={[{ id: "saved-plan", role: "assistant", kind: "plan", text: planText }]}
										planText={planText}
										planAction={eligiblePlanAction}
									/>
								)}
							{suffix}
							{active && (
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
						</TimelineActivity.Provider>
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
			{view && (
				<AgentComposer
					id={id}
					api={api}
					draft={draft}
					disabled={busy || readOnly}
					sendable={Boolean(sendable)}
					settings={executionSettings ?? view.thread}
					settingsChanged={settingsChanged}
					settingsDisabled={settingsDisabled}
					completions={!readOnly}
					contextWindow={messagePath ? view.contextWindow : undefined}
					configurable={!readOnly}
					change={(value) => {
						setDraft(value);
						drafts?.set(draftKey, value);
					}}
					send={(settings) =>
						act(
							"messages",
							{
								text: draft,
								...(steer && status === "running" ? { expectedTurnId: view.thread.turnId } : {}),
								...(!messagePath ? settings : {}),
							},
							true,
						)
					}
				/>
			)}
		</section>
	);
};

export const AgentChat = ({ projectId, api }: { projectId: string; api: IWorkspaceApi }) => {
	const location = useLocation();
	const navigate = useNavigate();
	const route = resolveRoute(location.pathname);
	const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 700px)").matches);
	useEffect(() => {
		const query = window.matchMedia("(max-width: 700px)");
		const update = () => setMobile(query.matches);
		query.addEventListener("change", update);
		update();
		return () => query.removeEventListener("change", update);
	}, []);
	const selectFirst = route.page === "repo" && route.section === "agents" && !route.threadId;
	const [threads, setThreads] = useState<AgentThread[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [opened, setOpened] = useState<string[]>([]);
	const [retained, setRetained] = useState("");
	const selected = route.page === "repo" && route.section === "agents" ? (route.threadId ?? "") : retained;
	const main = useRef<HTMLDivElement>(null);
	const createButton = useRef<HTMLButtonElement>(null);
	const chatButtons = useRef(new Map<string, HTMLButtonElement>());
	const lastSelected = useRef("");
	const visible = route.page === "repo" && route.section === "agents";
	useLayoutEffect(() => {
		if (selected) lastSelected.current = selected;
		if (!mobile || !visible) return;
		if (selected) main.current?.focus({ preventScroll: true });
		else (chatButtons.current.get(lastSelected.current) ?? createButton.current)?.focus({ preventScroll: true });
	}, [selected, mobile, visible]);
	if (retained !== selected) setRetained(selected);
	if (selected && !opened.includes(selected)) setOpened([...opened, selected]);
	const [error, setError] = useState("");
	const [creating, setCreating] = useState(false);
	const acting = useRef(false);
	const poller = useRef<ResourcePoller<AgentThread[]> | undefined>(undefined);
	const [refresh] = useState(() => () => poller.current?.refresh());
	useEffect(() => {
		const resource = new ResourcePoller(
			() => api.read(`projects/${projectId}/agents`, agentThreadsSchema),
			(values) => {
				setThreads(values);
				setLoaded(true);
				setError("");
			},
			setError,
		);
		poller.current = resource;
		resource.refresh();
		return () => {
			resource.stop();
			poller.current = undefined;
		};
	}, [api, projectId]);
	const firstId = threads.at(0)?.id;
	useEffect(() => {
		if (!mobile && selectFirst && firstId) {
			void navigate(`/repos/${projectId}/agents/${firstId}`, { replace: true });
		}
	}, [mobile, selectFirst, firstId, projectId, navigate]);
	const open = (id: string) => {
		void navigate(`/repos/${projectId}/agents/${id}`);
	};
	const back = (
		<button className='agent-back' type='button' onClick={() => void navigate(`/repos/${projectId}/agents`)}>
			Back to chats
		</button>
	);
	return (
		<div className='agent-panel'>
			<aside className='agent-sidebar' aria-label='Chats' hidden={mobile && Boolean(selected)}>
				<button
					ref={createButton}
					disabled={creating}
					onClick={() => {
						if (acting.current) return;
						acting.current = true;
						setCreating(true);
						setError("");
						void api
							.read(`projects/${projectId}/agents`, agentViewSchema, "POST", {
								title: `Chat ${threads.length + 1}`,
							})
							.then((view) => {
								setThreads((values) => [...values, view.thread]);
								open(view.thread.id);
								refresh();
							})
							.catch((cause: unknown) =>
								setError(cause instanceof Error ? cause.message : "Could not create chat."),
							)
							.finally(() => {
								acting.current = false;
								setCreating(false);
							});
					}}
				>
					{creating ? "Creating…" : "Create chat"}
				</button>
				{error && (
					<p className='error' role='alert'>
						{error}
					</p>
				)}
				<nav aria-label='Chat threads'>
					{threads.map((thread) => (
						<button
							key={thread.id}
							ref={(element) => {
								if (element) chatButtons.current.set(thread.id, element);
								else chatButtons.current.delete(thread.id);
							}}
							aria-label={`Open chat ${thread.title}`}
							aria-current={selected === thread.id ? "true" : undefined}
							onClick={() => open(thread.id)}
						>
							<span>{thread.title}</span>
							{thread.status !== "uncertain" && (
								<small className={`agent-status agent-status-${thread.status}`}>{thread.status}</small>
							)}
						</button>
					))}
				</nav>
				{!threads.length && <p className='agent-notice'>No chats yet.</p>}
			</aside>
			<div
				ref={main}
				className='agent-main'
				tabIndex={-1}
				aria-label='Open conversation'
				hidden={mobile && !selected}
			>
				{selected && !threads.some((thread) => thread.id === selected) && (
					<div className='agent-welcome'>
						{back}
						<h3>{loaded || error ? "Chat unavailable" : "Loading chat…"}</h3>
						<p>Select another chat or create a new one.</p>
					</div>
				)}
				{!selected && (
					<div className='agent-welcome'>
						<h3>Work with Codex</h3>
						<p>Create or open a chat to get started.</p>
						<p>Chats keep working while you browse other repository sections.</p>
					</div>
				)}
				{opened
					.filter((id) => threads.some((thread) => thread.id === id))
					.map((id) => (
						<div key={id} hidden={selected !== id}>
							<Conversation
								id={id}
								navigation={back}
								api={api}
								changed={refresh}
								selected={selected === id && route.page === "repo" && route.section === "agents"}
							/>
						</div>
					))}
			</div>
		</div>
	);
};
