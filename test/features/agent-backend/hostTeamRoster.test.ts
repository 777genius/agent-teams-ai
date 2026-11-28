import { describe, expect, it, vi } from 'vitest';

import { createHostTeamsApi } from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/renderer/hostTeamRouting';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendRosterConfiguration } from '../../../src/features/agent-backend/contracts/roster';
import type { TeamsAPI } from '../../../src/shared/types/api';
import type { ReplaceMembersRequest } from '../../../src/shared/types/team';

const handle = { handleId: 'TEST-original-owner' };
const key = hostTeamSelectionKey(handle.handleId);
const revision = 'a'.repeat(64);
const nextRevision = 'b'.repeat(64);
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}
function input(): ReplaceMembersRequest {
  return {
    command: { commandId: 'TEST-original-command', idempotencyKey: 'TEST-original-command' },
    configuration: {
      expectedRevision: revision,
      savedSettings: { cwd: '/TEST/project', skipPermissions: false },
    },
    members: [{ name: 'worker', model: 'TEST-configured', mcpPolicy: { mode: 'appOnly' } }],
    memberSettingsRelaunch: {
      memberName: 'worker',
      targetKind: 'member',
      expectedFingerprint: 'c'.repeat(64),
      expectedTeamSettingsFingerprint: revision,
      baseline: [
        { memberName: 'lead', expectedFingerprint: 'd'.repeat(64) },
        { memberName: 'worker', expectedFingerprint: 'c'.repeat(64) },
      ],
      model: 'TEST-configured',
      effort: null,
    },
  };
}
function fixture() {
  const connection = {
    state: 'ready' as const,
    bindings: [{ handle, label: 'TEST team', members: [] }],
  };
  const backend: AgentBackendApi = {
    getConnections: vi.fn<AgentBackendApi['getConnections']>(async () => connection),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => ({
      ok: true,
      value: { commandId: request.commandId, revision: nextRevision },
    })),
  };
  const legacy = { replaceMembers: vi.fn(), getSavedRequest: vi.fn() } as unknown as TeamsAPI;
  let current = true;
  return {
    backend,
    legacy,
    connection,
    teams: createHostTeamsApi(legacy, backend, () => () => current),
    revoke: () => {
      current = false;
    },
  };
}

describe('ordinary Host roster replacement', () => {
  it('captures the supplied identity, revision and nested intent before resolving its original owner', async () => {
    const f = fixture();
    const resolving = deferred<typeof f.connection>();
    vi.mocked(f.backend.getConnections).mockReturnValueOnce(resolving.promise);
    const request = input(),
      captured = structuredClone(request);
    const pending = f.teams.replaceMembers(key, request);
    request.command!.commandId = request.command!.idempotencyKey = 'WRONG-replacement-id';
    request.configuration!.expectedRevision = 'e'.repeat(64);
    request.configuration!.savedSettings!.cwd = '/WRONG/project';
    request.members[0].model = 'WRONG-model';
    request.memberSettingsRelaunch!.baseline[0].expectedFingerprint = 'f'.repeat(64);
    resolving.resolve(f.connection);
    await pending;
    expect(f.backend.invoke).toHaveBeenCalledExactlyOnceWith({
      handle,
      commandId: captured.command!.commandId,
      operation: 'team.roster.replace',
      payload: {
        expectedRevision: revision,
        savedSettings: captured.configuration!.savedSettings,
        members: captured.members,
        memberSettingsRelaunch: captured.memberSettingsRelaunch,
      },
    });
    expect(f.legacy.replaceMembers).not.toHaveBeenCalled();
  });

  it('rejects missing capture metadata and private envelope fields before resolving or dispatching', async () => {
    const variants: unknown[] = [
      { members: [] },
      { ...input(), command: undefined },
      { ...input(), configuration: undefined },
      { ...input(), command: { commandId: 'TEST-id', idempotencyKey: 'different' } },
      { ...input(), configuration: { expectedRevision: 'wrong' } },
      { ...input(), nativeSessionId: 'PRIVATE-session' },
      {
        ...input(),
        configuration: { expectedRevision: revision, environment: { TOKEN: 'PRIVATE' } },
      },
    ];
    for (const value of variants) {
      const f = fixture();
      await expect(
        f.teams.replaceMembers(key, value as ReplaceMembersRequest)
      ).rejects.toMatchObject({
        code: 'invalid-roster-intent',
        outcome: 'not-dispatched',
      });
      expect(f.backend.getConnections).not.toHaveBeenCalled();
      expect(f.backend.invoke).not.toHaveBeenCalled();
      expect(f.legacy.replaceMembers).not.toHaveBeenCalled();
    }
  });

  it('refuses a changed context during owner resolution without dispatching', async () => {
    const f = fixture();
    const resolving = deferred<typeof f.connection>();
    vi.mocked(f.backend.getConnections).mockReturnValueOnce(resolving.promise);
    const pending = f.teams.replaceMembers(key, input());
    const rejected = expect(pending).rejects.toThrow();
    f.revoke();
    resolving.resolve(f.connection);
    await rejected;
    expect(f.backend.invoke).not.toHaveBeenCalled();
    expect(f.legacy.replaceMembers).not.toHaveBeenCalled();
  });

  it.each(['transport', 'context', 'receipt'] as const)(
    'retains the original command after an uncertain %s result without retries',
    async (reason) => {
      const f = fixture();
      const entered = deferred<void>();
      const response = deferred<Awaited<ReturnType<AgentBackendApi['invoke']>>>();
      vi.mocked(f.backend.invoke).mockImplementationOnce(async () => {
        entered.resolve();
        if (reason === 'transport') throw new Error('TEST-disconnected');
        return response.promise;
      });
      vi.mocked(f.backend.invoke).mockResolvedValueOnce({ ok: true, value: null });
      const pending = f.teams.replaceMembers(key, input());
      const rejected = expect(pending).rejects.toMatchObject({
        code:
          reason === 'transport'
            ? 'transport-unavailable'
            : reason === 'context'
              ? 'context-changed'
              : 'invalid-result',
        outcome: 'unknown',
        commandId: 'TEST-original-command',
      });
      await entered.promise;
      if (reason === 'context') f.revoke();
      response.resolve({
        ok: true,
        value: {
          commandId: reason === 'receipt' ? 'WRONG-command' : 'TEST-original-command',
          revision: nextRevision,
        },
      });
      await rejected;
      expect(f.backend.invoke).toHaveBeenCalledTimes(reason === 'context' ? 1 : 2);
      expect(vi.mocked(f.backend.invoke).mock.calls[0][0].commandId).toBe('TEST-original-command');
      if (reason !== 'context')
        expect(vi.mocked(f.backend.invoke).mock.calls[1][0]).toEqual({
          handle,
          commandId: 'TEST-original-command',
          operation: 'team.roster.lookup',
          payload: {
            expected: {
              expectedRevision: revision,
              members: input().members,
              savedSettings: input().configuration!.savedSettings,
              memberSettingsRelaunch: input().memberSettingsRelaunch,
            },
          },
        });
      expect(f.legacy.replaceMembers).not.toHaveBeenCalled();
    }
  );

  it('invalidates an already pending saved-settings read through the shared mutation fence', async () => {
    const f = fixture();
    const started = deferred<void>();
    const observation = deferred<Awaited<ReturnType<AgentBackendApi['invoke']>>>();
    const roster: BackendRosterConfiguration = {
      revision,
      savedSettings: { cwd: '/TEST/project' },
      members: [{ memberId: 'lead-id', name: 'lead', role: 'lead', settings: {} }],
      removedMembers: [],
    };
    vi.mocked(f.backend.invoke).mockImplementation(async (request) => {
      if (request.operation === 'team.roster.read') {
        started.resolve();
        return observation.promise;
      }
      return { ok: true, value: { commandId: request.commandId, revision: nextRevision } };
    });
    const pending = f.teams.getSavedRequest(key);
    const rejected = expect(pending).rejects.toThrow('mutation boundary');
    await started.promise;
    await f.teams.replaceMembers(key, input());
    observation.resolve({ ok: true, value: roster });
    await rejected;
    expect(vi.mocked(f.backend.invoke).mock.calls.map(([request]) => request.operation)).toEqual([
      'team.roster.read',
      'team.roster.replace',
    ]);
    expect(f.legacy.getSavedRequest).not.toHaveBeenCalled();
    expect(f.legacy.replaceMembers).not.toHaveBeenCalled();
  });
});
