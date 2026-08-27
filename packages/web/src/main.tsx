/**
 * Dashboard entry point (M11.6).
 *
 * StrictMode is on: it double-invokes effects in development, which is exactly the pressure that
 * catches a poll or an event stream that forgot how to stop. `startSnapshotFeed` returns its
 * teardown for that reason.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { applyStoredTheme } from "./lib/theme";
import "./styles/dashboard.css";

// Before the first render: an effect runs after paint, which would flash light at a dark-theme user.
applyStoredTheme();

const host = document.getElementById("root");
if (!host) throw new Error("dashboard: #root is missing from index.html");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
