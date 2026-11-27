import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { TerminalKeyboardToolbar } from "../src/workspace/terminal-keyboard-toolbar.tsx";

import "@xterm/xterm/css/xterm.css";
import "../src/style.css";

const terminal = new Terminal({ cols: 80, rows: 24 });
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(document.getElementById("terminal")!);
fit.fit();
terminal.write("Production CSP terminal check\r\n");
const toolbar = document.createElement("div");
toolbar.className = "terminal-keyboard-position";
toolbar.style.top = "400px";
toolbar.style.left = "0px";
toolbar.style.width = "390px";
document.body.append(toolbar);
createRoot(toolbar).render(
	createElement(TerminalKeyboardToolbar, {
		connected: true,
		control: false,
		toggleControl: () => {},
		input: (value) =>
			terminal.input(typeof value === "string" ? value : value(terminal.modes.applicationCursorKeysMode), true),
	}),
);
