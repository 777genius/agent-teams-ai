import { shouldWatchTeamAgentRuntime } from '@renderer/components/team/useTeamAgentRuntimeWatcher';
import { describe, expect, it } from 'vitest';

describe('shouldWatchTeamAgentRuntime', () => {
  it('does not poll runtime for explicitly offline teams with stale lead activity', () => {
    expect(
      shouldWatchTeamAgentRuntime({
        enabled: true,
        isTeamProvisioning: false,
        isTeamAlive: false,
        leadActivity: 'idle',
      })
    ).toBe(false);
    expect(
      shouldWatchTeamAgentRuntime({
        enabled: true,
        isTeamProvisioning: false,
        isTeamAlive: false,
        leadActivity: 'active',
      })
    ).toBe(false);
  });

  it('keeps runtime polling for live and provisioning teams', () => {
    expect(
      shouldWatchTeamAgentRuntime({
        enabled: true,
        isTeamProvisioning: false,
        isTeamAlive: true,
        leadActivity: 'offline',
      })
    ).toBe(true);
    expect(
      shouldWatchTeamAgentRuntime({
        enabled: true,
        isTeamProvisioning: true,
        isTeamAlive: false,
        leadActivity: 'offline',
      })
    ).toBe(true);
  });

  it('allows lead activity to request polling while liveness is still unknown', () => {
    expect(
      shouldWatchTeamAgentRuntime({
        enabled: true,
        isTeamProvisioning: false,
        isTeamAlive: undefined,
        leadActivity: 'idle',
      })
    ).toBe(true);
  });

  it('stays disabled for hidden tabs', () => {
    expect(
      shouldWatchTeamAgentRuntime({
        enabled: false,
        isTeamProvisioning: true,
        isTeamAlive: true,
        leadActivity: 'active',
      })
    ).toBe(false);
  });
});
