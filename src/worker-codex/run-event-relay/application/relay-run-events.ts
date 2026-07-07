import {
  RunEventRelayService,
  type RunEventDeliveryCursorStorePort,
  type RunEventPublisherPort,
  type RunEventRelayResult,
  type RunEventStorePort,
  type RunEventType,
} from "@vioxen/subscription-runtime/worker-core";

export type RelayRunEventsRequest = {
  readonly consumerId: string;
  readonly limit?: number;
  readonly runId?: string;
  readonly types?: readonly RunEventType[];
};

export type RelayRunEventsPorts = {
  readonly eventStore: RunEventStorePort;
  readonly cursorStore: RunEventDeliveryCursorStorePort;
  readonly publisher: RunEventPublisherPort;
};

export async function relayRunEvents(
  request: RelayRunEventsRequest,
  ports: RelayRunEventsPorts,
): Promise<RunEventRelayResult> {
  const service = new RunEventRelayService(ports);
  return service.relay({
    consumerId: request.consumerId,
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    ...(request.types === undefined ? {} : { types: request.types }),
  });
}
