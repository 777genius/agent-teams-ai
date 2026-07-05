import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningOpenCodeBootstrapStallReconciliationPorts,
  createTeamProvisioningOpenCodeBootstrapStallStatusPorts,
} from '../TeamProvisioningBootstrapStallPortsFactory';
import { OPENCODE_MEMBER_BRIEFING_WITHOUT_CHECKIN_DIAGNOSTIC } from '../TeamProvisioningOpenCodeBootstrapStall';

import type { OpenCodeBootstrapStallRunLike } from '../TeamProvisioningOpenCodeBootstrapStall';
import type { MemberSpawnStatusEntry } from '@shared/types';

const NOW = '2026-01-01T00:00:00.000Z';

function status(overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'runtime_pending_bootstrap',
    updatedAt: NOW,
    firstSpawnAcceptedAt: NOW,
    ...overrides,
  };
}

function run(
  overrides: Partial<OpenCodeBootstrapStallRunLike> = {}
): OpenCodeBootstrapStallRunLike {
  return {
    runId: 'run-1',
    teamName: 'Team',
    request: { cwd: '/workspace' },
    provisioningOutputParts: [],
    memberSpawnStatuses: new Map(),
    progress: {} as never,
    onProgress: vi.fn(),
    isLaunch: true,
    provisioningComplete: false,
    ...overrides,
  };
}

describe('TeamProvisioningBootstrapStallPortsFactory', () => {
  it('creates status ports that forward the TeamProvisioning callbacks unchanged', () => {
    const targetRun = run();
    const previous = status({ launchState: 'starting' });
    const next = status();
    const dependencies = {
      nowIso: vi.fn(() => NOW),
      syncMemberTaskActivityForRuntimeTransition: vi.fn(),
      updateLaunchDiagnostics: vi.fn(),
      appendMemberBootstrapDiagnostic: vi.fn(),
      isCurrentTrackedRun: vi.fn(() => true),
      emitMemberSpawnChange: vi.fn(),
      persistLaunchStateSnapshot: vi.fn(async () => undefined),
    };

    const ports = createTeamProvisioningOpenCodeBootstrapStallStatusPorts(dependencies);

    expect(ports.nowIso()).toBe(NOW);
    ports.syncMemberTaskActivityForRuntimeTransition(targetRun, 'Builder', previous, next, NOW);
    ports.updateLaunchDiagnostics(targetRun, NOW);
    ports.appendMemberBootstrapDiagnostic(targetRun, 'Builder', 'diagnostic');
    expect(ports.isCurrentTrackedRun(targetRun)).toBe(true);
    ports.emitMemberSpawnChange(targetRun, 'Builder');
    ports.persistLaunchStateSnapshot(targetRun, 'active');

    expect(dependencies.syncMemberTaskActivityForRuntimeTransition).toHaveBeenCalledWith(
      targetRun,
      'Builder',
      previous,
      next,
      NOW
    );
    expect(dependencies.updateLaunchDiagnostics).toHaveBeenCalledWith(targetRun, NOW);
    expect(dependencies.appendMemberBootstrapDiagnostic).toHaveBeenCalledWith(
      targetRun,
      'Builder',
      'diagnostic'
    );
    expect(dependencies.isCurrentTrackedRun).toHaveBeenCalledWith(targetRun);
    expect(dependencies.emitMemberSpawnChange).toHaveBeenCalledWith(targetRun, 'Builder');
    expect(dependencies.persistLaunchStateSnapshot).toHaveBeenCalledWith(targetRun, 'active');
  });

  it('creates reconciliation ports with the same bootstrap stall helper wiring', async () => {
    const current = status({ runtimeDiagnostic: undefined });
    const targetRun = run({
      mixedSecondaryLanes: [
        {
          providerId: 'opencode',
          laneId: 'lane-1',
          runId: 'lane-run-1',
          member: { name: 'Builder', cwd: '/lane' },
          result: {
            diagnostics: [],
            members: {
              Builder: {
                memberName: 'Builder',
                bootstrapMode: 'model_tool_checkin',
                sessionId: 'session-1',
                diagnostics: [],
              },
            },
          } as never,
        },
      ],
    });
    const statusPorts = createTeamProvisioningOpenCodeBootstrapStallStatusPorts({
      nowIso: vi.fn(() => NOW),
      syncMemberTaskActivityForRuntimeTransition: vi.fn(),
      updateLaunchDiagnostics: vi.fn(),
      appendMemberBootstrapDiagnostic: vi.fn(),
      isCurrentTrackedRun: vi.fn(() => true),
      emitMemberSpawnChange: vi.fn(),
      persistLaunchStateSnapshot: vi.fn(),
    });
    const sendOpenCodeMemberMessageToRuntimeSerialized = vi.fn(async ({ send }) => await send());
    const adapter = {
      sendMessageToMember: vi.fn(async () => ({ ok: true, diagnostics: [] })),
    };
    const dependencies = {
      getOpenCodeBootstrapStallStatusPorts: vi.fn(() => statusPorts),
      findBootstrapTranscriptOutcome: vi.fn(async () => ({
        kind: 'success' as const,
        source: 'member_briefing' as const,
      })),
      getOpenCodeRuntimeMessageAdapter: vi.fn(() => adapter as never),
      sendOpenCodeMemberMessageToRuntimeSerialized,
      appendMemberBootstrapDiagnostic: vi.fn(),
      isCurrentTrackedRun: vi.fn(() => true),
      scheduleOpenCodeBootstrapStallReevaluation: vi.fn(),
    };

    const ports = createTeamProvisioningOpenCodeBootstrapStallReconciliationPorts(dependencies);

    await expect(
      ports.buildOpenCodeSecondaryBootstrapStallDiagnostic(targetRun, 'Builder', current)
    ).resolves.toBe(OPENCODE_MEMBER_BRIEFING_WITHOUT_CHECKIN_DIAGNOSTIC);
    ports.setOpenCodeRuntimePendingBootstrapStatus(targetRun, 'Builder', current, {
      bootstrapStalled: false,
      runtimeDiagnostic: 'pending',
      runtimeDiagnosticSeverity: 'info',
    });
    ports.setOpenCodeSecondaryBootstrapStalledStatus(targetRun, 'Builder', current, 'stalled');
    await ports.maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt({
      run: targetRun,
      memberName: 'Builder',
      current,
      runtimeDiagnostic: 'stalled',
      runtimeSessionId: 'session-1',
    });
    ports.scheduleOpenCodeBootstrapStallReevaluation(targetRun, 'Builder', NOW);

    expect(dependencies.findBootstrapTranscriptOutcome).toHaveBeenCalledWith(
      'Team',
      'Builder',
      Date.parse(NOW)
    );
    expect(dependencies.getOpenCodeBootstrapStallStatusPorts).toHaveBeenCalledTimes(2);
    expect(dependencies.getOpenCodeRuntimeMessageAdapter).toHaveBeenCalledTimes(1);
    expect(sendOpenCodeMemberMessageToRuntimeSerialized).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessageToMember).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'lane-run-1',
        teamName: 'Team',
        laneId: 'lane-1',
        memberName: 'Builder',
        cwd: '/lane',
      })
    );
    expect(dependencies.appendMemberBootstrapDiagnostic).toHaveBeenCalledWith(
      targetRun,
      'Builder',
      expect.stringContaining('opencode_bootstrap_checkin_retry_prompt_sent')
    );
    expect(dependencies.isCurrentTrackedRun).toHaveBeenCalledWith(targetRun);
    expect(dependencies.scheduleOpenCodeBootstrapStallReevaluation).toHaveBeenCalledWith(
      targetRun,
      'Builder',
      NOW
    );
  });
});
