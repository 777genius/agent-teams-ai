import { describe, expect, it, vi } from 'vitest';

import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/renderer/TeamProductReadOrder';

import type {
  AgentBackendApi,
  BackendOperationResult,
} from '../../../src/features/agent-backend/contracts/operations';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';
import type { TeamsAPI } from '../../../src/shared/types/api';
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const snapshot = (sequence: number, streamId = a): BackendTeamSnapshot => ({
  teamName: 'canonical',
  revision: (sequence % 10).toString().repeat(64),
  feed: { streamId, sequence, cursor: sequence === 0 ? a : b },
  members: [],
  tasks: [{ id: '1', subject: 'version-' + sequence, status: 'pending' }],
  messages: [],
  kanbanState: { teamName: 'canonical', reviewers: [], tasks: {} },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('captured Team product read ordering', () => {
  it('does not let late snapshots or feeds roll back an accepted source sequence or revive a retired stream', () => {
    const reads = new TeamProductReadOrder();
    reads.capture(() => true);
    reads.acceptSnapshot('A', snapshot(2));
    expect(() => reads.acceptSnapshot('A', snapshot(1))).toThrow('Stale');
    expect(reads.observeFeed('A', snapshot(1).feed)).toBe(false);
    reads.observeFeed('A', snapshot(3).feed);
    expect(() => reads.assertCurrent('A', snapshot(2).feed)).toThrow('Stale');
    reads.acceptSnapshot('A', snapshot(3));
    reads.acceptSnapshot('A', snapshot(0, b));
    expect(() => reads.acceptSnapshot('A', snapshot(99, a))).toThrow('Stale');
    const inconsistent = { ...snapshot(0, b), revision: 'f'.repeat(64) };
    expect(() => reads.acceptSnapshot('A', inconsistent)).toThrow('Inconsistent');
    expect(reads.position('A')).toEqual(snapshot(0, b).feed);
  });
  it('invalidates old reads across both dispatch and outcome observation, without storing product bodies', () => {
    const reads = new TeamProductReadOrder();
    const before = reads.readFence('A');
    reads.invalidateReads('A');
    const during = reads.readFence('A');
    expect(before).toThrow('mutation');
    reads.invalidateReads('A');
    expect(during).toThrow('mutation');
    expect(reads.readFence('A')).not.toThrow();
  });
  it.each(['team.launch.read', 'process.list'] as const)('rejects an older getData response after %s awaits while a newer product snapshot arrives', async (pendingRead) => {
    const oldRuntime = deferred<BackendOperationResult>();
    const runtimeStarted = deferred<void>();
    let productReads = 0,
      runtimeReads = 0;
    const backend: AgentBackendApi = {
      getConnections: vi.fn<AgentBackendApi['getConnections']>(async () => ({
        state: 'ready',
        bindings: [{ handle: { handleId: 'A' }, label: 'Team', members: [] }],
      })),
      invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
        if (request.operation === 'team.snapshot')
          return { ok: true, value: snapshot(++productReads) };
        if (request.operation === pendingRead) {
          if (++runtimeReads === 1) {
            runtimeStarted.resolve();
            return oldRuntime.promise;
          }
          return { ok: true, value: pendingRead === 'process.list' ? [] : null };
        }
        if (request.operation === 'team.launch.read') return { ok: true, value: null };
        if (request.operation === 'process.list') return { ok: true, value: [] };
        if (request.operation === 'team.roster.read') return { ok: false, code: 'hold', outcome: 'not-dispatched' };
        throw new Error('unexpected');
      }),
    };
    const teams = createHostTeamsApi(
      { getData: vi.fn(), getTask: vi.fn(), updateTaskFields: vi.fn() } as unknown as TeamsAPI,
      backend
    );
    const old = teams.getData(hostTeamSelectionKey('A'));
    const rejected = expect(old).rejects.toThrow('Stale');
    await runtimeStarted.promise;
    const latest = await teams.getData(hostTeamSelectionKey('A'));
    expect(latest.tasks[0].subject).toBe('version-2');
    expect(latest.processes).toEqual([]);
    oldRuntime.resolve({ ok: true, value: pendingRead === 'process.list' ? [] : null });
    await rejected;
    expect(vi.mocked(backend.invoke).mock.calls.every(([request]) => request.handle.handleId === 'A')).toBe(true);
  });
  it('rejects an old product read after a real API mutation finishes, even before the next feed poll', async () => {
    const old = deferred<BackendOperationResult>();
    const started = deferred<void>();
    let reads = 0;
    const backend: AgentBackendApi = {
      getConnections: vi.fn<AgentBackendApi['getConnections']>(async () => ({
        state: 'ready',
        bindings: [{ handle: { handleId: 'A' }, label: 'Team', members: [] }],
      })),
      invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
        if (request.operation === 'team.snapshot') {
          if (++reads === 1) {
            started.resolve();
            return old.promise;
          }
          return { ok: true, value: snapshot(0) };
        }
        if (request.operation === 'task.update')
          return {
            ok: true,
            value: { commandId: request.commandId, operation: 'task.update', phase: 'completed' },
          };
        throw new Error('unexpected');
      }),
    };
    const teams = createHostTeamsApi(
      { getData: vi.fn(), getTask: vi.fn(), updateTaskFields: vi.fn() } as unknown as TeamsAPI,
      backend
    );
    const pending = teams.getTask(hostTeamSelectionKey('A'), '1');
    const rejected = expect(pending).rejects.toThrow('mutation');
    await started.promise;
    await teams.updateTaskFields(hostTeamSelectionKey('A'), '1', { subject: 'new value' });
    old.resolve({ ok: true, value: snapshot(0) });
    await rejected;
    expect(backend.invoke).toHaveBeenCalledTimes(3);
  });
});
