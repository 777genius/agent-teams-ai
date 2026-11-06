import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { createHostTeamChanges } from '../../../src/features/agent-backend/renderer/createHostTeamChanges';
import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/renderer/TeamProductReadOrder';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { TeamsAPI } from '../../../src/shared/types/api';
import type { TeamChangeEvent } from '../../../src/shared/types/team';
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const backend: AgentBackendApi = {
    getConnections: vi.fn<AgentBackendApi['getConnections']>(async () => ({
      state: 'ready',
      bindings: ['A', 'B'].map((handleId) => ({
        handle: { handleId },
        label: handleId,
        members: [],
      })),
    })),
    invoke: vi.fn<AgentBackendApi['invoke']>(async () => ({
      ok: true,
      value: { streamId: a, sequence: 0, cursor: a, events: [], gap: { reason: 'initial' } },
    })),
  };
  const events: TeamChangeEvent[] = [];
  const readOrder = new TeamProductReadOrder();
  const watch = createHostTeamChanges({
    readOrder,
    backend,
    captureScope: () => () => true,
    selectionKey: hostTeamSelectionKey,
  });
  return { backend, events, watch, readOrder };
}
describe('ordinary Host snapshot invalidation', () => {
  afterEach(() => vi.useRealTimers());
  it('shares one loop, retains original handles and isolates an unavailable owner', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.backend.invoke).mockImplementation(async (request) =>
      request.handle.handleId === 'A'
        ? { ok: false, code: 'hold', outcome: 'unknown' }
        : { ok: true, value: { streamId: b, sequence: 0, cursor: b, events: [] } }
    );
    const stop = f.watch.subscribe((_event, event) => f.events.push(event));
    const second = vi.fn();
    const stopSecond = f.watch.subscribe(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events.map((event) => [event.teamName, event.type])).toEqual([
      [hostTeamSelectionKey('B'), 'config'],
      [hostTeamSelectionKey('B'), 'inbox'],
    ]);
    expect(f.backend.invoke).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.backend.invoke).toHaveBeenCalledTimes(4);
    expect(f.events).toHaveLength(2);
    expect(vi.mocked(f.backend.invoke).mock.calls[3][0]).toMatchObject({
      handle: { handleId: 'B' },
      operation: 'team.changes.read',
      payload: { cursor: b },
    });
    stop();
    stopSecond();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.backend.invoke).toHaveBeenCalledTimes(4);
  });
  it('drops late results after context change/unsubscribe and never overlaps a pending read', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (value: Awaited<ReturnType<AgentBackendApi['invoke']>>) => void;
    vi.mocked(f.backend.invoke).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const stop = f.watch.subscribe((_event, event) => f.events.push(event));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.backend.invoke).toHaveBeenCalledTimes(1);
    stop();
    resolve({
      ok: true,
      value: {
        streamId: a,
        sequence: 1,
        cursor: a,
        events: [{ sequence: 1, eventId: a + ':1', kind: 'invalidate' }],
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events).toEqual([]);
    expect(f.backend.invoke).toHaveBeenCalledTimes(1);
  });
  it('starts a fresh cursor after shell context switches and preserves legacy subscription receiver', async () => {
    vi.useFakeTimers();
    let context = 'one';
    const f = fixture();
    let legacyListener!: Parameters<TeamsAPI['onTeamChange']>[0];
    const stopLegacy = vi.fn();
    const legacy = {
      onTeamChange: function (this: unknown, callback: typeof legacyListener) {
        expect(this).toBe(legacy);
        legacyListener = callback;
        return stopLegacy;
      },
    } as unknown as TeamsAPI;
    const teams = createHostTeamsApi(legacy, f.backend, () => {
      const selected = context;
      return () => context === selected;
    });
    const stop = teams.onTeamChange((_event, event) => f.events.push(event));
    await vi.advanceTimersByTimeAsync(0);
    legacyListener(undefined, { type: 'task', teamName: hostTeamSelectionKey('forged') });
    legacyListener(undefined, { type: 'task', teamName: 'legacy' });
    expect(f.events.at(-1)?.teamName).toBe('legacy');
    context = 'two';
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      vi
        .mocked(f.backend.invoke)
        .mock.calls.slice(-2)
        .every(([request]) => Object.keys(request.payload).length === 0)
    ).toBe(true);
    stop();
    expect(stopLegacy).toHaveBeenCalledOnce();
  });
  it('rehydrates a later subscriber even when another subscriber already consumed the current cursor', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.backend.invoke).mockImplementation(async () => ({
      ok: true,
      value: { streamId: b, sequence: 0, cursor: b, events: [] },
    }));
    const first = f.watch.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const late = vi.fn();
    const second = f.watch.subscribe(late);
    await vi.advanceTimersByTimeAsync(2000);
    expect(late).toHaveBeenCalledTimes(4);
    first();
    second();
  });
  it('deduplicates replayed source events while a new subscriber still gets its own initial read', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.backend.invoke).mockResolvedValue({
      ok: true,
      value: {
        streamId: a,
        sequence: 1,
        cursor: b,
        events: [{ sequence: 1, eventId: a + ':1', kind: 'invalidate' }],
      },
    });
    const stop = f.watch.subscribe((_event, event) => f.events.push(event));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.events).toHaveLength(4);
    stop();
  });
  it('uses the existing control lane and projects no private fields', async () => {
    const request = vi.fn(async () => ({
      ok: true,
      value: {
        streamId: a,
        sequence: 0,
        cursor: a,
        events: [],
        gap: { reason: 'cursor' },
        privateRoot: '/TEST/private',
      },
    }));
    const facade = new BackendOperationsFacade({ request } as never);
    expect(
      await facade.invoke({
        handle: { handleId: 'A' },
        commandId: 'original-read',
        operation: 'team.changes.read',
        payload: { cursor: b },
      })
    ).toEqual({
      ok: true,
      value: { streamId: a, sequence: 0, cursor: a, events: [], gap: { reason: 'cursor' } },
    });
    expect(request.mock.calls[0]).toEqual([
      { handleId: 'A' },
      expect.objectContaining({
        method: 'team.changes.read',
        control: true,
        payload: { cursor: b },
      }),
    ]);
    expect(
      (
        await facade.invoke({
          handle: { handleId: 'A' },
          commandId: 'bad',
          operation: 'team.changes.read',
          payload: { cursor: b, owner: 'other' },
        })
      ).ok
    ).toBe(false);
  });
});
