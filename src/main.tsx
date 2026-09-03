import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./shared/i18n";
import "./styles.css";
import { App } from "./App";
import { api } from "./shared/api/client";
import { initializeLightweightMode } from "./features/lightweight/lightweightMode";

async function start() {
  const state = await api.getLightweightModeState().catch(() => null);
  if (state) {
    initializeLightweightMode(state);
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
