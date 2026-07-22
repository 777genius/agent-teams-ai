import { describe, expect, it, vi } from 'vitest';

import { TeamRuntimeAdapterRegistry } from '../../runtime';
import { TeamProvisioningAppShellBoundary } from '../TeamProvisioningAppShellBoundary';

import type { TeamLaunchRuntimeAdapter, TeamRuntimeProviderId } from '../../runtime';
import type { WorkspaceTrustCoordinator } from '@features/workspace-trust/main';

function createRuntimeAdapter(
  providerId: TeamRuntimeProviderId,
  overrides: Record<string, unknown> = {}
): TeamLaunchRuntimeAdapter {
  return {
    providerId,
    prepare: vi.fn(),
    launch: vi.fn(),
    reconcile: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  } as unknown as TeamLaunchRuntimeAdapter;
}

describe('TeamProvisioningAppShellBoundary', () => {
  it('resolves OpenCode runtime adapters from the current registry', () => {
    const boundary = new TeamProvisioningAppShellBoundary();
    const opencodeAdapter = createRuntimeAdapter('opencode', {
      sendMessageToMember: vi.fn(),
      listRuntimePermissions: vi.fn(),
    });
    const codexAdapter = createRuntimeAdapter('codex');
    const registry = new TeamRuntimeAdapterRegistry([codexAdapter, opencodeAdapter]);

    expect(boundary.getRuntimeAdapterRegistry()).toBeNull();
    expect(boundary.getOpenCodeRuntimeAdapter()).toBeNull();
    expect(boundary.getOpenCodeRuntimeMessageAdapter()).toBeNull();
    expect(boundary.getOpenCodeRuntimePermissionListingAdapter()).toBeNull();

    boundary.setRuntimeAdapterRegistry(registry);

    expect(boundary.getRuntimeAdapterRegistry()).toBe(registry);
    expect(boundary.getOpenCodeRuntimeAdapter()).toBe(opencodeAdapter);
    expect(boundary.getOpenCodeRuntimeMessageAdapter()).toBe(opencodeAdapter);
    expect(boundary.getOpenCodeRuntimePermissionListingAdapter()).toBe(opencodeAdapter);

    boundary.setRuntimeAdapterRegistry(null);

    expect(boundary.getRuntimeAdapterRegistry()).toBeNull();
    expect(boundary.getOpenCodeRuntimeAdapter()).toBeNull();
    expect(boundary.getOpenCodeRuntimeMessageAdapter()).toBeNull();
    expect(boundary.getOpenCodeRuntimePermissionListingAdapter()).toBeNull();
  });

  it('stores nullable app-shell callbacks and runtime planning providers', async () => {
    const boundary = new TeamProvisioningAppShellBoundary();
    const invalidator = vi.fn();
    const scheduler = vi.fn(() => ({ scheduled: true }));
    const checker = vi.fn(async () => true);
    const sender = vi.fn(async () => ({ messageId: 'cross-1', deliveredToInbox: true }));
    const controlResolver = vi.fn(async () => 'http://127.0.0.1:43123');
    const workspaceTrustCoordinator = { execute: vi.fn() } as unknown as WorkspaceTrustCoordinator;
    const hookSettingsProvider = vi.fn(async () => ({ hooks: { Stop: [] } }));
    const environmentProvider = vi.fn(async () => ({ CODEX_TURN_SETTLED: '1' }));

    boundary.setMemberRuntimeAdvisoryInvalidator(invalidator);
    boundary.setMemberWorkSyncProofMissingRecoveryScheduler(scheduler);
    boundary.setMemberWorkSyncAcceptedReportChecker(checker);
    boundary.setCrossTeamSender(sender);
    boundary.setControlApiBaseUrlResolver(controlResolver);
    boundary.setWorkspaceTrustCoordinator(workspaceTrustCoordinator);
    boundary.setRuntimeTurnSettledHookSettingsProvider(hookSettingsProvider);
    boundary.setRuntimeTurnSettledEnvironmentProvider(environmentProvider);

    boundary.getMemberRuntimeAdvisoryInvalidator()?.('Team', 'Builder');
    expect(invalidator).toHaveBeenCalledWith('Team', 'Builder');
    expect(
      boundary.getMemberWorkSyncProofMissingRecoveryScheduler()?.({
        teamName: 'Team',
        memberName: 'Builder',
        originalMessageId: 'msg-1',
      })
    ).toEqual({ scheduled: true });
    await expect(
      boundary.getMemberWorkSyncAcceptedReportChecker()?.({
        teamName: 'Team',
        memberName: 'Builder',
      })
    ).resolves.toBe(true);
    await expect(
      boundary.getCrossTeamSender()?.({
        fromTeam: 'Team',
        fromMember: 'Lead',
        toTeam: 'Other',
        text: 'hello',
      })
    ).resolves.toEqual({ messageId: 'cross-1', deliveredToInbox: true });
    await expect(boundary.getControlApiBaseUrlResolver()?.()).resolves.toBe(
      'http://127.0.0.1:43123'
    );
    expect(boundary.getWorkspaceTrustCoordinator()).toBe(workspaceTrustCoordinator);
    await expect(
      boundary.getRuntimeTurnSettledHookSettingsProvider()?.({ provider: 'claude' })
    ).resolves.toEqual({ hooks: { Stop: [] } });
    await expect(
      boundary.getRuntimeTurnSettledEnvironmentProvider()?.({ provider: 'codex' })
    ).resolves.toEqual({ CODEX_TURN_SETTLED: '1' });

    boundary.setMemberRuntimeAdvisoryInvalidator(null);
    boundary.setMemberWorkSyncProofMissingRecoveryScheduler(null);
    boundary.setMemberWorkSyncAcceptedReportChecker(null);
    boundary.setCrossTeamSender(null);
    boundary.setControlApiBaseUrlResolver(null);
    boundary.setWorkspaceTrustCoordinator(null);
    boundary.setRuntimeTurnSettledHookSettingsProvider(null);
    boundary.setRuntimeTurnSettledEnvironmentProvider(null);

    expect(boundary.getMemberRuntimeAdvisoryInvalidator()).toBeNull();
    expect(boundary.getMemberWorkSyncProofMissingRecoveryScheduler()).toBeNull();
    expect(boundary.getMemberWorkSyncAcceptedReportChecker()).toBeNull();
    expect(boundary.getCrossTeamSender()).toBeNull();
    expect(boundary.getControlApiBaseUrlResolver()).toBeNull();
    expect(boundary.getWorkspaceTrustCoordinator()).toBeNull();
    expect(boundary.getRuntimeTurnSettledHookSettingsProvider()).toBeNull();
    expect(boundary.getRuntimeTurnSettledEnvironmentProvider()).toBeNull();
  });
});
