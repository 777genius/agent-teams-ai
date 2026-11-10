import { describe, expect, it, vi } from 'vitest';

import { createHostBackendRenderer } from '../../../src/features/agent-backend/renderer/createHostBackendRenderer';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/renderer/hostTeamRouting';

import type {
  AgentBackendApi,
  BackendOperationRequest,
} from '../../../src/features/agent-backend/contracts/operations';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';
import type { TeamsAPI } from '@shared/types/api';
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}
const handle = { handleId: 'TEST-original-owner' },
  key = hostTeamSelectionKey(handle.handleId),
  revision = 'a'.repeat(64);
const settings = {
  autoAllowAll: false,
  autoAllowFileEdits: false,
  autoAllowSafeBash: false,
  timeoutAction: 'wait' as const,
  timeoutSeconds: 30,
};
function fixture() {
  const policy = deferred<void>(),
    policyStarted = deferred<void>(),
    reading = deferred<void>(),
    releaseRead = deferred<void>();
  const snapshot: BackendTeamSnapshot = {
    teamName: 'TEST-team',
    revision,
    feed: { streamId: 'TEST-stream', sequence: 0, cursor: 'TEST-cursor' },
    members: [{ name: 'lead', role: 'lead' }],
    tasks: [],
    messages: [],
    kanbanState: { teamName: 'TEST-team', tasks: {}, reviewers: [] },
  };
  let current = true;
  const source: AgentBackendApi = {
    getConnections: async () => ({
      state: 'ready',
      bindings: [{ handle, label: 'TEST-team', members: [] }],
    }),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
      if (request.operation === 'runtime.approval.settings.update') {
        policyStarted.resolve();
        await policy.promise;
        return { ok: true, value: { settings: request.payload.settings } };
      }
      if (request.operation === 'team.snapshot')
        return { ok: true, value: structuredClone(snapshot) };
      if (request.operation === 'team.launch.read') {
        reading.resolve();
        await releaseRead.promise;
        return { ok: true, value: null };
      }
      if (request.operation === 'process.list') return { ok: true, value: [] };
      if (request.operation === 'team.roster.read')
        return {
          ok: true,
          value: {
            revision,
            members: [
              {
                memberId: 'TEST-lead',
                name: 'lead',
                role: 'lead',
                settings: {},
                settingsFingerprint: revision,
              },
            ],
            removedMembers: [],
          },
        };
      if (request.operation === 'team.launch.model.configuration.read')
        return {
          ok: true,
          value: { source: { sourceId: 'TEST-source', rosterRevision: revision }, members: [] },
        };
      return { ok: false, code: 'hold', outcome: 'unknown' };
    }),
  };
  const legacy = { getData: vi.fn(), updateToolApprovalSettings: vi.fn() } as unknown as TeamsAPI;
  const api = createHostBackendRenderer(legacy, source, () => () => current);
  return {
    api,
    source,
    legacy,
    policy,
    policyStarted,
    reading,
    releaseRead,
    revoke: () => {
      current = false;
    },
  };
}
describe('original Team selection while approval settings synchronize', () => {
  it('keeps product reads valid when the automatic policy ACK arrives between snapshot and runtime/roster reads', async () => {
    const f = fixture();
    const update = f.api.teams.updateToolApprovalSettings(key, settings);
    await f.policyStarted.promise;
    const pending = f.api.teams.getData(key);
    await f.reading.promise;
    f.policy.resolve();
    await update;
    f.releaseRead.resolve();
    await expect(pending).resolves.toMatchObject({ teamName: key, tasks: [], processes: [] });
    expect(f.source.invoke).toHaveBeenCalledTimes(5);
    expect(f.legacy.getData).not.toHaveBeenCalled();
    expect(f.legacy.updateToolApprovalSettings).not.toHaveBeenCalled();
  });
  it('does not classify the SDK-free saved-model configuration read as a mutation', async () => {
    const f = fixture(),
      pending = f.api.teams.getData(key);
    await f.reading.promise;
    await f.api.backend.invoke({
      handle,
      commandId: 'TEST-model-read',
      operation: 'team.launch.model.configuration.read',
      payload: {},
    });
    f.releaseRead.resolve();
    await expect(pending).resolves.toMatchObject({ teamName: key, tasks: [] });
  });
  it.each<BackendOperationRequest>([
    {
      handle,
      commandId: 'TEST-start',
      operation: 'team.launch.start',
      payload: { launchId: 'TEST-launch', rosterRevision: revision },
    },
    {
      handle,
      commandId: 'TEST-task',
      operation: 'task.assign',
      payload: { taskId: 'TEST-task', owner: 'lead' },
    },
    {
      handle,
      commandId: 'TEST-interaction',
      operation: 'runtime.interaction',
      payload: {
        memberId: 'TEST-lead',
        expectedGeneration: '1',
        inputId: 'TEST-input',
        interactionRef: 'TEST-ref',
        reply: { kind: 'permission', decision: 'deny' },
      },
    },
  ])('still refuses a stale product read across genuine $operation control', async (request) => {
    const f = fixture(),
      pending = f.api.teams.getData(key);
    const rejected = expect(pending).rejects.toThrow('mutation boundary');
    await f.reading.promise;
    await f.api.backend.invoke(request);
    f.releaseRead.resolve();
    await rejected;
  });
  it('keeps original scope refusal even when only a policy update is in flight', async () => {
    const f = fixture(),
      update = f.api.teams.updateToolApprovalSettings(key, settings);
    await f.policyStarted.promise;
    const pending = f.api.teams.getData(key),
      rejected = expect(pending).rejects.toThrow(/Team context changed|forbidden/);
    await f.reading.promise;
    f.revoke();
    f.policy.resolve();
    await expect(update).rejects.toThrow();
    f.releaseRead.resolve();
    await rejected;
  });
});
