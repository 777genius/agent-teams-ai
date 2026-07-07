import {
  LocalFileRunEventDeliveryCursorStore,
  LocalFileRunEventStore,
} from "@vioxen/subscription-runtime/store-local-file";
import type { RunEventPublisherPort } from "@vioxen/subscription-runtime/worker-core";
import type { RelayRunEventsPorts } from "../application/relay-run-events";

export function createLocalFileRelayEventsPorts(input: {
  readonly eventRootDir: string;
  readonly publisher: RunEventPublisherPort;
}): RelayRunEventsPorts {
  return {
    eventStore: new LocalFileRunEventStore({
      rootDir: input.eventRootDir,
    }),
    cursorStore: new LocalFileRunEventDeliveryCursorStore({
      rootDir: input.eventRootDir,
    }),
    publisher: input.publisher,
  };
}
