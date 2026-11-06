import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createHostMemberActions } from '../../../src/features/agent-backend/renderer/createHostMemberActions';
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
function fixture(mode: 'success' | 'lost-prepare' | 'unknown-effect' | 'reopen' = 'success') {
  const calls: BackendOperationRequest[] = [];
  let current = true,
    original: BackendMemberActionView | null =
      mode === 'reopen' ? view('TEST-original', 'prepared') : null;
  function view(
    commandId: string,
    stage: BackendMemberActionView['stage']
  ): BackendMemberActionView {
    return {
      commandId,
      launchId: 'TEST-run',
      rosterRevision: 'TEST-roster',
      memberId: 'A',
      action: 'restart',
      allocation: 'runtime',
      sourceGeneration: 'A1',
      selectedGeneration: stage === 'selected' ? 'A2' : null,
      stage,
      current: true,
      source: {
        availability: 'observed',
        generation: 'A1',
        phase: stage === 'selected' ? 'closed' : 'allocated',
        custody: stage === 'selected' ? 'released' : 'owned',
        attached: stage !== 'selected',
      },
      selected:
        stage === 'selected'
          ? {
              availability: 'observed',
              generation: 'A2',
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
                members: [{ memberId: 'A', generation: 'A1' }],
              },
              members: [{ memberId: 'A', label: 'Alice' }],
            },
          };
        case 'team.member.actions.read':
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
          original = view(request.commandId, 'prepared');
          if (mode === 'lost-prepare') throw new Error('TEST-lostACK');
          return { ok: true, value: original };
        case 'team.member.action.execute':
          original = view(request.commandId, mode === 'unknown-effect' ? 'requested' : 'selected');
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
    revoke() {
      current = false;
    },
  };
}
test('existing restart uses immutable prepare then exactly one execute; reopened untouched prepare retains original command', async () => {
  for (const mode of ['success', 'lost-prepare', 'reopen'] as const) {
    const f = fixture(mode);
    await f.controls.restartMember('TEST-selection', 'Alice');
    const prepare = f.calls.find((r) => r.operation === 'team.member.action.prepare')!,
      execute = f.calls.filter((r) => r.operation === 'team.member.action.execute');
    assert.equal(execute.length, 1);
    assert.equal(execute[0]!.commandId, prepare.commandId);
    assert.deepEqual(execute[0]!.payload, prepare.payload);
    if (mode === 'reopen') assert.equal(prepare.commandId, 'TEST-original');
  }
});
test('uncertain original effect is query-only on reload/click; never another prepare/execute or fresh identity', async () => {
  const f = fixture('unknown-effect');
  await assert.rejects(f.controls.restartMember('TEST-selection', 'Alice'), /hold/);
  await assert.rejects(f.controls.restartMember('TEST-selection', 'Alice'), /hold/);
  assert.equal(f.calls.filter((r) => r.operation === 'team.member.action.prepare').length, 1);
  assert.equal(f.calls.filter((r) => r.operation === 'team.member.action.execute').length, 1);
  assert.equal(f.calls.filter((r) => r.operation === 'team.member.action.lookup').length, 1);
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

test('proven no-allocation Retry teammate preserves existing retry binding and looks up the same receipt after lost ACK', async () => {
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
  await controls.restartMember('TEST-selection', 'Alice');
  await assert.rejects(controls.restartMember('TEST-selection', 'Alice'), /hold/);
  const mutation = calls.filter((r) => r.operation === 'team.launch.retry');
  assert.equal(mutation.length, 1);
  assert.equal(
    calls.filter(
      (r) =>
        r.operation === 'team.member.action.prepare' || r.operation === 'team.member.action.execute'
    ).length,
    0
  );
  assert.equal(retries[0]!.commandId, mutation[0]!.commandId);
});
