// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('cliFlavor', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('uses multimodel runtime by default', async () => {
    vi.stubEnv('CLAUDE_TEAM_CLI_FLAVOR', undefined);
    const { getConfiguredCliFlavor } = await import('@main/services/team/cliFlavor');

    expect(getConfiguredCliFlavor()).toBe('agent_teams_orchestrator');
  });

  it.each(['development', 'production', 'test'])(
    'ignores every legacy flavor override in %s',
    async (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      const { getConfiguredCliFlavor, getConfiguredCliCommandLabel } =
        await import('@main/services/team/cliFlavor');

      for (const flavor of ['claude', ' claude ', 'agent_teams_orchestrator', '', 'unknown']) {
        vi.stubEnv('CLAUDE_TEAM_CLI_FLAVOR', flavor);

        expect(getConfiguredCliFlavor()).toBe('agent_teams_orchestrator');
        expect(getConfiguredCliCommandLabel()).toBe('orchestrator-cli');
      }
    }
  );
});
