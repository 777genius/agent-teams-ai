import assert from 'node:assert/strict';

import { test } from 'vitest';

import { hostTeamRunId } from '../../../src/features/agent-backend/contracts/teamRunSelection';
import { projectLeadObservation } from '../../../src/features/agent-backend/main/adapters/output/projectLeadObservation';
import { createHostLeadApi } from '../../../src/features/agent-backend/renderer/createHostLeadApi';

import type { BackendHandle } from '../../../src/features/agent-backend/contracts';
import type {
  AgentBackendApi,
  BackendOperationRequest,
} from '../../../src/features/agent-backend/contracts/operations';
const launch = { launchId: 'TEST-launch', rosterRevision: 'TEST-roster' };
const usage = {
  promptInputTokens: null,
  outputTokens: 42,
  contextUsedTokens: null,
  contextWindowTokens: null,
  contextUsedPercent: null,
  promptInputSource: 'unavailable',
  updatedAt: '2026-10-23T15:00:00.000Z',
};

test('Lead boundary retains only observed counts and original application launch, with unknown occupied context', () => {
  assert.deepEqual(
    projectLeadObservation(
      {
        kind: 'team-lead-context',
        launch: { ...launch, nativeSessionId: 'PRIVATE' },
        usage: { ...usage, nativeLogPath: 'PRIVATE' },
      },
      'team.lead.context.read'
    ),
    { kind: 'team-lead-context', launch, usage }
  );
  assert.throws(() =>
    projectLeadObservation(
      { kind: 'team-lead-context', launch, usage: { ...usage, contextUsedTokens: 500 } },
      'team.lead.context.read'
    )
  );
  assert.throws(() =>
    projectLeadObservation(
      { kind: 'team-lead-context', launch, usage: { ...usage, outputTokens: -1 } },
      'team.lead.context.read'
    )
  );
  assert.throws(() =>
    projectLeadObservation(
      { kind: 'team-lead-activity', launch, state: 'offline' },
      'team.lead.activity.read'
    )
  );
});

test('existing Lead UI API uses finite captured Host reads and the exact launch selection', async () => {
  const calls: BackendOperationRequest[] = [],
    handle = { handleId: 'TEST-handle' } as BackendHandle;
  const backend = {
    invoke: async (request: BackendOperationRequest) => {
      calls.push(request);
      return {
        ok: true,
        value:
          request.operation === 'team.lead.activity.read'
            ? { kind: 'team-lead-activity', state: 'active', launch }
            : { kind: 'team-lead-context', usage, launch },
      };
    },
  } as unknown as AgentBackendApi;
  const api = createHostLeadApi({
    backend,
    captureScope: () => () => true,
    resolve: async () => ({ handle, assertCurrent: () => undefined }),
  });
  assert.deepEqual(await api.getLeadActivity('TEST-team'), {
    state: 'active',
    runId: hostTeamRunId(handle.handleId, launch.launchId, launch.rosterRevision),
  });
  assert.deepEqual(await api.getLeadContext('TEST-team'), {
    usage,
    runId: hostTeamRunId(handle.handleId, launch.launchId, launch.rosterRevision),
  });
  assert.deepEqual(
    calls.map((row) => row.operation),
    ['team.lead.activity.read', 'team.lead.context.read']
  );
  assert.ok(calls.every((row) => row.handle === handle));
});

test('scope replacement during a Lead read rejects the old result without legacy fallback', async () => {
  let current = true;
  const backend = {
    invoke: async () => {
      current = false;
      return { ok: true, value: { kind: 'team-lead-context', usage, launch } };
    },
  } as unknown as AgentBackendApi;
  const api = createHostLeadApi({
    backend,
    captureScope: () => () => current,
    resolve: async (_key, check) => ({
      handle: { handleId: 'TEST-old' } as BackendHandle,
      assertCurrent: () => {
        if (!check()) throw new Error('TEST stale scope');
      },
    }),
  });
  await assert.rejects(api.getLeadContext('TEST-team'), /TEST stale scope/);
});
