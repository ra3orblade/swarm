#!/usr/bin/env bun
import { HarnessClient } from "@harness/client";

const [cmd = "help"] = process.argv.slice(2);
const client = new HarnessClient();

switch (cmd) {
  case "doctor": {
    try {
      const h = await client.health();
      console.log(`harnessd ${h.version} at ${client.baseUrl}: ok`);
    } catch (e) {
      console.log(`harnessd at ${client.baseUrl}: unreachable (${(e as Error).message})`);
      process.exit(2);
    }
    break;
  }
  default:
    console.log(
      "harness <command>\n\n  doctor   check the daemon\n\nSee docs/08-interface.md for the full surface.",
    );
}
