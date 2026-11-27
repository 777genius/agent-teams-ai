import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { hostTeamRunId, hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts';
import { parseBackendTeamOperation } from '../../../src/features/agent-backend/main/adapters/input/teamOperationValues';
import { projectMemberActionResult } from '../../../src/features/agent-backend/main/adapters/output/projectMemberActionResult';
import { createHostMemberActions } from '../../../src/features/agent-backend/renderer/createHostMemberActions';
import { createHostTeamsApi } from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { createHostFailedMemberRetry } from '../../../src/renderer/components/team/createHostFailedMemberRetry';
import { createTeamMemberRestartAction } from '../../../src/renderer/store/team/teamMemberRestartAction';
import {
  readMemberActionRequest,
  readMemberActionView,
} from '../../../src/features/agent-backend/contracts/memberActions';
import type {
  BackendMemberActionView,
  BackendMemberActionRequest,
} from '../../../src/features/agent-backend/contracts/memberActions';
import type {
  AgentBackendApi,
  BackendOperationRequest,
} from '../../../src/features/agent-backend/contracts/operations';
import type { AppState } from '../../../src/renderer/store/types';
import type { TeamsAPI } from '../../../src/shared/types/api';

function expectRestartError(message: string) {
  assert.deepEqual(vi.mocked(console.error).mock.calls, [
    ['[Renderer:unwrapIpc]', `[team:restartMember] ${message}`],
  ]);
  vi.mocked(console.error).mockClear();
}

function throughStore(
  controls: ReturnType<typeof createHostMemberActions>,
  teamName = 'TEST-selection',
  runId = 'TEST-run'
) {
  const refreshes: string[] = [];
  const state = {
    activeContextId: 'local',
    isContextSwitching: false,
    currentRuntimeRunIdByTeam: { [teamName]: runId },
    currentProvisioningRunIdByTeam: { [teamName]: runId },
    ignoredRuntimeRunIds: {},
    ignoredProvisioningRunIds: {},
    refreshTeamData: async () => {
      refreshes.push('data');
    },
    refreshTeamMessagesHead: async () => {
      refreshes.push('messages');
    },
    fetchMemberSpawnStatuses: async () => {
      refreshes.push('spawn');
    },
    fetchTeamAgentRuntime: async () => {
      refreshes.push('runtime');
    },
  } as unknown as AppState;
  const restart = createTeamMemberRestartAction({
    get: () => state,
    set: () => {
      throw new Error('Same Host launch must not adopt a different run');
    },
    captureScope: () => 'TEST-scope',
    isScopeCurrent: () => true,
    restart: controls.restartMember,
    readSnapshot: async () => ({ runId, statuses: {} }),
    onEqualSuppressed() {},
  });
  return { restart, refreshes, state };
}
function fixture(
  mode: 'success' | 'lost-prepare' | 'unknown-effect' | 'reopen' | 'reopen-bound' = 'success'
) {
  const calls: BackendOperationRequest[] = [];
  let selected = {
    memberId: 'A',
    generation: 'A1',
    attemptId: 'TEST-failed',
    status: 'failed',
    noAllocation: false,
  };
  let replaceAtActionRead = false;
  let current = true,
    original: BackendMemberActionView | null =
      mode === 'reopen' || mode === 'reopen-bound'
        ? view('TEST-original', 'prepared', mode === 'reopen-bound' ? 'TEST-failed' : undefined)
        : null;
  function view(
    commandId: string,
    stage: BackendMemberActionView['stage'],
    expectedFailedAttemptId?: string
  ): BackendMemberActionView {
    return {
      commandId,
      launchId: 'TEST-run',
      rosterRevision: 'TEST-roster',
      memberId: 'A',
      action: 'restart',
      ...(expectedFailedAttemptId === undefined ? {} : { expectedFailedAttemptId }),
      allocation: 'runtime',
      sourceGeneration: selected.generation,
      selectedGeneration: stage === 'selected' ? `${selected.generation}-next` : null,
      stage,
      current: true,
      source: {
        availability: 'observed',
        generation: selected.generation,
        phase: stage === 'selected' ? 'closed' : 'allocated',
        custody: stage === 'selected' ? 'released' : 'owned',
        attached: stage !== 'selected',
      },
      selected:
        stage === 'selected'
          ? {
              availability: 'observed',
              generation: `${selected.generation}-next`,
              phase: 'allocated',
              custody: 'owned',
              attached: true,
            }
          : null,
    };
  }
  const backend = {
    async invoke(request: BackendOperationRequest) {
      calls.push(request);
      switch (request.operation) {
        case 'team.launch.configuration.read':
          return {
            ok: true,
            value: {
              launch: {
                launchId: 'TEST-run',
                rosterRevision: 'TEST-roster',
                members: [{ ...selected }],
              },
              members: [{ memberId: 'A', label: 'Alice' }],
            },
          };
        case 'team.member.actions.read':
          if (replaceAtActionRead) {
            selected = { ...selected, generation: 'A2', attemptId: 'later', status: 'ready' };
            original = view('TEST-other-generation-intent', 'prepared');
          }
          return {
            ok: true,
            value: {
              launchId: 'TEST-run',
              rosterRevision: 'TEST-roster',
              memberId: 'A',
              actions: original ? [original] : [],
              retries: [],
            },
          };
        case 'team.member.action.prepare':
          original = view(request.commandId, 'prepared', request.payload.expectedFailedAttemptId);
          if (mode === 'lost-prepare') throw new Error('TEST-lostACK');
          return { ok: true, value: original };
        case 'team.member.action.execute':
          original = view(
            request.commandId,
            mode === 'unknown-effect' ? 'requested' : 'selected',
            request.payload.expectedFailedAttemptId
          );
          if (mode === 'unknown-effect') throw new Error('TEST-lostACK-after-effect');
          return { ok: true, value: original };
        case 'team.member.action.lookup':
          return { ok: true, value: original };
        default:
          throw new Error('Unexpected operation');
      }
    },
  } as unknown as AgentBackendApi;
  const controls = createHostMemberActions({
    backend,
    captureScope: () => () => current,
    resolve: async () => ({
      handle: { handleId: 'TEST-owner' },
      assertCurrent() {
        if (!current) throw new Error('stale');
      },
    }),
    invalidateReads() {},
  });
  return {
    controls,
    calls,
    readView: () => structuredClone(original),
    replaceMember(next: Partial<typeof selected>) {
      selected = { ...selected, ...next };
    },
    replaceWhenActionsRead() {
      replaceAtActionRead = true;
    },
    revoke() {
      current = false;
    },
  };
}
test('existing restart uses immutable prepare then exactly one execute; reopened untouched prepare retains original command', async () => {
  for (const mode of ['success', 'lost-prepare', 'reopen'] as const) {
    const f = fixture(mode);
    assert.deepEqual(await f.controls.restartMember('TEST-selection', 'Alice'), {
      status: 'restarted',
    });
    const prepare = f.calls.find((r) => r.operation === 'team.member.action.prepare')!,
      execute = f.calls.filter((r) => r.operation === 'team.member.action.execute');
    assert.equal(execute.length, 1);
    assert.equal(execute[0]!.commandId, prepare.commandId);
    assert.deepEqual(execute[0]!.payload, prepare.payload);
    if (mode === 'reopen') assert.equal(prepare.commandId, 'TEST-original');
  }
});
test('confirmed Host member actions satisfy the real store restart result contract', async () => {
  for (const mode of ['success', 'lost-prepare', 'reopen'] as const) {
    const f = fixture(mode);
    const store = throughStore(f.controls);
    await store.restart('TEST-selection', 'Alice');
    assert.deepEqual(store.refreshes, ['data', 'messages', 'spawn', 'runtime']);
    assert.equal(f.calls.filter((r) => r.operation === 'team.member.action.execute').length, 1);
  }
  const unknown = fixture('unknown-effect');
  await assert.rejects(throughStore(unknown.controls).restart('TEST-selection', 'Alice'), /hold/);
  expectRestartError('Host team operation hold (unknown)');
});
test('uncertain original effect is query-only on reload/click; never another prepare/execute or fresh identity', async () => {
  const f = fixture('unknown-effect');
  await assert.rejects(f.controls.restartMember('TEST-selection', 'Alice'), /hold/);
  await assert.rejects(f.controls.restartMember('TEST-selection', 'Alice'), /hold/);
  assert.equal(f.calls.filter((r) => r.operation === 'team.member.action.prepare').length, 1);
  assert.equal(f.calls.filter((r) => r.operation === 'team.member.action.execute').length, 1);
  assert.equal(f.calls.filter((r) => r.operation === 'team.member.action.lookup').length, 1);
});
test('failed Retry refuses a replaced generation, attempt, launch, member or recovered state before effects', async () => {
  const key = hostTeamSelectionKey('TEST-owner');
  const captured = {
    runId: hostTeamRunId('TEST-owner', 'TEST-run', 'TEST-roster'),
    memberId: 'A',
    generation: 'A1',
    attemptId: 'TEST-failed',
    noAllocation: false,
  };
  for (const change of [
    'generation',
    'attempt',
    'healthy',
    'allocation',
    'launch',
    'roster',
    'member',
  ] as const) {
    const f = fixture();
    const expected = { ...captured };
    if (change === 'generation') f.replaceMember({ generation: 'A2', status: 'ready' });
    if (change === 'attempt') f.replaceMember({ attemptId: 'new-failed-attempt' });
    if (change === 'healthy') f.replaceMember({ status: 'ready' });
    if (change === 'allocation') f.replaceMember({ noAllocation: true });
    if (change === 'launch')
      expected.runId = hostTeamRunId('TEST-owner', 'old-launch', 'TEST-roster');
    if (change === 'roster') expected.runId = hostTeamRunId('TEST-owner', 'TEST-run', 'old-roster');
    if (change === 'member') expected.memberId = 'different-member';
    await assert.rejects(
      throughStore(f.controls, key, captured.runId).restart(key, 'Alice', undefined, expected),
      /Refresh its status/
    );
    expectRestartError('Failed teammate selection changed. Refresh its status before retrying.');
    assert.deepEqual(
      f.calls.map((request) => request.operation),
      change === 'healthy'
        ? ['team.launch.configuration.read', 'team.member.actions.read']
        : ['team.launch.configuration.read']
    );
  }
  const manual = fixture();
  manual.replaceMember({ status: 'ready', generation: 'A2' });
  assert.deepEqual(await manual.controls.restartMember(key, 'Alice'), { status: 'restarted' });
  const raced = fixture();
  raced.replaceWhenActionsRead();
  await assert.rejects(
    throughStore(raced.controls, key, captured.runId).restart(key, 'Alice', undefined, captured),
    /Refresh its status/
  );
  expectRestartError('Failed teammate selection changed. Refresh its status before retrying.');
  assert.deepEqual(
    raced.calls.map((request) => request.operation),
    ['team.launch.configuration.read', 'team.member.actions.read']
  );
  for (const mode of ['reopen', 'reopen-bound'] as const) {
    const admitted = fixture(mode);
    admitted.replaceMember({ status: 'ready' });
    await throughStore(admitted.controls, key, captured.runId).restart(
      key,
      'Alice',
      undefined,
      captured
    );
    const prepare = admitted.calls.find(
      (request) => request.operation === 'team.member.action.prepare'
    )!;
    assert.equal(prepare.commandId, 'TEST-original');
    assert.equal(
      Object.hasOwn(prepare.payload, 'expectedFailedAttemptId'),
      mode === 'reopen-bound'
    );
  }
});

test('partial bulk success then hold cannot restart the recovered teammate again when UI refresh was stale', async () => {
  const f = fixture();
  const key = hostTeamSelectionKey('TEST-owner');
  const runId = hostTeamRunId('TEST-owner', 'TEST-run', 'TEST-roster');
  const store = throughStore(f.controls, key, runId);
  const retry = createHostFailedMemberRetry({
    teamName: key,
    runId,
    contextId: 'local',
    memberNames: ['Alice', 'Bob'],
    failedSelections: {
      Alice: {
        runId,
        memberId: 'A',
        generation: 'A1',
        attemptId: 'TEST-failed',
        noAllocation: false,
      },
      Bob: {
        runId,
        memberId: 'B',
        generation: 'B1',
        attemptId: 'TEST-B-failed',
        noAllocation: false,
      },
    },
    getState: () => store.state,
    restartMember: async (...args) => {
      if (args[1] === 'Bob') throw new Error('hold: unknown original effect');
      await store.restart(...args);
      f.replaceMember({ generation: 'A2', attemptId: 'TEST-recovered', status: 'ready' });
    },
  });
  await assert.rejects(retry(), /hold: unknown original effect/);
  await assert.rejects(retry(), /Refresh its status/);
  expectRestartError('Failed teammate selection changed. Refresh its status before retrying.');
  assert.equal(
    f.calls.filter((request) => request.operation === 'team.member.action.prepare').length,
    1
  );
  assert.equal(
    f.calls.filter((request) => request.operation === 'team.member.action.execute').length,
    1
  );
});

test('Main retry DTO retains an original attempt only for one member and preserves omitted payloads', () => {
  const original = {
    launchId: 'TEST-run',
    rosterRevision: 'TEST-roster',
    attemptId: 'next',
    memberIds: ['A'],
  };
  assert.deepEqual(parseBackendTeamOperation('team.launch.retry', original), original);
  assert.deepEqual(
    parseBackendTeamOperation('team.launch.retry', { ...original, expectedAttemptId: 'failed-A' }),
    { ...original, expectedAttemptId: 'failed-A' }
  );
  for (const expectedAttemptId of ['', null, 1])
    assert.throws(() =>
      parseBackendTeamOperation('team.launch.retry', { ...original, expectedAttemptId })
    );
  assert.throws(() =>
    parseBackendTeamOperation('team.launch.retry', {
      ...original,
      memberIds: ['A', 'B'],
      expectedAttemptId: 'failed-A',
    })
  );
  const restart = {
    launchId: 'TEST-run',
    rosterRevision: 'TEST-roster',
    memberId: 'A',
    expectedGeneration: 'A1',
    action: 'restart',
  };
  assert.deepEqual(readMemberActionRequest(restart), restart);
  assert.deepEqual(readMemberActionRequest({ ...restart, expectedFailedAttemptId: 'failed-A' }), {
    ...restart,
    expectedFailedAttemptId: 'failed-A',
  });
  assert.throws(() => readMemberActionRequest({ ...restart, expectedFailedAttemptId: null }));
  assert.throws(() =>
    readMemberActionRequest({ ...restart, action: 'skip', expectedFailedAttemptId: 'failed-A' })
  );
});

test('Main action result correlates the retained failed-attempt condition before returning it', async () => {
  const f = fixture();
  const key = hostTeamSelectionKey('TEST-owner');
  const captured = {
    runId: hostTeamRunId('TEST-owner', 'TEST-run', 'TEST-roster'),
    memberId: 'A',
    generation: 'A1',
    attemptId: 'TEST-failed',
    noAllocation: false,
  };
  await f.controls.restartMember(key, 'Alice', undefined, captured);
  const request = f.calls.find((call) => call.operation === 'team.member.action.execute')!;
  const view = f.readView();
  assert.ok(view);
  assert.deepEqual(projectMemberActionResult(view, request), view);
  assert.throws(
    () => projectMemberActionResult({ ...view, expectedFailedAttemptId: 'other-attempt' }, request),
    /Wrong original member action/
  );
});
test('old secondary and revoked context refuse before connection or control, and strict DTO rejects private selector/false observation', async () => {
  const f = fixture();
  await assert.rejects(f.controls.restartMember('TEST-selection', 'Alice', true), /unsupported/);
  assert.equal(f.calls.length, 0);
  f.revoke();
  await assert.rejects(f.controls.restartMember('TEST-selection', 'Alice'), /forbidden/);
  assert.equal(f.calls.length, 0);
  const request: BackendMemberActionRequest = {
    launchId: 'TEST-run',
    rosterRevision: 'TEST-roster',
    memberId: 'A',
    expectedGeneration: 'A1',
    action: 'restart',
  };
  assert.throws(
    () =>
      readMemberActionRequest({ ...request, provider: 'claude', configuration: '/private/path' }),
    /Invalid member action/
  );
  assert.throws(
    () =>
      readMemberActionView({
        commandId: 'c',
        ...request,
        sourceGeneration: 'A1',
        selectedGeneration: null,
        stage: 'prepared',
        current: true,
        allocation: 'runtime',
        source: { availability: 'no-allocation' },
        selected: null,
      }),
    /Invalid member action/
  );
});

test.each([false, true])(
  'proven no-allocation Retry teammate preserves existing retry binding and looks up the same receipt after lost ACK (captured=%s)',
  async (bound) => {
    const calls: BackendOperationRequest[] = [],
      retries: { commandId: string; attemptId: string; current: boolean }[] = [];
    const backend = {
      async invoke(r: BackendOperationRequest) {
        calls.push(r);
        if (r.operation === 'team.launch.configuration.read')
          return {
            ok: true,
            value: {
              launch: {
                launchId: 'TEST-run',
                rosterRevision: 'TEST-roster',
                members: [
                  {
                    memberId: 'A',
                    generation: 'A1',
                    attemptId: retries[0]?.attemptId ?? 'TEST-failed',
                    status: retries.length ? 'pending-bootstrap' : 'failed',
                    noAllocation: !retries.length,
                  },
                ],
              },
              members: [{ memberId: 'A', label: 'Alice' }],
            },
          };
        if (r.operation === 'team.member.actions.read')
          return {
            ok: true,
            value: {
              launchId: 'TEST-run',
              rosterRevision: 'TEST-roster',
              memberId: 'A',
              actions: [],
              retries,
            },
          };
        if (r.operation === 'team.launch.retry') {
          retries.push({ commandId: r.commandId, attemptId: r.payload.attemptId, current: true });
          throw new Error('TEST-lostACK');
        }
        throw new Error('Unexpected operation');
      },
    } as unknown as AgentBackendApi;
    const controls = createHostMemberActions({
      backend,
      captureScope: () => () => true,
      resolve: async () => ({ handle: { handleId: 'TEST-owner' }, assertCurrent() {} }),
      invalidateReads() {},
    });
    const key = bound ? hostTeamSelectionKey('TEST-owner') : 'TEST-selection';
    const runId = bound ? hostTeamRunId('TEST-owner', 'TEST-run', 'TEST-roster') : 'TEST-run';
    const captured = bound
      ? { runId, memberId: 'A', generation: 'A1', attemptId: 'TEST-failed', noAllocation: true }
      : undefined;
    await throughStore(controls, key, runId).restart(key, 'Alice', undefined, captured);
    await assert.rejects(controls.restartMember(key, 'Alice'), /hold/);
    const mutation = calls.filter((r) => r.operation === 'team.launch.retry');
    assert.equal(mutation.length, 1);
    assert.equal(Object.hasOwn(mutation[0]!.payload, 'expectedAttemptId'), bound);
    if (bound) assert.equal(mutation[0]!.payload.expectedAttemptId, 'TEST-failed');
    assert.equal(
      calls.filter(
        (r) =>
          r.operation === 'team.member.action.prepare' ||
          r.operation === 'team.member.action.execute'
      ).length,
      0
    );
    assert.equal(retries[0]!.commandId, mutation[0]!.commandId);
  }
);

test('a captured Host retry never falls through to the legacy member control', async () => {
  let legacyCalls = 0;
  const api = createHostTeamsApi(
    {
      restartMember: async () => {
        legacyCalls++;
        return { status: 'restarted' };
      },
    } as unknown as TeamsAPI,
    {} as AgentBackendApi
  );
  const captured = {
    runId: hostTeamRunId('TEST-owner', 'TEST-run', 'TEST-roster'),
    memberId: 'A',
    generation: 'A1',
    attemptId: 'TEST-failed',
    noAllocation: false,
  };
  await assert.rejects(
    async () => api.restartMember('legacy', 'Alice', undefined, captured),
    /original Host Team/
  );
  assert.equal(legacyCalls, 0);
  assert.deepEqual(await api.restartMember('legacy', 'Alice'), { status: 'restarted' });
  assert.equal(legacyCalls, 1);
});
