#!/usr/bin/env node
import { loadOpenAiCompatibleCodexBridgeConfigFromEnv } from "./config.js";
import {
  CodexOpenAiBridgeBackend,
  OpenAiBridgeChatCompletionUseCase,
  startOpenAiBridgeHttpServer,
} from "./chat-completions/index.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command !== "serve") {
    throw new Error(`unknown_command:${command}`);
  }

  const config = loadOpenAiCompatibleCodexBridgeConfigFromEnv();
  const backend = new CodexOpenAiBridgeBackend({
    codexBinaryPath: config.codexBinaryPath,
    authRootDir: config.authRootDir,
    stateDir: config.stateDir,
    ...(config.accountNames === undefined
      ? {}
      : { accountNames: config.accountNames }),
    timeoutMs: config.timeoutMs,
    quotaCooldownMs: config.quotaCooldownMs,
    maxAccountCycles: config.maxAccountCycles,
    maxConcurrentRequests: config.maxConcurrentRequests,
    reasoningEffort: config.reasoningEffort,
    ...(config.serviceTier === undefined
      ? {}
      : { serviceTier: config.serviceTier }),
    sourceEnv: process.env,
  });
  const chatCompletion = new OpenAiBridgeChatCompletionUseCase({
    backend,
    publicModel: config.publicModel,
    codexModel: config.codexModel,
  });
  await startOpenAiBridgeHttpServer({
    host: config.host,
    port: config.port,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    publicModel: config.publicModel,
    requestBodyMaxBytes: config.requestBodyMaxBytes,
    chatCompletion,
    health: () => backend.health(),
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    service: "subscription-runtime-openai-compatible-codex",
    host: config.host,
    port: config.port,
    model: config.publicModel,
  }) + "\n");
}

function printHelp(): void {
  process.stdout.write([
    "subscription-runtime-openai-codex-bridge serve",
    "",
    "Environment:",
    "  SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_AUTH_ROOT or SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT",
    "  SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_PORT",
    "  SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_ACCOUNTS",
    "  SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_API_KEY",
  ].join("\n") + "\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`subscription_runtime_openai_bridge_failed:${message}\n`);
  process.exitCode = 1;
});
