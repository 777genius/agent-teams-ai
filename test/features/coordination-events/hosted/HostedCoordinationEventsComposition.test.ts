import { randomUUID } from 'node:crypto';

import {
  encodeReplayCursor,
  HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE,
} from '@features/coordination-events';
import {
  createHostedCoordinationEventStream,
  type HostedCoordinationEventStorage,
} from '@features/coordination-events/main';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const streamIdentityFactory = Object.freeze({ createStreamId: randomUUID });

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
    captureTeamBootstrapFence: vi.fn(async () => ({
      sourceGeneration: `${'a'.repeat(64)}:${'b'.repeat(64)}`,
      isCurrent: vi.fn(async () => true),
    })),
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
  it('runs retention through the live journal storage and production owner scheduler', async () => {
    const scheduled: Array<() => void> = [];
    const cancel = vi.fn();
    const schedule = vi.fn((_delayMs: number, callback: () => void) => {
      scheduled.push(callback);
      return cancel;
    });
    const journal = storage({
      coordinationEventGetWatermark: vi.fn(async () => ({
        deploymentId: 'deployment-live',
        eventEpoch: 'epoch-live',
        retentionFloorSequence: 0,
        highWatermarkSequence: 3,
      })),
      coordinationEventPrune: vi.fn<HostedCoordinationEventStorage['coordinationEventPrune']>(
        async (input) => ({
          deploymentId: input.deploymentId,
          eventEpoch: input.eventEpoch,
          retentionFloorSequence: input.throughSequence,
          highWatermarkSequence: 3,
        })
      ),
    });
    const stream = createHostedCoordinationEventStream({
      storage: journal,
      deploymentId: 'deployment-live',
      authorizer: authorizer(),
      streamIdentityFactory,
      retentionPolicy: { intervalMs: 50, maxRetainedEvents: 1 },
      retentionScheduler: { schedule },
    });

    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    await vi.waitFor(() =>
      expect(journal.coordinationEventPrune).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentId: 'deployment-live',
          eventEpoch: 'epoch-live',
          throughSequence: 2,
        })
      )
    );
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(2));
    stream.close();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('replays through the durable handoff with the exact hosted deployment identity', async () => {
    const journal = storage();
    const stream = createHostedCoordinationEventStream({
      storage: journal,
      deploymentId: 'deployment-live',
      authorizer: authorizer(),
      streamIdentityFactory,
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

  it('registers the shared team bootstrap against the same durable handoff', async () => {
    const streamAuthorizer = authorizer();
    const stream = createHostedCoordinationEventStream({
      storage: storage({
        coordinationEventGetWatermark: vi.fn(async () => ({
          deploymentId: 'deployment-live',
          eventEpoch: 'epoch-live',
          retentionFloorSequence: 0,
          highWatermarkSequence: 3,
        })),
      }),
      deploymentId: 'deployment-live',
      authorizer: streamAuthorizer,
      streamIdentityFactory,
    });
    const app = Fastify();
    stream.register(app);

    const response = await app.inject({
      method: 'POST',
      url: HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE,
      payload: {
        schemaVersion: 1,
        teamId: `team_${'a'.repeat(32)}`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      metadata: { handoffMode: 'lower_barrier', replayCursor: expect.any(String) },
      snapshot: { kind: 'team_event_bootstrap', teamId: `team_${'a'.repeat(32)}` },
    });
    expect(streamAuthorizer.captureTeamBootstrapFence).toHaveBeenCalledOnce();

    stream.close();
    await app.close();
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
      streamIdentityFactory,
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
      streamIdentityFactory,
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
