import type { RunEventPublisherPort } from "@vioxen/subscription-runtime/worker-core";
import {
  StdoutNdjsonRunEventPublisher,
  WebhookRunEventPublisher,
} from "@vioxen/subscription-runtime/worker-local";
import { RelayEventsPublisherKind } from "../domain/relay-events";

export function createRelayEventsPublisher(input: {
  readonly publisherKind: RelayEventsPublisherKind;
  readonly webhookUrl?: string;
  readonly webhookTimeoutMs?: number;
  readonly writeStdout: (chunk: string) => void;
}): RunEventPublisherPort {
  if (input.publisherKind === RelayEventsPublisherKind.Stdout) {
    return new StdoutNdjsonRunEventPublisher({
      write: input.writeStdout,
    });
  }
  if (input.publisherKind === RelayEventsPublisherKind.Webhook) {
    if (input.webhookUrl === undefined) {
      throw new Error("--webhook-url is required for webhook publisher");
    }
    return new WebhookRunEventPublisher({
      endpointUrl: input.webhookUrl,
      ...(input.webhookTimeoutMs === undefined
        ? {}
        : { timeoutMs: input.webhookTimeoutMs }),
    });
  }
  return assertNever(input.publisherKind);
}

function assertNever(value: never): never {
  throw new Error(`unsupported relay events publisher: ${String(value)}`);
}
