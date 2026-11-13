import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { AgentComposer } from "../src/agents/agent-composer.tsx";
import { WorkspaceApi } from "../src/api/workspace-api.ts";
import { ToastProvider, useFailureToast, useToast } from "../src/toasts/toasts.tsx";

import "../src/style.css";

const api = new WorkspaceApi(window.fetch.bind(window));
const Harness = () => {
	const { notify } = useToast();
	const outer = useRef<HTMLDialogElement>(null);
	const inner = useRef<HTMLDialogElement>(null);
	const [draft, setDraft] = useState("");
	const [visible, setVisible] = useState(true);
	const [failure, setFailure] = useState("");
	const [snapshot, setSnapshot] = useState(0);
	useFailureToast(failure);
	return (
		<>
			<button onClick={() => notify("First failure")}>First</button>
			<button onClick={() => notify("Second failure")}>Second</button>
			<button onClick={() => notify("Third failure")}>Third</button>
			<button onClick={() => outer.current?.showModal()}>Open outer</button>
			<button onClick={() => setVisible(!visible)}>Toggle chat</button>
			<button onClick={() => setFailure("Saved failure")}>Poll failure</button>
			<button onClick={() => setSnapshot(snapshot + 1)}>Poll unchanged {snapshot}</button>
			<dialog ref={outer}>
				<button onClick={() => inner.current?.showModal()}>Open inner</button>
				<button onClick={() => notify("First failure")}>Outer failure</button>
				<button onClick={() => outer.current?.close()}>Close outer</button>
				<dialog ref={inner}>
					<button onClick={() => notify("Second failure")}>Inner failure</button>
					<button onClick={() => inner.current?.close()}>Close inner</button>
				</dialog>
			</dialog>
			<div hidden={!visible} style={{ position: "fixed", bottom: 0, left: 0, right: 0 }}>
				<AgentComposer
					id='test'
					api={api}
					draft={draft}
					change={setDraft}
					send={() => {}}
					disabled={false}
					sendable
					settings={{}}
					configurable={false}
					completions={false}
				/>
			</div>
		</>
	);
};
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ToastProvider>
			<Harness />
		</ToastProvider>
	</StrictMode>,
);
