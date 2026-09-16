// @vitest-environment node

import {
  encodeReplayCursor,
  HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE,
  HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION,
} from '@features/coordination-events';
import { CoordinationEventHandoff } from '@features/coordination-events/core/application';
import { HostedCoordinationEventBootstrapController } from '@features/coordination-events/main/adapters/input/http/HostedCoordinationEventBootstrapController';
import { parseTeamId } from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type {
  CoordinationEventDeadlineScheduler,
  CoordinationEventJournal,
} from '@features/coordination-events/core/application';

const TEAM_ID = parseTeamId(`team_${'a'.repeat(32)}`);
const DEPLOYMENT_ID = 'deployment-bootstrap';
const EVENT_EPOCH = 'epoch-bootstrap';

const deadlineScheduler: CoordinationEventDeadlineScheduler = {
  scheduleDeadline(delayMs, onDeadline) {
    const handle = setTimeout(onDeadline, delayMs);
    return () => clearTimeout(handle);
  },
};

function cursor(sequence: number) {
  return encodeReplayCursor({
    deploymentId: DEPLOYMENT_ID,
    eventEpoch: EVENT_EPOCH,
    eventSequence: sequence,
  });
}

function journal(watermarks = [0, 0]): CoordinationEventJournal {
  let call = 0;
  return {
    getWatermark: vi.fn(async () => {
      const sequence = watermarks[Math.min(call, watermarks.length - 1)] ?? 0;
      call += 1;
      return {
        schemaVersion: 1 as const,
        deploymentId: DEPLOYMENT_ID,
        eventEpoch: EVENT_EPOCH,
        retentionFloorSequence: 0,
        highWatermarkSequence: sequence,
      };
    }),
    readCommittedEvents: vi.fn(async () => {
      throw new Error('replay-not-used');
    }),
    appendCommittedEvent: vi.fn(async () => {
      throw new Error('append-not-used');
    }),
  };
}

function controller(overrides: {
  readonly watermarks?: readonly number[];
  readonly fence?: null | { readonly sourceGeneration: string; isCurrent(): Promise<boolean> };
}) {
  const handoff = new CoordinationEventHandoff({
    journal: journal(overrides.watermarks ? [...overrides.watermarks] : undefined),
    deadlineScheduler,
  });
  const fence =
    overrides.fence === undefined
      ? {
          sourceGeneration: `${'a'.repeat(64)}:${'b'.repeat(64)}`,
          isCurrent: vi.fn(async () => true),
        }
      : overrides.fence;
  const captureTeamBootstrapFence = vi.fn(async () => fence);
  return {
    fence,
    captureTeamBootstrapFence,
    controller: new HostedCoordinationEventBootstrapController({
      handoff,
      authorizer: { captureTeamBootstrapFence },
    }),
  };
}

function hangingPromise<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function directHttpBoundary() {
  type Listener = () => void;
  const requestListeners = new Map<string, Set<Listener>>();
  const socketListeners = new Map<string, Set<Listener>>();
  const replyListeners = new Map<string, Set<Listener>>();
  const add = (listeners: Map<string, Set<Listener>>, event: string, listener: Listener): void => {
    const values = listeners.get(event) ?? new Set();
    values.add(listener);
    listeners.set(event, values);
  };
  const remove = (
    listeners: Map<string, Set<Listener>>,
    event: string,
    listener: Listener
  ): void => {
    listeners.get(event)?.delete(listener);
  };
  let handler:
    | ((request: unknown, reply: unknown) => Promise<unknown>)
    | null = null;
  const send = vi.fn();
  const code = vi.fn(function setCode() {
    return reply;
  });
  const header = vi.fn(function setHeader() {
    return reply;
  });
  const request = {
    body: { schemaVersion: 1, teamId: TEAM_ID },
    raw: {
      aborted: false,
      destroyed: false,
      socket: {
        destroyed: false,
        once: (event: string, listener: Listener) => add(socketListeners, event, listener),
        removeListener: (event: string, listener: Listener) =>
          remove(socketListeners, event, listener),
      },
      once: (event: string, listener: Listener) => add(requestListeners, event, listener),
      removeListener: (event: string, listener: Listener) =>
        remove(requestListeners, event, listener),
    },
  };
  const reply = {
    raw: {
      destroyed: false,
      once: (event: string, listener: Listener) => add(replyListeners, event, listener),
      removeListener: (event: string, listener: Listener) =>
        remove(replyListeners, event, listener),
    },
    code,
    header,
    send,
  };
  return {
    app: {
      post: (_route: string, nextHandler: typeof handler) => {
        handler = nextHandler;
      },
    },
    emitRequest: (event: string) => {
      for (const listener of [...(requestListeners.get(event) ?? [])]) listener();
    },
    invoke: () => {
      if (handler === null) throw new Error('bootstrap-handler-not-registered');
      return handler(request, reply);
    },
    send,
  };
}

describe('HostedCoordinationEventBootstrapController', () => {
  it('returns a closed team snapshot from the retained lower barrier', async () => {
    const fixture = controller({ watermarks: [2, 5] });
    const app = Fastify();
    fixture.controller.register(app);

    const response = await app.inject({
      method: 'POST',
      url: HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE,
      payload: { schemaVersion: HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION, teamId: TEAM_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      metadata: {
        schemaVersion: 1,
        deploymentId: DEPLOYMENT_ID,
        eventEpoch: EVENT_EPOCH,
        handoffMode: 'lower_barrier',
        replayCursor: cursor(2),
        revisionVector: [],
      },
      snapshot: {
        schemaVersion: HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION,
        kind: 'team_event_bootstrap',
        teamId: TEAM_ID,
      },
    });
    expect(fixture.captureTeamBootstrapFence).toHaveBeenCalledWith(expect.anything(), TEAM_ID);
    expect(fixture.fence?.isCurrent).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(response.json())).not.toMatch(/grantRevision|identityChecksum|workspace/u);

    fixture.controller.close();
    await app.close();
  });

  it.each([
    [],
    {},
    { schemaVersion: 1 },
    { schemaVersion: 2, teamId: TEAM_ID },
    { schemaVersion: 1, teamId: 'team-private' },
    { schemaVersion: 1, teamId: TEAM_ID, scopeKind: 'workspace' },
  ])('rejects a non-exact bootstrap request %#', async (payload) => {
    const fixture = controller({});
    const app = Fastify();
    fixture.controller.register(app);

    const response = await app.inject({
      method: 'POST',
      url: HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'coordination_event_bootstrap_request_invalid' });
    expect(fixture.captureTeamBootstrapFence).not.toHaveBeenCalled();

    fixture.controller.close();
    await app.close();
  });

  it('fails closed when the live fence is absent or revoked', async () => {
    for (const fence of [
      null,
      { sourceGeneration: `${'a'.repeat(64)}:${'b'.repeat(64)}`, isCurrent: async () => false },
    ]) {
      const fixture = controller({ fence });
      const app = Fastify();
      fixture.controller.register(app);
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE,
        payload: { schemaVersion: 1, teamId: TEAM_ID },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'coordination_event_bootstrap_forbidden' });
      fixture.controller.close();
      await app.close();
    }
  });

  it('returns only a stable unavailable error when the lower barrier is overtaken', async () => {
    const eventJournal = journal([2, 5]);
    vi.mocked(eventJournal.getWatermark).mockResolvedValueOnce({
      schemaVersion: 1,
      deploymentId: DEPLOYMENT_ID,
      eventEpoch: EVENT_EPOCH,
      retentionFloorSequence: 0,
      highWatermarkSequence: 2,
    });
    vi.mocked(eventJournal.getWatermark).mockResolvedValueOnce({
      schemaVersion: 1,
      deploymentId: DEPLOYMENT_ID,
      eventEpoch: EVENT_EPOCH,
      retentionFloorSequence: 3,
      highWatermarkSequence: 5,
    });
    const handoff = new CoordinationEventHandoff({ journal: eventJournal, deadlineScheduler });
    const controller = new HostedCoordinationEventBootstrapController({
      handoff,
      authorizer: {
        captureTeamBootstrapFence: async () => ({
          sourceGeneration: `${'a'.repeat(64)}:${'b'.repeat(64)}`,
          isCurrent: async () => true,
        }),
      },
    });
    const app = Fastify();
    controller.register(app);
    const response = await app.inject({
      method: 'POST',
      url: HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE,
      payload: { schemaVersion: 1, teamId: TEAM_ID },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'coordination_event_bootstrap_unavailable' });
    expect(response.body).not.toMatch(/retention|sequence|generation/u);
    controller.close();
    await app.close();
  });

  it('closes idempotently and rejects a later bootstrap before auth or storage work', async () => {
    const fixture = controller({});
    const app = Fastify();
    fixture.controller.register(app);
    fixture.controller.close();
    fixture.controller.close();

    const response = await app.inject({
      method: 'POST',
      url: HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE,
      payload: { schemaVersion: 1, teamId: TEAM_ID },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'coordination_event_bootstrap_unavailable' });
    expect(fixture.captureTeamBootstrapFence).not.toHaveBeenCalled();
    await app.close();
  });

  it('settles without a reply when close aborts a hung authorization capture', async () => {
    const eventJournal = journal();
    const captureTeamBootstrapFence = vi.fn(() =>
      hangingPromise<null>()
    );
    const controller = new HostedCoordinationEventBootstrapController({
      handoff: new CoordinationEventHandoff({ journal: eventJournal, deadlineScheduler }),
      authorizer: { captureTeamBootstrapFence },
    });
    const http = directHttpBoundary();
    controller.register(http.app);
    const operation = http.invoke();
    await vi.waitFor(() => expect(captureTeamBootstrapFence).toHaveBeenCalledOnce());

    controller.close();
    await expect(operation).resolves.toBeUndefined();
    expect(http.send).not.toHaveBeenCalled();
    expect(eventJournal.getWatermark).not.toHaveBeenCalled();
  });

  it('settles without a reply when client abort races a hung journal barrier', async () => {
    const eventJournal = journal();
    vi.mocked(eventJournal.getWatermark).mockImplementation(() =>
      hangingPromise()
    );
    const controller = new HostedCoordinationEventBootstrapController({
      handoff: new CoordinationEventHandoff({ journal: eventJournal, deadlineScheduler }),
      authorizer: {
        captureTeamBootstrapFence: async () => ({
          sourceGeneration: `${'a'.repeat(64)}:${'b'.repeat(64)}`,
          isCurrent: async () => true,
        }),
      },
    });
    const http = directHttpBoundary();
    controller.register(http.app);
    const operation = http.invoke();
    await vi.waitFor(() => expect(eventJournal.getWatermark).toHaveBeenCalledOnce());

    http.emitRequest('aborted');
    await expect(operation).resolves.toBeUndefined();
    expect(http.send).not.toHaveBeenCalled();
    controller.close();
  });
});
