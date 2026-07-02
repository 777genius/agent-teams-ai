import {
  buildOpenCodePermissionPendingEvidence,
  buildOpenCodeRuntimePendingPermissionsLaunchSnapshot,
  groupOpenCodeRuntimePermissionsByMember,
  hasOpenCodePendingPermissionSignal,
  type OpenCodeRuntimePermissionTrackedRunLike,
  syncOpenCodeRuntimePermissionSpawnStatuses,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimePermissions';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import { describe, expect, it, vi } from 'vitest';

import type { TeamRuntimePendingPermission } from '@main/services/team/runtime';
import type { PersistedTeamLaunchMemberState, PersistedTeamLaunchSnapshot } from '@shared/types';

const observedAt = '2026-01-01T00:00:00.000Z';

function makePermission(
  requestId: string,
  overrides: Partial<TeamRuntimePendingPermission> = {}
): TeamRuntimePendingPermission {
  return {
    providerId: 'opencode',
    requestId,
    sessionId: null,
    ...overrides,
  };
}

function makePersistedMember(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'Builder',
    providerId: 'opencode',
    laneId: 'secondary:opencode:Builder',
    laneKind: 'secondary',
    laneOwnerProviderId: 'opencode',
    launchState: 'runtime_pending_bootstrap',
    agentToolAccepted: true,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    runtimeRunId: 'run-1',
    lastEvaluatedAt: observedAt,
    ...overrides,
  };
}

function makeSnapshot(
  members: Record<string, PersistedTeamLaunchMemberState>
): PersistedTeamLaunchSnapshot {
  return createPersistedLaunchSnapshot({
    teamName: 'demo',
    expectedMembers: Object.keys(members),
    launchPhase: 'active',
    members,
    updatedAt: observedAt,
  });
}

describe('TeamProvisioningOpenCodeRuntimePermissions', () => {
  it('detects OpenCode pending permission delivery signals', () => {
    expect(hasOpenCodePendingPermissionSignal({ responseState: 'permission_blocked' })).toBe(true);
    expect(
      hasOpenCodePendingPermissionSignal({
        reason: 'OpenCode has pending permission request(s) for the current session.',
      })
    ).toBe(true);
    expect(
      hasOpenCodePendingPermissionSignal({
        diagnostics: ['bridge response: permission-blocked'],
      })
    ).toBe(true);
    expect(hasOpenCodePendingPermissionSignal({ reason: 'session refresh scheduled' })).toBe(
      false
    );
  });

  it('groups runtime permissions by persisted and delivered session evidence', () => {
    const previousLaunchState = makeSnapshot({
      Reviewer: makePersistedMember({
        name: 'Reviewer',
        laneId: 'primary',
        runtimeSessionId: 'sess-reviewer',
      }),
      Builder: makePersistedMember({
        name: 'Builder',
        laneId: 'primary',
        runtimeSessionId: 'sess-builder',
      }),
    });

    const grouped = groupOpenCodeRuntimePermissionsByMember({
      permissions: [
        makePermission('req-reviewer', { sessionId: 'sess-reviewer' }),
        makePermission('req-delivered', { sessionId: 'sess-delivered' }),
        makePermission('req-no-session'),
      ],
      laneId: 'primary',
      memberName: 'Builder',
      runId: 'run-1',
      sessionId: 'sess-delivered',
      expectedMembers: [
        { name: 'Builder', providerId: 'opencode', cwd: '/repo' },
        { name: 'Reviewer', providerId: 'opencode', cwd: '/repo' },
      ],
      previousLaunchState,
    });

    expect(grouped.get('Reviewer')?.map((permission) => permission.requestId)).toEqual([
      'req-reviewer',
    ]);
    expect(grouped.get('Builder')?.map((permission) => permission.requestId)).toEqual([
      'req-delivered',
      'req-no-session',
    ]);
  });

  it('builds pending-permission launch evidence from previous member state', () => {
    const previousLaunchState = makeSnapshot({
      Builder: makePersistedMember({
        model: 'qwen/qwen3-coder',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
        runtimeSessionId: 'sess-previous',
        diagnostics: ['previous diagnostic'],
      }),
    });

    const evidence = buildOpenCodePermissionPendingEvidence({
      laneId: 'secondary:opencode:Builder',
      memberName: 'Builder',
      permissions: [makePermission('req-1'), makePermission('req-1'), makePermission('req-2')],
      runId: 'run-1',
      sessionId: 'sess-incoming',
      previousLaunchState,
    });

    expect(evidence).toMatchObject({
      memberName: 'Builder',
      providerId: 'opencode',
      model: 'qwen/qwen3-coder',
      launchState: 'runtime_pending_permission',
      runtimeAlive: true,
      bootstrapConfirmed: true,
      sessionId: 'sess-previous',
      pendingPermissionRequestIds: ['req-1', 'req-2'],
      livenessKind: 'permission_blocked',
      runtimeDiagnostic: 'OpenCode runtime is waiting for permission approval',
      runtimeDiagnosticSeverity: 'warning',
    });
    expect(evidence.pendingPermissions?.map((permission) => permission.requestId)).toEqual([
      'req-1',
      'req-1',
      'req-2',
    ]);
    expect(evidence.diagnostics).toEqual([
      'OpenCode runtime permission request discovered after delivery was blocked.',
      'previous diagnostic',
    ]);
  });

  it('builds a pending-permission launch snapshot for matching OpenCode persisted members', () => {
    const previousLaunchState = makeSnapshot({
      Builder: makePersistedMember({
        runtimeSessionId: undefined,
        hardFailure: true,
        hardFailureReason: 'previous failure',
      }),
      Codex: makePersistedMember({
        name: 'Codex',
        providerId: 'codex',
        laneId: 'secondary:opencode:Codex',
      }),
    });

    const nextSnapshot = buildOpenCodeRuntimePendingPermissionsLaunchSnapshot({
      previous: previousLaunchState,
      runId: 'run-1',
      laneId: 'secondary:opencode:Builder',
      sessionId: 'sess-builder',
      permissionsByMember: new Map([
        [
          'Builder',
          [
            makePermission(' req-1 '),
            makePermission('req-1'),
            makePermission('req-2'),
            makePermission(''),
          ],
        ],
        ['Codex', [makePermission('req-codex')]],
      ]),
      observedAt: '2026-01-01T00:00:10.000Z',
    });

    expect(nextSnapshot?.members.Builder).toMatchObject({
      name: 'Builder',
      launchState: 'runtime_pending_permission',
      hardFailure: false,
      hardFailureReason: undefined,
      runtimeRunId: 'run-1',
      runtimeSessionId: 'sess-builder',
      pendingPermissionRequestIds: ['req-1', 'req-2'],
      livenessKind: 'permission_blocked',
      runtimeDiagnostic: 'OpenCode runtime is waiting for permission approval',
      runtimeDiagnosticSeverity: 'warning',
      lastEvaluatedAt: '2026-01-01T00:00:10.000Z',
    });
    expect(nextSnapshot?.members.Codex).toEqual(previousLaunchState.members.Codex);
  });

  it('keeps confirmed members visibly pending while OpenCode permission approval is required', () => {
    const previousLaunchState = makeSnapshot({
      Builder: makePersistedMember({
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
      }),
    });

    const nextSnapshot = buildOpenCodeRuntimePendingPermissionsLaunchSnapshot({
      previous: previousLaunchState,
      runId: 'run-1',
      laneId: 'secondary:opencode:Builder',
      sessionId: 'sess-builder',
      permissionsByMember: new Map([['Builder', [makePermission('req-1')]]]),
      observedAt: '2026-01-01T00:00:20.000Z',
    });

    expect(nextSnapshot?.members.Builder).toMatchObject({
      launchState: 'runtime_pending_permission',
      bootstrapConfirmed: true,
      runtimeAlive: true,
      pendingPermissionRequestIds: ['req-1'],
    });
  });

  it('projects pending OpenCode permissions over previously online spawn status', () => {
    const run: OpenCodeRuntimePermissionTrackedRunLike = {
      runId: 'run-1',
      request: { providerId: 'opencode' },
      memberSpawnStatuses: new Map([
        [
          'Builder',
          {
            status: 'online',
            launchState: 'confirmed_alive',
            bootstrapConfirmed: true,
            runtimeAlive: true,
            updatedAt: observedAt,
          },
        ],
      ]),
      isLaunch: true,
    };
    const emitMemberSpawnChange = vi.fn();

    const result = syncOpenCodeRuntimePermissionSpawnStatuses({
      run,
      expectedRunId: 'run-1',
      laneId: 'secondary:opencode:Builder',
      permissionsByMember: new Map([['Builder', [makePermission('req-1')]]]),
      updatedAt: '2026-01-01T00:00:30.000Z',
      isCurrentTrackedRun: () => true,
      emitMemberSpawnChange,
    });

    expect(result.shouldPersistLaunchSnapshot).toBe(true);
    expect(run.memberSpawnStatuses.get('Builder')).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      bootstrapConfirmed: true,
      runtimeAlive: true,
      pendingPermissionRequestIds: ['req-1'],
      runtimeDiagnostic: 'OpenCode runtime is waiting for permission approval',
      runtimeDiagnosticSeverity: 'warning',
    });
    expect(emitMemberSpawnChange).toHaveBeenCalledWith('Builder');
  });
});
