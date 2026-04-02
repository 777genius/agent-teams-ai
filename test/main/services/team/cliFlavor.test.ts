// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const getConfigMock = vi.fn();

vi.mock('@main/services/infrastructure/ConfigManager', () => ({
  configManager: {
    getConfig: () => getConfigMock(),
  },
}));

describe('cliFlavor', () => {
  afterEach(() => {
    delete process.env.CLAUDE_TEAM_CLI_FLAVOR;
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('uses multimodel runtime by default when config enables it', async () => {
    getConfigMock.mockReturnValue({
      general: {
        multimodelEnabled: true,
      },
    });

    const { getConfiguredCliFlavor } = await import('@main/services/team/cliFlavor');

    expect(getConfiguredCliFlavor()).toBe('free-code');
  });

  it('uses claude runtime when multimodel is disabled in config', async () => {
    getConfigMock.mockReturnValue({
      general: {
        multimodelEnabled: false,
      },
    });

    const { getConfiguredCliFlavor } = await import('@main/services/team/cliFlavor');

    expect(getConfiguredCliFlavor()).toBe('claude');
  });

  it('lets env override the persisted config', async () => {
    process.env.CLAUDE_TEAM_CLI_FLAVOR = 'claude';
    getConfigMock.mockReturnValue({
      general: {
        multimodelEnabled: true,
      },
    });

    const { getConfiguredCliFlavor } = await import('@main/services/team/cliFlavor');

    expect(getConfiguredCliFlavor()).toBe('claude');
  });
});
