import { encodeReplayCursor } from '@features/coordination-events';
import {
  createHostedCoordinationEventStream,
  type HostedCoordinationEventStorage,
} from '@features/coordination-events/main';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

function storage(overrides: Partial<HostedCoordinationEventStorage> = {}) {
  const metadata = {
    deploymentId: 'deployment-live',
    eventEpoch: 'epoch-live',
    retentionFloorSequence: 0,
    highWatermarkSequence: 0,
  };
  return {
    coordinationEventInitialize: vi.fn(async () => metadata),
    coordinationEventGetWatermark: vi.fn(async () => metadata),
    coordinationEventRead: vi.fn(async () => ({ rows: [], watermark: metadata })),
    coordinationEventAppend: vi.fn(async () => {
      throw new Error('append-not-used');
    }),
    coordinationEventPrune: vi.fn(async () => metadata),
    ...overrides,
  } satisfies HostedCoordinationEventStorage;
}

function authorizer() {
  return {
    allowedOrigin: 'https://host.test',
    authorize: vi.fn(async () => ({
      isCurrent: vi.fn(async () => true),
      projectEvent: vi.fn(async () => null),
    })),
  };
}

const cursor = encodeReplayCursor({
  deploymentId: 'deployment-live',
  eventEpoch: 'epoch-live',
  eventSequence: 0,
});

describe('hosted coordination events composition', () => {
  it('replays through the durable handoff with the exact hosted deployment identity', async () => {
    const journal = storage();
    const stream = createHostedCoordinationEventStream({
      storage: journal,
      deploymentId: 'deployment-live',
      authorizer: authorizer(),
    });

    await expect(stream.handoff.replay({ cursor })).resolves.toMatchObject({
      deploymentId: 'deployment-live',
      eventEpoch: 'epoch-live',
      nextCursor: cursor,
      events: [],
    });
    expect(journal.coordinationEventInitialize).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: 'deployment-live' })
    );
    expect(journal.coordinationEventGetWatermark).toHaveBeenCalledWith('deployment-live');
    stream.close();
  });

  it('fails the route closed when durable storage is unavailable', async () => {
    const stream = createHostedCoordinationEventStream({
      storage: storage({
        coordinationEventInitialize: vi.fn(async () => {
          throw new Error('storage-unavailable');
        }),
      }),
      deploymentId: 'deployment-live',
      authorizer: authorizer(),
    });
    const app = Fastify();
    stream.register(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/hosted/v1/events?after=${encodeURIComponent(cursor)}`,
      headers: { origin: 'https://host.test' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'event_stream_unavailable' });

    stream.close();
    await app.close();
  });

  it('closes the controller and wakeup hub as one idempotent handle', async () => {
    const journal = storage();
    const authorize = authorizer();
    const stream = createHostedCoordinationEventStream({
      storage: journal,
      deploymentId: 'deployment-live',
      authorizer: authorize,
    });
    const app = Fastify();
    stream.register(app);

    stream.close();
    stream.close();
    const response = await app.inject({
      method: 'GET',
      url: `/api/hosted/v1/events?after=${encodeURIComponent(cursor)}`,
      headers: { origin: 'https://host.test' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'event_stream_closed' });
    expect(authorize.authorize).not.toHaveBeenCalled();
    expect(journal.coordinationEventInitialize).not.toHaveBeenCalled();

    await app.close();
  });
});
