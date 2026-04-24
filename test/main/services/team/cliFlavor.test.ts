// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('cliFlavor', () => {
  afterEach(() => {
    delete process.env.CLAUDE_TEAM_CLI_FLAVOR;
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('uses multimodel runtime by default', async () => {
    const { getConfiguredCliFlavor } = await import('@main/services/team/cliFlavor');

    expect(getConfiguredCliFlavor()).toBe('agent_teams_orchestrator');
  });

  it('ignores the legacy persisted multimodel flag', async () => {
    const { getConfiguredCliFlavor } = await import('@main/services/team/cliFlavor');

    expect(getConfiguredCliFlavor()).toBe('agent_teams_orchestrator');
  });

  it('lets env override the default runtime', async () => {
    process.env.CLAUDE_TEAM_CLI_FLAVOR = 'claude';

    const { getConfiguredCliFlavor } = await import('@main/services/team/cliFlavor');

    expect(getConfiguredCliFlavor()).toBe('claude');
  });
});
