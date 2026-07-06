import {
  LocalFileRunEventDeliveryCursorStore,
  LocalFileRunEventStore,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  RunEventRelayService,
  type RunEventType,
  isRunEventType,
} from "@vioxen/subscription-runtime/worker-core";
import {
  StdoutNdjsonRunEventPublisher,
  WebhookRunEventPublisher,
} from "@vioxen/subscription-runtime/worker-local";
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

type RelayEventsPublisherKind = "stdout" | "webhook";

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
  const publisherKind = relayEventsPublisherKind(
    option(values, env, "--publisher", [
      "SUBSCRIPTION_RUNTIME_RUN_EVENT_PUBLISHER",
    ]) ?? "stdout",
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
  if (publisherKind === "webhook" && !webhookUrl) {
    throw new Error("--webhook-url is required for webhook publisher");
  }
  const format = outputFormatFromFlags(values, env, "text");
  if (publisherKind === "stdout" && format === "json") {
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
  const types = relayEventTypes(option(values, env, "--type", []));
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
  if (command.publisherKind === "stdout" && command.format === "text") {
    return 0;
  }
  writeJsonOrText(command.format, result, io);
  return 0;
}

async function relayEvents(command: RelayEventsCommand, io: CodexGoalCliIo) {
  const eventStore = new LocalFileRunEventStore({
    rootDir: command.eventRootDir,
  });
  const cursorStore = new LocalFileRunEventDeliveryCursorStore({
    rootDir: command.eventRootDir,
  });
  const publisher = command.publisherKind === "stdout"
    ? new StdoutNdjsonRunEventPublisher({
        write: (chunk) => io.writeStdout(chunk),
      })
    : new WebhookRunEventPublisher({
        endpointUrl: command.webhookUrl as string,
        ...(command.webhookTimeoutMs === undefined
          ? {}
          : { timeoutMs: command.webhookTimeoutMs }),
      });
  const service = new RunEventRelayService({
    eventStore,
    cursorStore,
    publisher,
  });
  const result = await service.relay({
    consumerId: command.consumerId,
    ...(command.limit === undefined ? {} : { limit: command.limit }),
    ...(command.runId === undefined ? {} : { runId: command.runId }),
    ...(command.types === undefined ? {} : { types: command.types }),
  });
  return {
    ok: result.warnings.length === 0,
    mode: "relay_events",
    eventRootDir: command.eventRootDir,
    publisherKind: command.publisherKind,
    ...result,
  };
}

function relayEventsPublisherKind(value: string): RelayEventsPublisherKind {
  if (value === "stdout" || value === "webhook") return value;
  throw new Error("--publisher must be stdout or webhook");
}

function relayEventTypes(value: string | undefined): readonly RunEventType[] | undefined {
  if (value === undefined) return undefined;
  const types = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (types.length === 0) return undefined;
  return types.map((type) => {
    if (isRunEventType(type)) return type;
    throw new Error(`unsupported run event type: ${type}`);
  });
}
