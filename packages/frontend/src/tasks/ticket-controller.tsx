import {
	ticketSchema,
	ticketsSchema,
	epicsSchema,
	ticketNotificationsSchema,
	type TicketNotification,
	type EpicSummary,
	type MoveTicket,
	type Ticket,
} from "@forge/contracts/tickets";
import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { ResourcePoller } from "../api/resource-poller.ts";
import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { directModalParent, nextModal, useModalNavigation, useDialogDismissal } from "../navigation/controller.tsx";
import { useErrorState, useFailureToast, ToastVisibility } from "../toasts/toasts.tsx";
import { TicketDetails, type TicketReadingState } from "./ticket-details.tsx";
import { ticketLabels as labels } from "./ticket-labels.ts";
import { useTicketPresentation, useTicketDialog, useDockedDismissal } from "./ticket-presentation.tsx";

const useController = (api: IWorkspaceApi) => {
	const location = useLocation();
	const linkedId = new URLSearchParams(location.search).get("ticket");
	const [epics, setEpics] = useState<EpicSummary[]>([]);
	const [linked, setLinked] = useState<{ id: string; ticket?: Ticket; error?: string }>();
	const [tickets, setTickets] = useState<Ticket[]>([]);
	useEffect(() => {
		if (!linkedId) return;
		let current = true;
		void api.read(`tickets/${encodeURIComponent(linkedId)}`, ticketSchema).then(
			(ticket) => {
				if (current) setLinked({ id: linkedId, ticket });
			},
			() => {
				if (current) setLinked({ id: linkedId, error: "Ticket unavailable." });
			},
		);
		return () => {
			current = false;
		};
	}, [api, linkedId]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	useFailureToast(linked?.id === linkedId ? linked.error : undefined, linkedId ?? undefined);
	const [error, setError] = useErrorState();
	const [notice, setNotice] = useState("");
	const selectedTicket = linkedId && linked?.id === linkedId ? linked.ticket : undefined;
	const active = useRef(true);
	const locked = useRef(false);
	const [drafts] = useState(() => new Map<string, string>());
	const [reading] = useState(() => new Map<string, TicketReadingState>());
	const [notifications, setNotifications] = useState<TicketNotification[]>([]);
	const [notificationError, setNotificationError] = useState("");
	const [notificationsLoaded, setNotificationsLoaded] = useState(false);
	const identities = useRef<Set<string> | undefined>(undefined);
	const [pulse, setPulse] = useState(0);
	useEffect(() => {
		if (!pulse) return;
		const timer = setTimeout(() => setPulse(0), 2000);
		return () => clearTimeout(timer);
	}, [pulse]);
	type Collection = {
		tickets: Ticket[];
		epics: EpicSummary[];
		notifications?: TicketNotification[];
		notificationError?: string;
	};
	const poller = useRef<ResourcePoller<Collection> | undefined>(undefined);
	const readCollection = useCallback(async (): Promise<Collection> => {
		const [tickets, epics, feed] = await Promise.all([
			api.read("tickets?includeArchived=true", ticketsSchema),
			api.read("epics", epicsSchema),
			api.read("tickets/notifications", ticketNotificationsSchema).then(
				(notifications) => ({ notifications }),
				(cause: unknown) => ({
					notificationError: cause instanceof Error ? cause.message : "Cannot load notifications.",
				}),
			),
		]);
		return { tickets, epics, ...feed };
	}, [api]);
	const load = () => poller.current?.refresh();
	useEffect(() => {
		active.current = true;
		const polling = new ResourcePoller(
			readCollection,
			({ tickets: values, epics, notifications, notificationError }) => {
				setNotificationError(notificationError ?? "");
				if (notifications) {
					const next = new Set(notifications.map((item) => item.id));
					if (identities.current && notifications.some((item) => !identities.current!.has(item.id)))
						setPulse((value) => value + 1);
					identities.current = next;
					setNotifications(notifications);
					setNotificationsLoaded(true);
				}
				setEpics(epics);
				setTickets(values);
				setLinked((current) => {
					const ticket = values.find((value) => value.id === current?.id);
					return ticket ? { id: ticket.id, ticket } : current;
				});
				setError("");
				setLoading(false);
			},
			(message) => {
				setError(message);
				setLoading(false);
			},
			1000,
		);
		poller.current = polling;
		polling.refresh();
		return () => {
			polling.stop();
			poller.current = undefined;
			active.current = false;
		};
	}, [api, readCollection, setError]);
	const mutate = async (operation: () => Promise<void>) => {
		if (locked.current) throw new Error("A ticket change is still saving.");
		locked.current = true;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			let failure: unknown;
			await poller.current?.mutate(async () => {
				try {
					await operation();
					return await readCollection();
				} catch (error) {
					failure = error;
					return await readCollection();
				}
			});
			if (failure) throw failure;
		} finally {
			locked.current = false;
			if (active.current) setBusy(false);
		}
	};
	const move = async (id: string, input: MoveTicket) =>
		mutate(async () => {
			const updated = await api.read(`tickets/${id}/move`, ticketSchema, "POST", input);
			if (!active.current) return;
			setTickets((current) => {
				const values = current.filter((ticket) => ticket.id !== id);
				const index = values.findIndex((ticket) => ticket.id === input.beforeId);
				values.splice(index < 0 ? values.length : index, 0, updated);
				return values;
			});
			setNotice(`${id} moved to ${labels[updated.status]}.`);
		});

	return {
		api,
		linkedId,
		linked,
		selectedTicket,
		tickets,
		setTickets,
		epics,
		setEpics,
		loading,
		setLoading,
		busy,
		error,
		setError,
		notice,
		setNotice,
		drafts,
		reading,
		notifications,
		notificationError,
		notificationsLoaded,
		pulse,
		setPulse,
		load,
		mutate,
		move,
	};
};
const TicketContext = createContext<ReturnType<typeof useController> | null>(null);
export const TicketProvider = ({ api, children }: { api: IWorkspaceApi; children: ReactNode }) => {
	const location = useLocation();
	const visible = location.pathname === "/tasks" || !!new URLSearchParams(location.search).get("ticket");
	return (
		<ToastVisibility value={visible}>
			<TicketStateProvider api={api}>{children}</TicketStateProvider>
		</ToastVisibility>
	);
};
const TicketStateProvider = ({ api, children }: { api: IWorkspaceApi; children: ReactNode }) => {
	const controller = useController(api);
	return (
		<TicketContext value={controller}>
			<ToastVisibility value={true}>{children}</ToastVisibility>
		</TicketContext>
	);
};
export const useTickets = () => {
	const controller = useContext(TicketContext);
	if (!controller) throw new Error("TicketProvider is required");
	return controller;
};
export const TicketHost = () => {
	const {
		api,
		linkedId,
		linked,
		selectedTicket,
		tickets,
		epics,
		busy,
		drafts,
		reading,
		load,
		mutate,
		move,
		setNotice,
	} = useTickets();
	const location = useLocation();
	const navigate = useNavigate();
	const navigation = useModalNavigation();
	const initializing = useRef(false);
	const presentation = useTicketPresentation();
	useEffect(() => {
		if (!linkedId || navigation.modal || initializing.current) return;
		const base = directModalParent(location);
		if (!base) return;
		initializing.current = true;
		void (async () => {
			await navigate(base.pathname + base.search + base.hash, { replace: true, state: null });
			await navigate(location.pathname + location.search + location.hash, { state: nextModal(base, "ticket") });
			initializing.current = false;
		})();
	}, [linkedId, navigation.modal, location, navigate]);
	const close = () => navigation.dismissOwner("ticket");
	const openEpic = (id: string) => {
		const next = new URLSearchParams(location.search);
		next.delete("ticket");
		next.delete("tab");
		next.set("epic", id);
		navigation.open("epic", `/tasks?${next}${location.hash}`);
	};
	if (!linkedId || !navigation.modal) return null;
	return selectedTicket ? (
		<TicketDetails
			key={selectedTicket.id}
			presentation={presentation}
			ticket={tickets.find((ticket) => ticket.id === linkedId) ?? selectedTicket}
			api={api}
			epics={epics}
			busy={busy}
			drafts={drafts}
			reading={reading}
			close={close}
			openEpic={openEpic}
			refreshBoard={load}
			move={move}
			archive={() =>
				mutate(async () => {
					await api.read(`tickets/${linkedId}/archive`, ticketSchema, "POST");
					setNotice(`${linkedId} archived.`);
				})
			}
			save={(input) =>
				mutate(async () => {
					await api.read(`tickets/${linkedId}`, ticketSchema, "PATCH", input);
				})
			}
		/>
	) : (
		<TicketPending
			presentation={presentation}
			message={linked?.id === linkedId && linked.error ? linked.error : "Loading ticket…"}
			close={close}
		/>
	);
};
const TicketPending = ({
	presentation,
	message,
	close,
}: {
	presentation: ReturnType<typeof useTicketPresentation>;
	message: string;
	close: () => void;
}) => {
	const dialog = useRef<HTMLDialogElement>(null);
	useTicketDialog(dialog, presentation);
	const dismissal = useDialogDismissal(false);
	useDockedDismissal(presentation, false);
	return (
		<dialog
			ref={dialog}
			className={`ticket-dialog ticket-details ticket-${presentation}`}
			aria-label='Ticket'
			{...dismissal}
		>
			<button type='button' onClick={close}>
				Close ticket
			</button>
			<p role='status'>{message}</p>
		</dialog>
	);
};
