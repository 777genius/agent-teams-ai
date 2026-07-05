import {
  attachLiveRuntimeMetadataToStatuses,
  buildRuntimeDiagnosticForSpawn,
} from '@main/services/team/provisioning/TeamProvisioningRuntimeSnapshot';
import { describe, expect, it } from 'vitest';

import type { MemberSpawnStatusEntry } from '@shared/types';

const baseStatus = (
  patch: Partial<MemberSpawnStatusEntry> = {}
): MemberSpawnStatusEntry => ({
  status: 'spawning',
  launchState: 'starting',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...patch,
});

describe('TeamProvisioningRuntimeSnapshot', () => {
  it('attaches strong live runtime metadata to spawn statuses', () => {
    const result = attachLiveRuntimeMetadataToStatuses({
      statuses: {
        builder: baseStatus(),
      },
      runtimeByMember: new Map([
        [
          'builder',
          {
            alive: true,
            model: 'gpt-worker',
            livenessKind: 'runtime_process',
            runtimeDiagnostic: 'runtime process is alive',
            runtimeDiagnosticSeverity: 'info',
          },
        ],
      ]),
      isOpenCodeBootstrapStallWindowElapsed: () => false,
    });

    expect(result.builder).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: true,
      runtimeModel: 'gpt-worker',
      livenessKind: 'runtime_process',
      livenessSource: 'process',
      runtimeDiagnostic: 'runtime process is alive',
      runtimeDiagnosticSeverity: 'info',
    });
  });

  it('does not revive skipped launch members from live runtime metadata', () => {
    const result = attachLiveRuntimeMetadataToStatuses({
      statuses: {
        reviewer: baseStatus({
          status: 'skipped',
          launchState: 'skipped_for_launch',
          skippedForLaunch: true,
          hardFailure: true,
          hardFailureReason: 'previous failure',
          error: 'previous failure',
        }),
      },
      runtimeByMember: new Map([
        [
          'reviewer',
          {
            alive: true,
            livenessKind: 'runtime_process',
          },
        ],
      ]),
      isOpenCodeBootstrapStallWindowElapsed: () => false,
    });

    expect(result.reviewer).toMatchObject({
      status: 'skipped',
      launchState: 'skipped_for_launch',
      skippedForLaunch: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      hardFailureReason: undefined,
      error: undefined,
      livenessSource: undefined,
    });
  });

  it('heals confirmed native bootstrap-control failures when runtime is alive', () => {
    const result = attachLiveRuntimeMetadataToStatuses({
      statuses: {
        cody: baseStatus({
          status: 'error',
          launchState: 'failed_to_start',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            '<agent_teams_native_bootstrap_control> System-level bootstrap rules </agent_teams_native_bootstrap_control>',
          error:
            '<agent_teams_native_bootstrap_control> System-level bootstrap rules </agent_teams_native_bootstrap_control>',
        }),
      },
      runtimeByMember: new Map([
        [
          'cody',
          {
            alive: true,
            livenessKind: 'runtime_process',
            runtimeDiagnostic: 'verified runtime process detected',
            runtimeDiagnosticSeverity: 'info',
          },
        ],
      ]),
      isOpenCodeBootstrapStallWindowElapsed: () => false,
    });

    expect(result.cody).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      hardFailureReason: undefined,
      error: undefined,
    });
  });

  it('keeps runtime error evidence after healing confirmed native bootstrap-control failures', () => {
    const result = attachLiveRuntimeMetadataToStatuses({
      statuses: {
        cody: baseStatus({
          status: 'error',
          launchState: 'failed_to_start',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            '<agent_teams_native_bootstrap_control>\nSystem-level bootstrap rules:\n- This is a private startup context handoff.',
          error:
            '<agent_teams_native_bootstrap_control>\nSystem-level bootstrap rules:\n- This is a private startup context handoff.',
        }),
      },
      runtimeByMember: new Map([
        [
          'cody',
          {
            alive: false,
            livenessKind: 'not_found',
            runtimeDiagnostic: 'Runtime process crashed',
            runtimeDiagnosticSeverity: 'error',
          },
        ],
      ]),
      isOpenCodeBootstrapStallWindowElapsed: () => false,
    });

    expect(result.cody).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: false,
      bootstrapConfirmed: true,
      hardFailure: false,
      hardFailureReason: undefined,
      error: undefined,
      livenessKind: 'not_found',
      runtimeDiagnostic: 'Runtime process crashed',
      runtimeDiagnosticSeverity: 'error',
    });
  });

  it('marks OpenCode secondary bootstrap pending members stalled after the deadline', () => {
    const result = attachLiveRuntimeMetadataToStatuses({
      statuses: {
        implementer: baseStatus({
          status: 'waiting',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
      runtimeByMember: new Map(),
      openCodeSecondaryBootstrapPendingMembers: new Set(['implementer']),
      isOpenCodeBootstrapStallWindowElapsed: () => true,
    });

    expect(result.implementer).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      bootstrapStalled: true,
      livenessKind: 'registered_only',
      runtimeDiagnosticSeverity: 'warning',
    });
    expect(result.implementer?.runtimeDiagnostic).toContain('bootstrap');
  });

  it('preserves process table unavailable evidence in spawn diagnostics', () => {
    expect(
      buildRuntimeDiagnosticForSpawn({
        alive: false,
        runtimeDiagnostic: 'persisted runtime pid is not alive',
        diagnostics: ['process table unavailable'],
      })
    ).toBe('persisted runtime pid is not alive; process table unavailable');
  });
});
