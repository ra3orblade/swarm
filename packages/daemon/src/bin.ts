#!/usr/bin/env bun
import { createApp } from "./app";

const port = Number(process.env.HARNESS_PORT ?? 7777);
const { app } = createApp();
console.log(`harnessd listening on http://127.0.0.1:${port}`);
export default { port, hostname: "127.0.0.1", fetch: app.fetch };
