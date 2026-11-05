import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import "@xterm/xterm/css/xterm.css";

const terminal = new Terminal({ cols: 80, rows: 24 });
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(document.getElementById("terminal")!);
fit.fit();
terminal.write("Production CSP terminal check\r\n");
