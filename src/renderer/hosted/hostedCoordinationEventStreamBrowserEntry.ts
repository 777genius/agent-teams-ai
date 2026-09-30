import {
  createHostedCoordinationEventBootstrapTransport,
  createHostedCoordinationEventTransport,
} from '@features/coordination-events/renderer';

/**
 * A narrow, build-verifiable browser seam for the hosted SSE transports. It is
 * not application state; the hosted shell continues to own the live instances.
 */
Object.defineProperty(globalThis, '__agentTeamsHostedCoordinationEventStream', {
  value: {
    createHostedCoordinationEventBootstrapTransport,
    createHostedCoordinationEventTransport,
  },
});
