import { describe, expect, it, vi } from 'vitest';

import { hostTeamRunId } from '../../../src/features/agent-backend/contracts/teamRunSelection';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts/teamSelection';
import { createHostProjectRuntimeApi } from '../../../src/features/agent-backend/renderer/createHostProjectRuntimeApi';
import { createHostTeamLifecycle } from '../../../src/features/agent-backend/renderer/createHostTeamLifecycle';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/renderer/TeamProductReadOrder';

import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type { BackendLaunchSnapshot } from '../../../src/features/agent-backend/contracts/launch';
import type { AgentBackendApi, BackendRuntimeSnapshot } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';

function fixture() {
  const logical = 'TEST-logical', children = ['TEST-project-A', 'TEST-project-B'];
  const bindings: BackendConnectionSnapshot['bindings'] = [
    { handle: { handleId: logical }, label: 'TEST logical', members: [],
      ownerResourceRef: 'TEST-owner', teamResourceRef: 'TEST-logical-ref', projectContextMode: 'per_project' },
    ...children.map((handleId, index) => ({ handle: { handleId }, label: 'TEST execution', members: [],
      ownerResourceRef: 'TEST-owner', teamResourceRef: `TEST-child-ref-${index}`, projectContextMode: 'shared' as const,
      projectContext: { logicalHandleId: logical, projectPath: `/TEST/project-${index}`, workContextId: `TEST-work-${index}` } })),
  ];
  const launch = (handleId: string, index: number): BackendLaunchSnapshot => ({
    launchId: `TEST-launch-${handleId}`, rosterRevision: 'TEST-revision', startedAtMs: index + 100, observedAtMs: 200,
    status: 'ready', ready: 1, expected: 1, retryCapability: 'same-binding-no-allocation-only',
    members: [{ memberId: 'TEST-lead', generation: `TEST-generation-${index}`, attemptId: 'TEST-attempt',
      status: 'ready', nativeReady: true, usable: true, controlAvailable: true, noAllocation: false, reason: 'ready' }],
  });
  const launches = new Map(children.map((id, index) => [id, launch(id, index)]));
  const sessions = new Map<string, BackendRuntimeSnapshot>(children.map((id, index) => [id, {
    memberId: 'TEST-lead', generation: `TEST-generation-${index}`, phase: 'allocated', sealed: false,
    custody: 'owned', attached: true, nativeReady: true, inputs: [], interactions: [],
  }]));
  const snapshot: BackendTeamSnapshot = { teamName: 'TEST-logical', revision: 'a'.repeat(64), runtimeNeverLaunched: true,
    feed: { streamId: 'TEST-stream', sequence: 0, cursor: 'TEST-cursor' }, members: [], tasks: [], messages: [],
    kanbanState: { teamName: 'TEST-logical', reviewers: [], tasks: {} } };
  let current = true, onStop: ((handleId: string) => void) | undefined;
  const events: string[] = [];
  const backend: AgentBackendApi = {
    getConnections: vi.fn(async () => structuredClone({ state: 'ready' as const, bindings })),
    invoke: vi.fn<AgentBackendApi['invoke']>(async request => {
      const id = request.handle.handleId;
      events.push(`${request.operation}:${id}`);
      if (request.operation === 'team.launch.read') return { ok: true, value: structuredClone(launches.get(id) ?? null) };
      if (request.operation === 'team.snapshot') return { ok: true, value: structuredClone(snapshot) };
      if (request.operation === 'team.launch.configuration.read') {
        return { ok: true, value: { launch: structuredClone(launches.get(id)!), members: [{ memberId: 'TEST-lead',
          label: 'alice', role: 'lead', selected: { provider: 'codex', workspace: '/TEST/execution',
            model: 'TEST-model', capabilities: [] } }] } };
      }
      if (request.operation !== 'runtime.read' && request.operation !== 'runtime.stop') throw new Error('Unexpected operation');
      if (request.operation === 'runtime.stop') onStop?.(id);
      const session = sessions.get(id)!;
      if (session.generation !== request.payload.expectedGeneration)
        return { ok: false, code: 'conflict', outcome: 'rejected' };
      if (request.operation === 'runtime.stop') Object.assign(session, { attached: false, custody: 'released', phase: 'closed' });
      return { ok: true, value: structuredClone(session) };
    }),
  };
  const api = createHostProjectRuntimeApi({ backend, captureScope: () => () => current,
    readOrder: new TeamProductReadOrder(), lifecycle: createHostTeamLifecycle(backend) });
  return { logical, children, bindings, launches, sessions, snapshot, backend, api, events,
    key: hostTeamSelectionKey(logical), invalidate: () => { current = false; },
    onStop: (callback: typeof onStop) => { onStop = callback; } };
}

describe('logical Host runtime controls retain original physical histories', () => {
  it('folds child liveness into the logical selection without inventing a logical native run', async () => {
    const f = fixture();
    f.sessions.get(f.children[0])!.attached = false;
    f.sessions.get(f.children[0])!.custody = 'released';
    expect(await f.api.processAlive(f.key)).toBe(true);
    expect(await f.api.aliveList()).toEqual([f.key, hostTeamSelectionKey(f.children[1])]);
    expect(await f.api.getTeamAgentRuntime(f.key)).toMatchObject({ teamName: f.key,
      runId: hostTeamRunId(f.children[1], f.launches.get(f.children[1])!.launchId, 'TEST-revision'),
      members: { alice: { alive: true, runtimeGeneration: 'TEST-generation-1', providerId: 'codex', runtimeModel: 'TEST-model' } } });
    expect(f.events.some(event => event.startsWith('runtime.stop:'))).toBe(false);
  });

  it('captures every child before the first Stop and never follows a concurrent replacement generation', async () => {
    const f = fixture();
    f.onStop(id => { if (id === f.children[0]) f.sessions.get(f.children[1])!.generation = 'TEST-replacement'; });
    await expect(f.api.stop(f.key)).rejects.toMatchObject({ code: 'conflict', outcome: 'unknown' });
    const firstStop = f.events.findIndex(event => event.startsWith('runtime.stop:'));
    for (const id of [f.logical, ...f.children]) expect(f.events.indexOf(`team.launch.read:${id}`)).toBeLessThan(firstStop);
    const stops = vi.mocked(f.backend.invoke).mock.calls.map(([request]) => request).filter(request => request.operation === 'runtime.stop');
    expect(stops.map(request => [request.handle.handleId, request.payload.expectedGeneration])).toEqual([
      [f.children[0], 'TEST-generation-0'], [f.children[1], 'TEST-generation-1'],
    ]);
    expect(f.sessions.get(f.children[0])!.custody).toBe('released');
    expect(f.sessions.get(f.children[1])!.custody).toBe('owned');
  });

  it('keeps the child alias Stop narrow and retains unknown outcome if original context changes after an effect', async () => {
    const alias = fixture();
    await alias.api.stop(hostTeamSelectionKey(alias.children[0]));
    expect(alias.sessions.get(alias.children[0])!.custody).toBe('released');
    expect(alias.sessions.get(alias.children[1])!.attached).toBe(true);
    const f = fixture();
    f.onStop(() => f.invalidate());
    await expect(f.api.stop(f.key)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(f.events.filter(event => event.startsWith('runtime.stop:'))).toEqual([`runtime.stop:${f.children[0]}`]);
  });

  it('refuses a foreign child or a changed family before any effect instead of reselecting the new catalog', async () => {
    const f = fixture();
    f.bindings[1].ownerResourceRef = 'TEST-foreign-owner';
    await expect(f.api.stop(f.key)).rejects.toMatchObject({ outcome: 'not-dispatched' });
    expect(f.backend.invoke).not.toHaveBeenCalled();
    const changed = fixture();
    const read = vi.mocked(changed.backend.getConnections).getMockImplementation()!;
    vi.mocked(changed.backend.getConnections).mockImplementationOnce(read).mockImplementation(async () => {
      changed.bindings[1].projectContext!.projectPath = '/TEST/rebound';
      return read();
    });
    await expect(changed.api.stop(changed.key)).rejects.toMatchObject({ outcome: 'not-dispatched' });
    expect(changed.events.some(event => event.startsWith('runtime.stop:'))).toBe(false);
  });

  it('does not report unknown custody or an unproven absent root runtime as offline', async () => {
    const f = fixture();
    for (const session of f.sessions.values()) Object.assign(session, { attached: false, custody: 'unknown' });
    await expect(f.api.processAlive(f.key)).rejects.toThrow('runtime state unavailable');
    await expect(f.api.getTeamAgentRuntime(f.key)).rejects.toMatchObject({ code: 'runtime-unavailable' });
    delete f.snapshot.runtimeNeverLaunched;
    await expect(f.api.stop(f.key)).rejects.toMatchObject({ outcome: 'not-dispatched' });
    expect(f.events.some(event => event.startsWith('runtime.stop:'))).toBe(false);
  });
});
