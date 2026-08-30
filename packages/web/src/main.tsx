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
// The dropdown island, imported rather than loaded as its own <script>: it stays a separate React
// *root* (fancy-menus renders into its own host outside the app tree) but no longer ships a second
// copy of React — that duplicate was 374 KB, as much as the whole dashboard bundle.
import "./menus";
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
