import {
  buildLaunchDiagnosticsFromRun,
  buildWorkspaceTrustPreflightLaunchDiagnostic,
  mentionsProcessTableUnavailable,
  mergeLaunchDiagnosticItem,
} from '@main/services/team/provisioning/TeamProvisioningLaunchDiagnostics';
import { describe, expect, it } from 'vitest';

import type { WorkspaceTrustExecutionResult } from '@features/workspace-trust/main';
import type { MemberSpawnStatusEntry, TeamLaunchDiagnosticItem } from '@shared/types';

const NOW = '2026-05-24T00:00:00.000Z';
const nowIso = () => NOW;

function spawnEntry(overrides: Partial<MemberSpawnStatusEntry>): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'starting',
    updatedAt: NOW,
    ...overrides,
  };
}

function buildRun(entries: [string, Partial<MemberSpawnStatusEntry>][], isLaunch = true) {
  return {
    isLaunch,
    memberSpawnStatuses: new Map(
      entries.map(([memberName, entry]) => [memberName, spawnEntry(entry)])
    ),
  };
}

function workspaceTrustExecution(
  overrides: Partial<WorkspaceTrustExecutionResult>
): WorkspaceTrustExecutionResult {
  return {
    id: 'claude-pty-workspace-trust',
    provider: 'claude',
    status: 'ok',
    workspaceIds: ['workspace-1'],
    ...overrides,
  };
}

describe('TeamProvisioningLaunchDiagnostics', () => {
  it('skips non-launch and empty launch runs', () => {
    expect(buildLaunchDiagnosticsFromRun(buildRun([], false), { nowIso })).toBeUndefined();
    expect(buildLaunchDiagnosticsFromRun(buildRun([]), { nowIso })).toBeUndefined();
    expect(
      buildLaunchDiagnosticsFromRun({ isLaunch: true, memberSpawnStatuses: undefined }, { nowIso })
    ).toBeUndefined();
  });

  it('projects member spawn status entries into launch diagnostics without changing priority order', () => {
    const diagnostics = buildLaunchDiagnosticsFromRun(
      buildRun([
        ['Lead', { launchState: 'confirmed_alive' }],
        [
          'WorkerA',
          {
            launchState: 'failed_to_start',
            error: 'fallback error',
            hardFailureReason: 'hard failure reason',
            agentToolAccepted: true,
          },
        ],
        [
          'WorkerB',
          {
            launchState: 'runtime_pending_permission',
            runtimeDiagnostic: 'waiting for user approval',
          },
        ],
        [
          'WorkerC',
          {
            bootstrapStalled: true,
            runtimeDiagnostic: 'bootstrap deadline exceeded',
            livenessKind: 'runtime_process',
          },
        ],
        [
          'WorkerD',
          {
            runtimeDiagnostic: 'process table temporarily unavailable',
            livenessKind: 'shell_only',
          },
        ],
        ['WorkerE', { livenessKind: 'shell_only', runtimeDiagnostic: 'tmux pane only' }],
        [
          'WorkerF',
          {
            livenessKind: 'runtime_process_candidate',
            runtimeDiagnostic: 'process found but bootstrap missing',
          },
        ],
        ['WorkerG', { livenessKind: 'runtime_process', runtimeDiagnostic: 'process found' }],
        ['WorkerH', { livenessKind: 'registered_only', runtimeDiagnostic: 'registered only' }],
        ['WorkerI', { livenessKind: 'stale_metadata', runtimeDiagnostic: 'stale metadata' }],
        ['WorkerJ', { livenessKind: 'not_found', runtimeDiagnostic: 'no runtime' }],
        ['WorkerK', { agentToolAccepted: true, runtimeDiagnostic: 'spawn accepted' }],
        ['WorkerL', {}],
      ]),
      { nowIso }
    );

    expect(diagnostics).toEqual([
      {
        id: 'Lead:bootstrap_confirmed',
        memberName: 'Lead',
        severity: 'info',
        code: 'bootstrap_confirmed',
        label: 'Lead - bootstrap confirmed',
        observedAt: NOW,
      },
      {
        id: 'WorkerA:bootstrap_stalled',
        memberName: 'WorkerA',
        severity: 'error',
        code: 'bootstrap_stalled',
        label: 'WorkerA - failed to start',
        detail: 'hard failure reason',
        observedAt: NOW,
      },
      {
        id: 'WorkerB:permission_pending',
        memberName: 'WorkerB',
        severity: 'warning',
        code: 'permission_pending',
        label: 'WorkerB - awaiting permission',
        detail: 'waiting for user approval',
        observedAt: NOW,
      },
      {
        id: 'WorkerC:bootstrap_stalled',
        memberName: 'WorkerC',
        severity: 'warning',
        code: 'bootstrap_stalled',
        label: 'WorkerC - bootstrap stalled',
        detail: 'bootstrap deadline exceeded',
        observedAt: NOW,
      },
      {
        id: 'WorkerD:process_table_unavailable',
        memberName: 'WorkerD',
        severity: 'warning',
        code: 'process_table_unavailable',
        label: 'WorkerD - process table unavailable',
        detail: 'process table temporarily unavailable',
        observedAt: NOW,
      },
      {
        id: 'WorkerE:tmux_shell_only',
        memberName: 'WorkerE',
        severity: 'warning',
        code: 'tmux_shell_only',
        label: 'WorkerE - shell only',
        detail: 'tmux pane only',
        observedAt: NOW,
      },
      {
        id: 'WorkerF:runtime_process_candidate',
        memberName: 'WorkerF',
        severity: 'warning',
        code: 'runtime_process_candidate',
        label: 'WorkerF - bootstrap unconfirmed',
        detail: 'process found but bootstrap missing',
        observedAt: NOW,
      },
      {
        id: 'WorkerG:runtime_process_detected',
        memberName: 'WorkerG',
        severity: 'info',
        code: 'runtime_process_detected',
        label: 'WorkerG - waiting for bootstrap',
        detail: 'process found',
        observedAt: NOW,
      },
      {
        id: 'WorkerH:runtime_not_found',
        memberName: 'WorkerH',
        severity: 'warning',
        code: 'runtime_not_found',
        label: 'WorkerH - waiting for runtime',
        detail: 'registered only',
        observedAt: NOW,
      },
      {
        id: 'WorkerI:runtime_not_found',
        memberName: 'WorkerI',
        severity: 'warning',
        code: 'runtime_not_found',
        label: 'WorkerI - waiting for runtime',
        detail: 'stale metadata',
        observedAt: NOW,
      },
      {
        id: 'WorkerJ:runtime_not_found',
        memberName: 'WorkerJ',
        severity: 'warning',
        code: 'runtime_not_found',
        label: 'WorkerJ - waiting for runtime',
        detail: 'no runtime',
        observedAt: NOW,
      },
      {
        id: 'WorkerK:spawn_accepted',
        memberName: 'WorkerK',
        severity: 'info',
        code: 'spawn_accepted',
        label: 'WorkerK - spawn accepted',
        detail: 'spawn accepted',
        observedAt: NOW,
      },
    ]);
  });

  it('classifies bootstrap-confirmed provisioned-but-not-alive entries as confirmed', () => {
    const diagnostics = buildLaunchDiagnosticsFromRun(
      buildRun([
        [
          'tom',
          {
            status: 'error',
            launchState: 'failed_to_start',
            bootstrapConfirmed: true,
            hardFailure: true,
            hardFailureReason: 'CLI process exited (code 1) \u2014 team provisioned but not alive',
            livenessKind: 'confirmed_bootstrap',
            runtimeDiagnostic:
              'runtime pid could not be verified because process table is unavailable',
            runtimeDiagnosticSeverity: 'warning',
          },
        ],
      ]),
      { nowIso }
    );

    expect(diagnostics).toEqual([
      {
        id: 'tom:bootstrap_confirmed',
        memberName: 'tom',
        severity: 'info',
        code: 'bootstrap_confirmed',
        label: 'tom - bootstrap confirmed',
        observedAt: NOW,
      },
    ]);
  });

  it('classifies process-table-unavailable registered metadata as confirmed', () => {
    const diagnostics = buildLaunchDiagnosticsFromRun(
      buildRun([
        [
          'tom',
          {
            status: 'error',
            launchState: 'failed_to_start',
            bootstrapConfirmed: true,
            hardFailure: true,
            hardFailureReason:
              'CLI process exited (code 1) - team provisioned but not alive; process table unavailable',
            livenessKind: 'registered_only',
            runtimeDiagnostic:
              'runtime pid could not be verified because process table is unavailable',
            runtimeDiagnosticSeverity: 'warning',
          },
        ],
      ]),
      { nowIso }
    );

    expect(diagnostics).toEqual([
      {
        id: 'tom:bootstrap_confirmed',
        memberName: 'tom',
        severity: 'info',
        code: 'bootstrap_confirmed',
        label: 'tom - bootstrap confirmed',
        observedAt: NOW,
      },
    ]);
  });

  it('keeps error diagnostics for bootstrap-confirmed provisioned-but-not-alive entries', () => {
    const diagnostics = buildLaunchDiagnosticsFromRun(
      buildRun([
        [
          'tom',
          {
            status: 'error',
            launchState: 'failed_to_start',
            bootstrapConfirmed: true,
            hardFailure: true,
            hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
            livenessKind: 'confirmed_bootstrap',
            runtimeDiagnostic: 'Runtime process crashed',
            runtimeDiagnosticSeverity: 'error',
          },
        ],
      ]),
      { nowIso }
    );

    expect(diagnostics).toEqual([
      {
        id: 'tom:bootstrap_stalled',
        memberName: 'tom',
        severity: 'error',
        code: 'bootstrap_stalled',
        label: 'tom - launch diagnostic error',
        detail: 'Runtime process crashed',
        observedAt: NOW,
      },
    ]);
  });

  it('keeps stopped liveness diagnostics for bootstrap-confirmed provisioned-but-not-alive entries', () => {
    const diagnostics = buildLaunchDiagnosticsFromRun(
      buildRun([
        [
          'tom',
          {
            status: 'error',
            launchState: 'failed_to_start',
            bootstrapConfirmed: true,
            hardFailure: true,
            hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
            livenessKind: 'not_found',
            runtimeDiagnostic: 'Runtime is no longer registered',
            runtimeDiagnosticSeverity: 'warning',
          },
        ],
      ]),
      { nowIso }
    );

    expect(diagnostics).toEqual([
      {
        id: 'tom:bootstrap_stalled',
        memberName: 'tom',
        severity: 'error',
        code: 'bootstrap_stalled',
        label: 'tom - launch diagnostic error',
        detail: 'Runtime is no longer registered',
        observedAt: NOW,
      },
    ]);
  });

  it('uses failed launch error when hard failure reason is absent', () => {
    expect(
      buildLaunchDiagnosticsFromRun(
        buildRun([['Worker', { launchState: 'failed_to_start', error: 'spawn failed' }]]),
        { nowIso }
      )?.[0]
    ).toMatchObject({
      id: 'Worker:bootstrap_stalled',
      detail: 'spawn failed',
    });
  });

  it('recognizes process table unavailable diagnostics case-insensitively', () => {
    expect(mentionsProcessTableUnavailable('Process table is currently unavailable')).toBe(true);
    expect(mentionsProcessTableUnavailable('process runtime unavailable')).toBe(false);
    expect(mentionsProcessTableUnavailable(undefined)).toBe(false);
  });

  it('builds workspace trust launch diagnostics for blocked, soft-failed, and completed preflight results', () => {
    expect(
      buildWorkspaceTrustPreflightLaunchDiagnostic(
        workspaceTrustExecution({
          status: 'blocked',
          errorCode: 'workspace_trust_required',
          errorMessage: '  trust must be accepted  ',
          evidence: ['fallback evidence'],
        }),
        { nowIso }
      )
    ).toEqual({
      id: 'workspace-trust:preflight',
      severity: 'error',
      code: 'workspace_trust_preflight',
      label: 'Workspace trust preflight blocked launch',
      detail: 'trust must be accepted',
      observedAt: NOW,
    });

    expect(
      buildWorkspaceTrustPreflightLaunchDiagnostic(
        workspaceTrustExecution({
          status: 'soft_failed',
          errorCode: 'workspace_trust_probe_failed',
          evidence: ['fallback evidence'],
        }),
        { nowIso }
      )
    ).toMatchObject({
      severity: 'warning',
      label: 'Workspace trust preflight could not verify trust',
      detail: 'workspace_trust_probe_failed',
    });

    expect(
      buildWorkspaceTrustPreflightLaunchDiagnostic(
        workspaceTrustExecution({
          status: 'ok',
          evidence: ['   ', ' trusted from state probe '],
        }),
        { nowIso }
      )
    ).toMatchObject({
      severity: 'info',
      label: 'Workspace trust preflight completed',
      detail: 'trusted from state probe',
    });
  });

  it('omits cancelled workspace trust launch diagnostics', () => {
    expect(
      buildWorkspaceTrustPreflightLaunchDiagnostic(
        workspaceTrustExecution({ status: 'cancelled' }),
        { nowIso }
      )
    ).toBeNull();
  });

  it('merges launch diagnostic items by id without mutating existing diagnostics', () => {
    const existing: TeamLaunchDiagnosticItem[] = [
      {
        id: 'old',
        severity: 'info',
        code: 'spawn_accepted',
        label: 'Old',
        observedAt: NOW,
      },
      {
        id: 'same',
        severity: 'warning',
        code: 'runtime_not_found',
        label: 'Previous',
        observedAt: NOW,
      },
    ];
    const replacement: TeamLaunchDiagnosticItem = {
      id: 'same',
      severity: 'error',
      code: 'bootstrap_stalled',
      label: 'Replacement',
      observedAt: NOW,
    };

    expect(mergeLaunchDiagnosticItem(existing, replacement)).toEqual([existing[0], replacement]);
    expect(existing[1].label).toBe('Previous');
    expect(mergeLaunchDiagnosticItem(undefined, replacement)).toEqual([replacement]);
  });
});
