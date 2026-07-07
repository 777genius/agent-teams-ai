import type { RunEventType } from "@vioxen/subscription-runtime/worker-core";
import {
  type CodexGoalCliIo,
  type OutputFormat,
  option,
  outputFormatFromFlags,
  parseFlags,
  parseOptionalPositiveInteger,
  requiredOption,
  resolvePath,
  writeJsonOrText,
} from "../codex-goal-cli-support";
import { createLocalFileRelayEventsPorts } from "./adapters/local-file-relay-events-adapters";
import { createRelayEventsPublisher } from "./adapters/relay-events-publisher";
import { relayRunEvents } from "./application/relay-run-events";
import {
  RelayEventsPublisherKind,
  parseRelayEventTypes,
  parseRelayEventsPublisherKind,
} from "./domain/relay-events";

export type RelayEventsCommand = {
  readonly kind: "relay-events";
  readonly eventRootDir: string;
  readonly consumerId: string;
  readonly publisherKind: RelayEventsPublisherKind;
  readonly webhookUrl?: string;
  readonly webhookTimeoutMs?: number;
  readonly limit?: number;
  readonly runId?: string;
  readonly types?: readonly RunEventType[];
  readonly format: OutputFormat;
};

export function parseCodexGoalRelayEventsCommand(
  argv: readonly string[],
  io: CodexGoalCliIo,
): RelayEventsCommand {
  const env = io.env();
  const values = parseFlags(argv);
  const publisherKind = parseRelayEventsPublisherKind(
    option(values, env, "--publisher", [
      "SUBSCRIPTION_RUNTIME_RUN_EVENT_PUBLISHER",
    ]) ?? RelayEventsPublisherKind.Stdout,
  );
  const eventRootDir = resolvePath(
    io.cwd(),
    requiredOption(values, env, "--event-root", [
      "SUBSCRIPTION_RUNTIME_RUN_EVENT_ROOT",
    ]),
  );
  const webhookUrl = option(values, env, "--webhook-url", [
    "SUBSCRIPTION_RUNTIME_RUN_EVENT_WEBHOOK_URL",
  ]);
  if (publisherKind === RelayEventsPublisherKind.Webhook && !webhookUrl) {
    throw new Error("--webhook-url is required for webhook publisher");
  }
  const format = outputFormatFromFlags(values, env, "text");
  if (publisherKind === RelayEventsPublisherKind.Stdout && format === "json") {
    throw new Error("stdout relay publisher writes NDJSON events; use --text");
  }
  const webhookTimeoutMs = parseOptionalPositiveInteger(
    option(values, env, "--webhook-timeout-ms", [
      "SUBSCRIPTION_RUNTIME_RUN_EVENT_WEBHOOK_TIMEOUT_MS",
    ]),
    "--webhook-timeout-ms",
  );
  const limit = parseOptionalPositiveInteger(
    option(values, env, "--limit", []),
    "--limit",
  );
  const runId = option(values, env, "--run-id", []);
  const types = parseRelayEventTypes(option(values, env, "--type", []));
  return {
    kind: "relay-events",
    eventRootDir,
    consumerId: requiredOption(values, env, "--consumer-id", [
      "SUBSCRIPTION_RUNTIME_RUN_EVENT_CONSUMER_ID",
    ]),
    publisherKind,
    ...(webhookUrl === undefined ? {} : { webhookUrl }),
    ...(webhookTimeoutMs === undefined ? {} : { webhookTimeoutMs }),
    ...(limit === undefined ? {} : { limit }),
    ...(runId === undefined ? {} : { runId }),
    ...(types === undefined ? {} : { types }),
    format,
  };
}

export async function runCodexGoalRelayEventsCommand(
  command: RelayEventsCommand,
  io: CodexGoalCliIo,
): Promise<number> {
  const result = await relayEvents(command, io);
  if (
    command.publisherKind === RelayEventsPublisherKind.Stdout &&
    command.format === "text"
  ) {
    return 0;
  }
  writeJsonOrText(command.format, result, io);
  return 0;
}

async function relayEvents(command: RelayEventsCommand, io: CodexGoalCliIo) {
  const publisher = createRelayEventsPublisher({
    publisherKind: command.publisherKind,
    ...(command.webhookUrl === undefined
      ? {}
      : { webhookUrl: command.webhookUrl }),
    ...(command.webhookTimeoutMs === undefined
      ? {}
      : { webhookTimeoutMs: command.webhookTimeoutMs }),
    writeStdout: (chunk) => io.writeStdout(chunk),
  });
  const result = await relayRunEvents(
    {
      consumerId: command.consumerId,
      ...(command.limit === undefined ? {} : { limit: command.limit }),
      ...(command.runId === undefined ? {} : { runId: command.runId }),
      ...(command.types === undefined ? {} : { types: command.types }),
    },
    createLocalFileRelayEventsPorts({
      eventRootDir: command.eventRootDir,
      publisher,
    }),
  );
  return {
    ok: result.warnings.length === 0,
    mode: "relay_events",
    eventRootDir: command.eventRootDir,
    publisherKind: command.publisherKind,
    ...result,
  };
}
