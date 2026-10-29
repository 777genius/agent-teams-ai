import { DEFAULT_HOST_LIMITS } from '@agent-teams/legacy-agent-host/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer/createHostTeamsApi';

import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type {
  AgentBackendApi,
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../src/features/agent-backend/contracts/operations';
import type { BackendRosterConfiguration } from '../../../src/features/agent-backend/contracts/roster';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';
import type { TeamsAPI } from '../../../src/shared/types/api';

function fixture() {
  const bindings: BackendConnectionSnapshot['bindings'] = Array.from(
    { length: 40 },
    (_, index) => ({
      handle: { handleId: `TEST-original-${index}` },
      label: `Host ${index}`,
      ownerResourceRef: 'TEST-one-owner',
      members: [],
    })
  );
  let active = 0,
    busyRefusals = 0,
    contextCurrent = true;
  let beforeReply: (() => void) | undefined;
  let unavailableHandle: string | undefined;
  const requests: BackendOperationRequest[] = [];
  const backend: AgentBackendApi = {
    getConnections: vi.fn(async () => ({
      state: 'ready' as const,
      bindings: structuredClone(bindings),
    })),
    invoke: vi.fn(async (request: BackendOperationRequest): Promise<BackendOperationResult> => {
      requests.push(structuredClone(request));
      // One owner exposes the real transport's finite outstanding control capacity.
      // Hold responses across a microtask so every simultaneously dispatched read counts.
      if (active >= DEFAULT_HOST_LIMITS.maxPendingRequests) {
        busyRefusals++;
        return { ok: false, code: 'busy', outcome: 'not-dispatched' };
      }
      active++;
      try {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        beforeReply?.();
        if (request.handle.handleId === unavailableHandle)
          return { ok: false, code: 'hold', outcome: 'not-dispatched' };
        const index = bindings.findIndex(
          (binding) => binding.handle.handleId === request.handle.handleId
        );
        if (index < 0) throw new Error('Rebound or foreign Host handle');
        if (request.operation === 'team.launch.read') return { ok: true, value: null };
        if (request.operation === 'team.roster.read') {
          const roster: BackendRosterConfiguration = {
            revision: 'd'.repeat(64),
            members: [],
            removedMembers: [],
            savedSettings: { cwd: '/TEST', description: `Saved ${index}` },
          };
          return { ok: true, value: roster };
        }
        if (request.operation !== 'team.snapshot') throw new Error('Unexpected operation');
        const snapshot: BackendTeamSnapshot = {
          teamName: `team-${index}`,
          revision: 'a'.repeat(64),
          feed: {
            streamId: '33333333-3333-4333-8333-333333333333',
            sequence: 0,
            cursor: '11111111-1111-4111-8111-111111111111',
          },
          members: [],
          tasks: [
            {
              id: `task-${index}`,
              subject: `Task ${index}`,
              status: 'pending',
            },
          ],
          messages: [],
          kanbanState: {
            teamName: `team-${index}`,
            reviewers: [],
            tasks: {},
          },
        };
        return { ok: true, value: snapshot };
      } finally {
        active--;
      }
    }),
  };
  const legacy = {
    list: vi.fn(async () => [
      {
        teamName: 'legacy-neighbor',
        displayName: 'Original legacy',
        description: '',
        memberCount: 0,
        taskCount: 0,
        lastActivity: null,
      },
    ]),
    getAllTasks: vi.fn(async () => [
      {
        id: 'legacy-task',
        subject: 'Original legacy task',
        status: 'pending',
        teamName: 'legacy-neighbor',
      },
    ]),
    aliveList: vi.fn(async () => ['legacy-neighbor']),
    getData: vi.fn(),
  } as unknown as TeamsAPI;
  const api = createHostTeamsApi(legacy, backend, () => () => contextCurrent);
  return {
    api,
    backend,
    legacy,
    bindings,
    requests,
    busyRefusals: () => busyRefusals,
    changeContextBeforeReply: () => {
      beforeReply = () => {
        contextCurrent = false;
      };
    },
    hold: (handle: string) => {
      unavailableHandle = handle;
    },
  };
}

describe('Host aggregate reads respect one finite owner transport', () => {
  it('loads all 40 ordinary Team rows and saved descriptions without losing the legacy neighbor', async () => {
    const f = fixture();
    const teams = await f.api.list();
    expect(teams).toHaveLength(41);
    expect(teams[0].teamName).toBe('legacy-neighbor');
    expect(teams.slice(1).map((team) => team.teamName)).toEqual(
      f.bindings.map((binding) => hostTeamSelectionKey(binding.handle.handleId))
    );
    expect(teams.slice(1).map((team) => team.description)).toEqual(
      f.bindings.map((_, i) => `Saved ${i}`)
    );
    expect(f.busyRefusals()).toBe(0);
    expect(f.backend.getConnections).toHaveBeenCalledTimes(1);
  });

  it('loads global Tasks for all 40 original handles instead of failing the whole refresh on busy', async () => {
    const f = fixture();
    const tasks = await f.api.getAllTasks();
    expect(tasks).toHaveLength(41);
    expect(tasks[0].id).toBe('legacy-task');
    expect(tasks.slice(1).map((task) => [task.id, task.teamName])).toEqual(
      f.bindings.map((binding, i) => [`task-${i}`, hostTeamSelectionKey(binding.handle.handleId)])
    );
    expect(f.busyRefusals()).toBe(0);
    expect(f.backend.getConnections).toHaveBeenCalledTimes(1);
  });

  it('reads all 40 stopped Host Teams while preserving the original alive legacy neighbor', async () => {
    const f = fixture();
    await expect(f.api.aliveList()).resolves.toEqual(['legacy-neighbor']);
    expect(f.requests.map((request) => request.handle.handleId)).toEqual(
      f.bindings.map((binding) => binding.handle.handleId)
    );
    expect(f.requests.every((request) => request.operation === 'team.launch.read')).toBe(true);
    expect(f.busyRefusals()).toBe(0);
  });

  it('rejects an aggregate whose original context changes while a slow read is pending', async () => {
    const f = fixture();
    f.changeContextBeforeReply();
    await expect(f.api.getAllTasks()).rejects.toThrow('Team context changed');
    expect(f.backend.getConnections).toHaveBeenCalledTimes(1);
    expect(
      f.requests.every((request) =>
        f.bindings.some((binding) => binding.handle.handleId === request.handle.handleId)
      )
    ).toBe(true);
    expect(f.legacy.getData).not.toHaveBeenCalled();
  });

  it('keeps an unavailable original Host read failed without skipping it, rebinding or falling back', async () => {
    const f = fixture();
    f.hold(f.bindings[2].handle.handleId);
    await expect(f.api.list()).rejects.toThrow('Host team read hold');
    expect(
      f.requests.filter(
        (request) =>
          request.operation === 'team.snapshot' &&
          request.handle.handleId === f.bindings[2].handle.handleId
      )
    ).toHaveLength(1);
    expect(f.backend.getConnections).toHaveBeenCalledTimes(1);
    expect(f.legacy.getData).not.toHaveBeenCalled();
  });
});
