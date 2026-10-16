import { describe, expect, it, vi } from 'vitest';

import { electronTeamPort } from '../../../../scripts/e2e/opencode-native-team-port';

import type { ElectronAPI } from '@shared/types/api';

describe('Electron TEST delivery status privacy boundary', () => {
  it('returns only finite delivery categories and never raw reason or diagnostic data', async () => {
    const secret = 'TEST_PRIVATE_PROVIDER_TEXT_and_C:\\TEST-profile\\auth.json';
    const readStatus = vi.fn(async (_team: string, _message: string) => ({
      providerId: 'opencode',
      messageId: 'original-challenge',
      attempted: true,
      accepted: false,
      delivered: true,
      acceptanceUnknown: false,
      responsePending: true,
      ledgerStatus: 'retry_scheduled',
      responseState: 'not_observed',
      reason: `error:contract_violation: ${secret}`,
      diagnostics: [
        `error:contract_violation: ${secret}`,
        `opencode_message_delivery_exception: ${secret}`,
        secret,
      ],
      ledgerRecordId: secret,
      laneId: secret,
      userVisibleImpact: { reason: secret },
    }));
    const port = electronTeamPort(
      {
        teams: {
          onProvisioningProgress: vi.fn(() => () => undefined),
          getOpenCodeRuntimeDeliveryStatus: readStatus,
        },
      } as unknown as ElectronAPI,
      'test-opencode-privacy',
      '/tmp/TEST-privacy/project'
    );
    try {
      const result = await port.getOpenCodeRuntimeDeliveryStatus('original-challenge');
      expect(result).toEqual({
        attempted: true,
        accepted: false,
        delivered: true,
        acceptanceUnknown: false,
        responsePending: true,
        ledgerStatus: 'retry_scheduled',
        responseState: 'not_observed',
        nativeSessionFailure: null,
        reasonCode: 'contract_violation',
        diagnosticCodes: [
          'contract_violation',
          'opencode_message_delivery_exception',
          'unclassified',
        ],
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(readStatus).toHaveBeenCalledExactlyOnceWith(
        'test-opencode-privacy',
        'original-challenge'
      );
    } finally {
      port.dispose();
    }
  });
  it('projects one failed owned task without raw payloads, foreign refs or unknown codes', async () => {
    const secret = 'TEST_SECRET_AUTH_PROVIDER_TOOL_ARGUMENTS';
    const team = 'test-opencode-privacy';
    const task = { id: 'owned-task', owner: 'bob', status: 'in_progress',
      prompt: secret, comments: [{ text: secret }] };
    const data = { tasks: [task], members: [{ name: 'alice',
      runtimeAdvisory: { kind: 'api_error', reasonCode: 'quota_exhausted', message: secret } }] };
    const ref = { taskId: task.id, teamName: team, displayId: secret };
    const readStatus = vi.fn(async () => ({ attempted: true, accepted: false,
      delivered: false, acceptanceUnknown: true, responsePending: false,
      ledgerStatus: secret, responseState: 'session_error',
      reason: `error:provider_error: ${secret}`, diagnostics: [secret] }));
    const port = electronTeamPort({ teams: {
      onProvisioningProgress: vi.fn(() => () => undefined),
      getData: vi.fn(async () => data), getTask: vi.fn(async () => task),
      getTaskLogStream: vi.fn(async () => ({ segments: [{ actor: { memberName: 'alice' }, chunks: [{ rawMessages: [{ uuid: 'secret-message', type: 'assistant', content: secret, toolResults: [], toolCalls: [] }] }] }],
        runtimeProjection: { projectedMessageCount: 2, nativeToolCount: 1 } })),
      getMessagesPage: vi.fn(async () => ({ messages: [
        { to: 'alice', messageId: 'foreign-task', taskRefs: [{ ...ref, taskId: 'foreign' }] },
        { to: 'alice', messageId: 'foreign-team', taskRefs: [{ ...ref, teamName: 'other' }] },
        { to: 'bob', messageId: 'wrong-recipient', taskRefs: [ref] },
        ...Array.from({ length: 6 }, (_, n) => ({ to: 'alice', messageId: `owned-${n}`,
          taskRefs: [ref], text: secret })),
      ], hasMore: true })),
      getOpenCodeRuntimeDeliveryStatus: readStatus,
    } } as unknown as ElectronAPI, team, '/tmp/TEST-privacy/project');
    try {
      await port.getData(); // Existing API registers only this fixture's task.
      const result = await port.getSafeTaskFailureSnapshot(task.id, 'alice');
      expect(result.ownerMatches).toBe(false);
      expect(result.taskStatus).toBe('in_progress');
      expect(result.advisory).toEqual({ kind: 'api_error', reasonCode: 'quota_exhausted' });
      expect(result.matchedMessages).toBe(4);
      expect(result.messageSearchExhaustive).toBe(false);
      expect(readStatus.mock.calls).toEqual(Array.from({ length: 4 }, (_, n) => [team, `owned-${n}`]));
      expect(result.deliveries.every((row) => row?.ledgerStatus === null &&
        row.reasonCode === 'provider_error' && row.responseState === 'session_error' &&
        row.diagnosticCodes.length === 0)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain('foreign');
      await expect(port.getSafeTaskFailureSnapshot('foreign', 'alice')).rejects.toThrow('not owned');
    } finally { port.dispose(); }
  });

});


it('relaunches a stopped TEST run after restart clears the active runtime pointer', async () => {
  const teamName = 'test-opencode-relaunch';
  const cwd = '/tmp/TEST-relaunch/project';
  const previous = '196af1bd-0e0b-4caf-815f-f050cd1d8b2a';
  const fresh = '296af1bd-0e0b-4caf-815f-f050cd1d8b2a';
  const request = { teamName, cwd, providerId: 'opencode' as const };
  const fixture = (runId: string | null, alive: boolean, processAlive: boolean, result = fresh) => {
    const launchTeam = vi.fn(async () => ({ runId: result }));
    return { launchTeam, port: electronTeamPort({ teams: {
      onProvisioningProgress: () => () => undefined,
      getTeamAgentRuntime: async () => ({ runId, members: { alice: { alive } } }),
      processAlive: async () => processAlive,
      launchTeam,
    } } as unknown as ElectronAPI, teamName, cwd) };
  };
  const valid = fixture(null, false, false);
  await expect(valid.port.launchTeam(request, previous)).resolves.toMatchObject({ runId: fresh });
  expect(valid.launchTeam).toHaveBeenCalledExactlyOnceWith(request);
  await expect(valid.port.launchTeam(request, previous)).rejects.toThrow('same owned team');
  valid.port.dispose();
  for (const [retained, alive, processAlive, saved] of [
    [null, false, false, undefined], [null, false, false, '------------------------------------'], [fresh, false, false, previous], ['', false, false, previous],
    [null, true, false, previous], [null, false, true, previous],
  ] as const) {
    const invalid = fixture(retained, alive, processAlive);
    await expect(invalid.port.launchTeam(request, saved)).rejects.toThrow('retained stopped TEST run');
    expect(invalid.launchTeam).not.toHaveBeenCalled();
    invalid.port.dispose();
  }
  const reused = fixture(null, false, false, previous);
  await expect(reused.port.launchTeam(request, previous)).rejects.toThrow('fresh run identity required');
  reused.port.dispose();
});
