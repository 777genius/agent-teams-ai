import { describe, expect, it, vi } from 'vitest';

import { BackendOperationsFacade } from '../../../src/features/agent-backend/main';
import { createHostTeamLifecycle } from '../../../src/features/agent-backend/renderer/createHostTeamLifecycle';

import type { BackendLaunchSnapshot } from '../../../src/features/agent-backend/contracts/launch';
import type {
  AgentBackendApi,
  BackendRuntimeSnapshot,
} from '../../../src/features/agent-backend/contracts/operations';

const connection = { handle: { handleId: 'original' }, label: 'Team', members: [] };
const state = (memberId: string): BackendRuntimeSnapshot => ({
  memberId,
  generation: '1',
  phase: 'allocated',
  sealed: false,
  custody: 'owned',
  attached: true,
  nativeReady: true,
  inputs: [],
  interactions: [],
});
const launch: BackendLaunchSnapshot = {
  launchId: 'run',
  rosterRevision: 'revision',
  status: 'ready',
  ready: 3,
  expected: 3,
  retryCapability: 'same-binding-no-allocation-only',
  members: ['a', 'b', 'c'].map((memberId) => ({
    memberId,
    generation: '1',
    attemptId: 'attempt-' + memberId,
    status: 'ready',
    nativeReady: true,
    usable: true,
    controlAvailable: true,
    noAllocation: false,
    reason: 'context-applied',
  })),
};

function fixture() {
  const sessions = new Map(
    launch.members.map((member) => [member.memberId, state(member.memberId)])
  );
  const stops: { memberId: string; generation?: string }[] = [];
  let onStop: ((memberId: string) => void) | undefined;
  const backend: AgentBackendApi = {
    getConnections: vi.fn(),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
      if (request.operation === 'team.launch.read')
        return { ok: true, value: structuredClone(launch) };
      if (request.operation !== 'runtime.read' && request.operation !== 'runtime.stop')
        throw new Error('Unexpected effect');
      const memberId = request.payload.memberId;
      if (request.operation === 'runtime.stop') {
        stops.push({ memberId, generation: request.payload.expectedGeneration });
        onStop?.(memberId);
      }
      const current = sessions.get(memberId)!;
      if (current.generation !== request.payload.expectedGeneration)
        return { ok: false, code: 'conflict', outcome: 'rejected' };
      if (request.operation === 'runtime.stop')
        sessions.set(memberId, {
          ...current,
          attached: false,
          custody: 'released',
          phase: 'closed',
          nativeReady: false,
        });
      return { ok: true, value: { ...sessions.get(memberId)! } };
    }),
  };
  return {
    backend,
    sessions,
    stops,
    lifecycle: createHostTeamLifecycle(backend),
    onStop: (callback: typeof onStop) => {
      onStop = callback;
    },
  };
}

describe('ordinary captured Team lifecycle', () => {
  it('accepts a configured revision only with the original admitted command, source revision and exact options', async () => {
    const configuration = { members: [{ memberId: 'a', model: 'TEST-selected', fastMode: false }] };
    const admission = { commandId: 'TEST-launch', sourceRosterRevision: 'revision', members: [{ memberId: 'a', configuration: { model: 'TEST-selected', fastMode: false } }] };
    const raw = {
      ...launch, rosterRevision: 'revision-after-configuration', admission,
      members: launch.members.map(({ generation, ...member }) => ({ memberId: member.memberId, binding: { memberId: member.memberId, generation }, attempt: member })),
    };
    const request = vi.fn().mockResolvedValue({ ok: true, value: raw });
    const facade = new BackendOperationsFacade({ request, lookup: vi.fn() });
    const envelope = { handle: connection.handle, commandId: 'TEST-launch', operation: 'team.launch.start', payload: { launchId: 'run', rosterRevision: 'revision', configuration } };
    expect(await facade.invoke(envelope)).toEqual({ ok: true, value: { ...launch, rosterRevision: raw.rosterRevision, admission: { commandId: 'TEST-launch', sourceRosterRevision: 'revision' } } });
    for (const invalid of [undefined, { ...admission, commandId: 'OTHER' }, { ...admission, sourceRosterRevision: 'OTHER' }, { ...admission, members: [{ memberId: 'a', configuration: { model: 'WRONG', fastMode: false } }] }]) {
      request.mockResolvedValueOnce({ ok: true, value: { ...raw, admission: invalid } });
      expect(await facade.invoke(envelope)).toMatchObject({ ok: false, code: 'hold', outcome: 'unknown' });
    }
    request.mockResolvedValueOnce({ ok: true, value: raw });
    expect(await facade.invoke({ ...envelope, payload: { launchId: 'run', rosterRevision: 'revision' } })).toMatchObject({ ok: false, code: 'hold', outcome: 'unknown' });
  });
  it('forwards explicit launch options and false values while refusing process/account selectors before dispatch', async () => {
    const request = vi.fn().mockResolvedValue({ ok: false, code: 'conflict', outcome: 'rejected' });
    const facade = new BackendOperationsFacade({ request, lookup: vi.fn() });
    const configuration = { members: [{ memberId: 'a', model: 'TEST-model', effort: 'medium', fastMode: false, permissions: 'manual', context: 'model-default' }] };
    const envelope = { handle: connection.handle, commandId: 'TEST-original-launch', operation: 'team.launch.start', payload: { launchId: 'run', rosterRevision: 'revision', configuration } };
    expect(await facade.invoke(envelope)).toMatchObject({ ok: false, code: 'conflict' });
    expect(request).toHaveBeenCalledExactlyOnceWith(connection.handle, {
      commandId: 'TEST-original-launch', method: 'team.launch.start',
      payload: envelope.payload, control: false,
    });
    for (const extra of [{ environment: { TOKEN: 'TEST-not-dispatched' } }, { executable: '/TEST-not-dispatched' }, { accountBinding: 'TEST-not-dispatched' }, { effort: { toString: () => 'high' } }]) {
      expect(await facade.invoke({ ...envelope, payload: { ...envelope.payload, configuration: { members: [{ ...configuration.members[0], ...extra }] } } })).toMatchObject({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
    }
    expect(await facade.invoke({ ...envelope, payload: { ...envelope.payload, configuration: { members: [configuration.members[0], configuration.members[0]] } } })).toMatchObject({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('keeps healthy members visible and stoppable when one member read is unavailable', async () => {
    const f = fixture();
    const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
    vi.mocked(f.backend.invoke).mockImplementation((request) =>
      request.operation === 'runtime.read' && request.payload.memberId === 'b'
        ? Promise.resolve({ ok: false, code: 'hold', outcome: 'unknown' })
        : invoke(request)
    );
    expect(await f.lifecycle.read(connection, () => true)).toMatchObject({
      alive: true,
      unknownMembers: ['b'],
    });
    vi.mocked(f.backend.invoke).mockClear();
    await f.lifecycle.stop(connection, () => true);
    expect(f.stops.map((stop) => stop.memberId)).toEqual(['a', 'b', 'c']);
    expect(
      vi.mocked(f.backend.invoke).mock.calls.map(([request]) => request.operation)
    ).not.toContain('runtime.read');
  });
  it('stops the original generations of all members despite one concurrent replacement', async () => {
    const f = fixture();
    f.onStop((member) => {
      if (member === 'a') f.sessions.get('b')!.generation = 'replacement';
    });
    await expect(f.lifecycle.stop(connection, () => true)).rejects.toMatchObject({
      code: 'conflict',
      outcome: 'rejected',
    });
    expect(f.stops).toEqual(['a', 'b', 'c'].map((memberId) => ({ memberId, generation: '1' })));
    expect(f.sessions.get('a')?.custody).toBe('released');
    expect(f.sessions.get('c')?.custody).toBe('released');
    expect(f.sessions.get('b')?.custody).toBe('owned');
  });
  it('preserves an unknown effect after a context switch and refuses to claim lost custody is stopped', async () => {
    const f = fixture();
    let valid = true;
    f.onStop(() => {
      valid = false;
    });
    await expect(f.lifecycle.stop(connection, () => valid)).rejects.toMatchObject({
      code: 'forbidden',
      outcome: 'unknown',
    });
    expect(f.stops).toHaveLength(1);
    const cold = fixture();
    for (const state of cold.sessions.values()) {
      state.attached = false;
      state.custody = 'unknown';
    }
    expect((await cold.lifecycle.read(connection, () => true))?.alive).toBeUndefined();
    expect(cold.stops).toEqual([]);
  });
  it('projects finite launch progress, excludes native identity and routes launch control on its work lane', async () => {
    const raw = {
      ...launch,
      members: launch.members.map(({ generation, ...member }) => ({
        memberId: member.memberId,
        binding: { memberId: member.memberId, generation, nativeSessionId: 'PRIVATE-native' },
        attempt: { ...member, hostIncarnation: 'PRIVATE-incarnation' },
      })),
    };
    const request = vi.fn().mockResolvedValue({ ok: true, value: raw });
    const facade = new BackendOperationsFacade({ request, lookup: vi.fn() });
    expect(
      await facade.invoke({
        handle: connection.handle,
        commandId: 'launch',
        operation: 'team.launch.start',
        payload: { launchId: 'run', rosterRevision: 'revision' },
      })
    ).toEqual({ ok: true, value: launch });
    expect(request).toHaveBeenCalledExactlyOnceWith(connection.handle, {
      commandId: 'launch',
      method: 'team.launch.start',
      payload: { launchId: 'run', rosterRevision: 'revision' },
      control: false,
    });
    expect(
      await facade.invoke({
        handle: connection.handle,
        commandId: 'bad-retry',
        operation: 'team.launch.retry',
        payload: {
          launchId: 'run',
          rosterRevision: 'revision',
          attemptId: 'retry',
          memberIds: ['a', 'a'],
        },
      })
    ).toMatchObject({ ok: false, outcome: 'not-dispatched' });
    expect(request).toHaveBeenCalledTimes(1);
    raw.members[0]!.binding.memberId = 'foreign';
    expect(
      await facade.invoke({
        handle: connection.handle,
        commandId: 'launch',
        operation: 'team.launch.start',
        payload: { launchId: 'run', rosterRevision: 'revision' },
      })
    ).toMatchObject({ ok: false, outcome: 'unknown' });
  });
});
