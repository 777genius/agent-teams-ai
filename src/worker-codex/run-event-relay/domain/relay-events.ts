import {
  type RunEventType,
  isRunEventType,
} from "@vioxen/subscription-runtime/worker-core";

export enum RelayEventsPublisherKind {
  Stdout = "stdout",
  Webhook = "webhook",
}

export function parseRelayEventsPublisherKind(
  value: string,
): RelayEventsPublisherKind {
  if (value === RelayEventsPublisherKind.Stdout) {
    return RelayEventsPublisherKind.Stdout;
  }
  if (value === RelayEventsPublisherKind.Webhook) {
    return RelayEventsPublisherKind.Webhook;
  }
  throw new Error("--publisher must be stdout or webhook");
}

export function parseRelayEventTypes(
  value: string | undefined,
): readonly RunEventType[] | undefined {
  if (value === undefined) return undefined;
  const types = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (types.length === 0) return undefined;
  return types.map((type) => {
    if (isRunEventType(type)) return type;
    throw new Error(`unsupported run event type: ${type}`);
  });
}
