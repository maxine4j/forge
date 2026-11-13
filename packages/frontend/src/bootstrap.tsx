import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";

import { ApiClient } from "./api/api-client.ts";
import { WorkspaceApi } from "./api/workspace-api.ts";
import { App } from "./app.tsx";
import { NavigationRouter } from "./navigation/controller.tsx";
import { ToastProvider } from "./toasts/toasts.tsx";

import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const api = new ApiClient(window.fetch.bind(window));
const workspaceApi = new WorkspaceApi(window.fetch.bind(window));
const router = createBrowserRouter([{ path: "*", element: <App api={api} workspaceApi={workspaceApi} /> }]);
createRoot(root).render(
	<StrictMode>
		<ToastProvider>
			<NavigationRouter.Provider value={router}>
				<RouterProvider router={router} />
			</NavigationRouter.Provider>
		</ToastProvider>
	</StrictMode>,
);
