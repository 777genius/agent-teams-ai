import { describe, expect, it, vi } from 'vitest';

import { TeamRuntimeAdapterRegistry } from '../../runtime';
import { TeamProvisioningAppShellFacade } from '../TeamProvisioningAppShellFacade';

import type { TeamLaunchRuntimeAdapter, TeamRuntimeProviderId } from '../../runtime';
import type { TeamProvisioningAppShellBoundary } from '../TeamProvisioningAppShellBoundary';
import type { WorkspaceTrustCoordinator } from '@features/workspace-trust/main';

class TestAppShellFacade extends TeamProvisioningAppShellFacade {
  getAppShellBoundary(): TeamProvisioningAppShellBoundary {
    return this.appShellBoundary;
  }
}

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

describe('TeamProvisioningAppShellFacade', () => {
  it('delegates public app-shell compatibility methods to the boundary', async () => {
    const facade = new TestAppShellFacade();
    const boundary = facade.getAppShellBoundary();
    const opencodeAdapter = createRuntimeAdapter('opencode', {
      sendMessageToMember: vi.fn(),
      listRuntimePermissions: vi.fn(),
    });
    const registry = new TeamRuntimeAdapterRegistry([
      createRuntimeAdapter('codex'),
      opencodeAdapter,
    ]);
    const invalidator = vi.fn();
    const scheduler = vi.fn(() => ({ scheduled: true }));
    const checker = vi.fn(async () => true);
    const sender = vi.fn(async () => ({ messageId: 'cross-1', deliveredToInbox: true }));
    const controlResolver = vi.fn(async () => 'http://127.0.0.1:43123');
    const workspaceTrustCoordinator = { execute: vi.fn() } as unknown as WorkspaceTrustCoordinator;
    const hookSettingsProvider = vi.fn(async () => ({ hooks: { Stop: [] } }));
    const environmentProvider = vi.fn(async () => ({ CODEX_TURN_SETTLED: '1' }));

    facade.setRuntimeAdapterRegistry(registry);
    facade.setMemberRuntimeAdvisoryInvalidator(invalidator);
    facade.setMemberWorkSyncProofMissingRecoveryScheduler(scheduler);
    facade.setMemberWorkSyncAcceptedReportChecker(checker);
    facade.setCrossTeamSender(sender);
    facade.setControlApiBaseUrlResolver(controlResolver);
    facade.setWorkspaceTrustCoordinator(workspaceTrustCoordinator);
    facade.setRuntimeTurnSettledHookSettingsProvider(hookSettingsProvider);
    facade.setRuntimeTurnSettledEnvironmentProvider(environmentProvider);

    expect(facade.getOpenCodeRuntimeAdapter()).toBe(opencodeAdapter);
    expect(boundary.getRuntimeAdapterRegistry()).toBe(registry);
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
  });
});
