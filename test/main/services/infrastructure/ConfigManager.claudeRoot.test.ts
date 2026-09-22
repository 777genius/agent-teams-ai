import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('ConfigManager CLAUDE_ROOT support', () => {
  afterEach(async () => {
    vi.resetModules();
    delete process.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT;
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(null);
  });

  it('resolves the default config path from the current Claude base path override', async () => {
    vi.resetModules();

    const overrideRoot = path.join(os.tmpdir(), 'claude-root-test');
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(overrideRoot);

    const { configManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');

    expect(configManager.getConfigPath()).toBe(path.join(overrideRoot, 'agent-teams-config.json'));
  });

  it('keeps the Electron dev Claude root override above default config values', async () => {
    vi.resetModules();

    const overrideRoot = path.join(os.tmpdir(), 'electron-dev-claude-root-test');
    process.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT = overrideRoot;

    const overrides = await import('../../../../src/main/utils/electronDevPathOverrides');
    overrides.applyElectronDevPathOverrides({});

    const { ConfigManager } = await import(
      '../../../../src/main/services/infrastructure/ConfigManager'
    );
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');

    const manager = new ConfigManager(path.join(os.tmpdir(), 'missing-agent-teams-config.json'));

    expect(manager.getConfig().general.claudeRootPath).toBeNull();
    expect(pathDecoder.getClaudeBasePath()).toBe(overrideRoot);
  });
});
