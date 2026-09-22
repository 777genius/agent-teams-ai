import {
  createHostedCoordinationEventBootstrapTransport,
  createHostedCoordinationEventTransport,
} from '@features/coordination-events/renderer';

import type {
  HostedCoordinationEventBootstrapFetchPort,
  HostedCoordinationEventSourceConstructor,
} from '@features/coordination-events/renderer';
import type { HostedTeamCoordinationEventPorts } from '@renderer/components/team/HostedTeamWorkspace';

const bootstrapFetch: HostedCoordinationEventBootstrapFetchPort = (input, init) =>
  fetch(input, init);

const browserEventSourceConstructor = function BrowserEventSource(
  url: string,
  init: Readonly<{ withCredentials: true }>
) {
  const EventSourceConstructor = globalThis.EventSource;
  if (typeof EventSourceConstructor !== 'function') {
    throw new Error('hosted-coordination-event-source-unavailable');
  }
  return new EventSourceConstructor(url, { withCredentials: init.withCredentials });
} as unknown as HostedCoordinationEventSourceConstructor;

/** Production browser wiring lives at the hosted shell boundary, not in the reusable workspace. */
export function createHostedBrowserTeamCoordinationEventPorts(
  getCsrfToken: () => string | null
): HostedTeamCoordinationEventPorts {
  return Object.freeze({
    transport: createHostedCoordinationEventTransport({
      eventSourceConstructor: browserEventSourceConstructor,
      timing: Object.freeze({
        schedule(delayMs: number, callback: () => void) {
          const timeout = globalThis.setTimeout(callback, delayMs);
          return () => globalThis.clearTimeout(timeout);
        },
      }),
      backoff: Object.freeze({
        nextDelayMs: (attempt: number) => Math.min(1_000 * 2 ** Math.min(attempt - 1, 5), 30_000),
      }),
    }),
    snapshotResync: createHostedCoordinationEventBootstrapTransport({
      fetch: bootstrapFetch,
      getCsrfToken,
    }),
  });
}
