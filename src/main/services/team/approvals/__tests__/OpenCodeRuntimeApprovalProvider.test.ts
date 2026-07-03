import { describe, expect, it } from 'vitest';

import {
  buildOpenCodeRuntimePermissionAnswerInput,
  buildOpenCodeRuntimePermissionLaunchInput,
  collectOpenCodeRuntimeApprovalEntries,
} from '../OpenCodeRuntimeApprovalProvider';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

describe('OpenCode runtime approval provider', () => {
  it('collects pending runtime approvals into UI approval entries', () => {
    expect(
      collectOpenCodeRuntimeApprovalEntries({
        teamName: 'alpha',
        runId: 'run-1',
        laneId: 'primary',
        cwd: '/tmp/project',
        expectedMembers: [{ name: 'worker', providerId: 'opencode', cwd: '/tmp/project' }],
        teamColor: '#123456',
        teamDisplayName: 'Alpha',
        nowIso: () => '2026-01-01T00:00:00.000Z',
        members: {
          worker: {
            memberName: 'worker',
            providerId: 'opencode',
            launchState: 'runtime_pending_permission',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            diagnostics: [],
            sessionId: 'session-1',
            pendingApprovals: [
              {
                providerId: 'opencode',
                requestId: ' provider-req ',
                sessionId: 'session-approval',
                tool: 'Bash',
                title: 'Run command',
                kind: 'tool',
              },
            ],
          },
        },
      })
    ).toEqual([
      {
        providerId: 'opencode',
        providerRequestId: 'provider-req',
        laneId: 'primary',
        memberName: 'worker',
        cwd: '/tmp/project',
        expectedMembers: [{ name: 'worker', providerId: 'opencode', cwd: '/tmp/project' }],
        approval: {
          requestId: 'opencode:run-1:provider-req',
          runId: 'run-1',
          teamName: 'alpha',
          providerId: 'opencode',
          source: 'worker',
          toolName: 'Bash',
          toolInput: {
            providerRequestId: 'provider-req',
            provider: 'opencode',
            sessionId: 'session-approval',
            tool: 'Bash',
            title: 'Run command',
            kind: 'tool',
          },
          receivedAt: '2026-01-01T00:00:00.000Z',
          teamColor: '#123456',
          teamDisplayName: 'Alpha',
          runtimePermission: {
            providerId: 'opencode',
            laneId: 'primary',
            memberName: 'worker',
            providerRequestId: 'provider-req',
            sessionId: 'session-approval',
          },
        },
      },
    ]);
  });

  it('builds runtime permission answer and launch inputs from an approval entry', () => {
    const [entry] = collectOpenCodeRuntimeApprovalEntries({
      teamName: 'alpha',
      runId: 'run-2',
      laneId: 'primary',
      cwd: '/tmp/project',
      expectedMembers: [{ name: 'worker', providerId: 'opencode', cwd: '/tmp/project' }],
      nowIso: () => '2026-01-01T00:00:00.000Z',
      members: {
        worker: {
          memberName: 'worker',
          providerId: 'opencode',
          launchState: 'runtime_pending_permission',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          diagnostics: [],
          pendingPermissions: [
            {
              providerId: 'opencode',
              requestId: 'provider-req',
              sessionId: 'session-2',
              tool: 'Edit',
              title: null,
              kind: null,
            },
          ],
        },
      },
    });
    const previousLaunchState: PersistedTeamLaunchSnapshot = {
      version: 2,
      teamName: 'alpha',
      updatedAt: '2026-01-01T00:00:00.000Z',
      launchPhase: 'finished',
      expectedMembers: ['worker'],
      bootstrapExpectedMembers: ['worker'],
      members: {},
      summary: {
        confirmedCount: 0,
        pendingCount: 0,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      },
      teamLaunchState: 'clean_success',
    };

    expect(buildOpenCodeRuntimePermissionAnswerInput(entry, false, previousLaunchState)).toEqual({
      runId: 'run-2',
      laneId: 'primary',
      teamName: 'alpha',
      cwd: '/tmp/project',
      providerId: 'opencode',
      memberName: 'worker',
      requestId: 'provider-req',
      decision: 'reject',
      expectedMembers: [{ name: 'worker', providerId: 'opencode', cwd: '/tmp/project' }],
      previousLaunchState,
    });

    expect(buildOpenCodeRuntimePermissionLaunchInput(entry, previousLaunchState)).toEqual({
      runId: 'run-2',
      laneId: 'primary',
      teamName: 'alpha',
      cwd: '/tmp/project',
      providerId: 'opencode',
      skipPermissions: false,
      expectedMembers: [{ name: 'worker', providerId: 'opencode', cwd: '/tmp/project' }],
      previousLaunchState,
    });
  });
});
