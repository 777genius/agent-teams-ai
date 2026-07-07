#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runSubscriptionAgentTaskCli } from "./agent-task-runner/cli";

export * from "./agent-task-runner/cli";

if (await isMainModule()) {
  process.exitCode = await runSubscriptionAgentTaskCli();
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return (await realpath(modulePath)) === (await realpath(process.argv[1]));
  } catch {
    return modulePath === process.argv[1];
  }
}
