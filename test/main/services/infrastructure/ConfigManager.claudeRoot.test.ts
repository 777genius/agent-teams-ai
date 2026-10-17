import * as fs from 'fs/promises';
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

  it('keeps an explicitly established Claude root when no root is configured', async () => {
    vi.resetModules();

    // Mirrors standalone startup: CLAUDE_ROOT is applied before services
    // initialize, and the default config carries no claudeRootPath. Loading
    // the configuration must not reset the explicit root to auto-detection.
    const standaloneRoot = path.join(os.tmpdir(), 'standalone-claude-root-test');
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(standaloneRoot);

    const { ConfigManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');
    const manager = new ConfigManager(path.join(os.tmpdir(), 'missing-agent-teams-config.json'));

    expect(manager.getConfig().general.claudeRootPath).toBeNull();
    expect(pathDecoder.getClaudeBasePath()).toBe(standaloneRoot);
  });

  it('clears a ConfigManager-applied root when the configuration carries none', async () => {
    vi.resetModules();

    // A root that ConfigManager itself applied from a persisted preference is
    // owned by ConfigManager: once the preference disappears, loading must
    // return to auto-detection instead of pinning the stale value.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-root-configured-'));
    try {
      const configuredRoot = path.join(os.tmpdir(), 'claude-root-applied');
      await fs.writeFile(
        path.join(dir, 'agent-teams-config.json'),
        JSON.stringify({ general: { claudeRootPath: configuredRoot } })
      );
      const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
      const { ConfigManager } =
        await import('../../../../src/main/services/infrastructure/ConfigManager');

      new ConfigManager(path.join(dir, 'agent-teams-config.json'));
      expect(pathDecoder.getClaudeBasePath()).toBe(configuredRoot);

      // The constructor persists normalized config asynchronously; wait for
      // the rewrite (which adds sections absent from the seed file) before
      // removing the directory so no write races the cleanup.
      const configPath = path.join(dir, 'agent-teams-config.json');
      await vi.waitFor(async () => {
        const raw = await fs.readFile(configPath, 'utf8');
        expect(raw).toContain('"notifications"');
      });

      new ConfigManager(path.join(os.tmpdir(), 'missing-agent-teams-config.json'));
      expect(pathDecoder.getClaudeBasePath()).not.toBe(configuredRoot);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves an external override set after ConfigManager applied its own root', async () => {
    vi.resetModules();

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-root-external-'));
    try {
      const configuredRoot = path.join(os.tmpdir(), 'claude-root-applied');
      await fs.writeFile(
        path.join(dir, 'agent-teams-config.json'),
        JSON.stringify({ general: { claudeRootPath: configuredRoot } })
      );
      const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
      const { ConfigManager } =
        await import('../../../../src/main/services/infrastructure/ConfigManager');

      new ConfigManager(path.join(dir, 'agent-teams-config.json'));
      expect(pathDecoder.getClaudeBasePath()).toBe(configuredRoot);

      const configPath = path.join(dir, 'agent-teams-config.json');
      await vi.waitFor(async () => {
        const raw = await fs.readFile(configPath, 'utf8');
        expect(raw).toContain('"notifications"');
      });

      // An explicit root established elsewhere afterwards is no longer the
      // value ConfigManager owns, so a later load without a preference keeps it.
      const externalRoot = path.join(os.tmpdir(), 'claude-root-external-value');
      pathDecoder.setClaudeBasePathOverride(externalRoot);
      new ConfigManager(path.join(os.tmpdir(), 'missing-agent-teams-config.json'));
      expect(pathDecoder.getClaudeBasePath()).toBe(externalRoot);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the Electron dev Claude root override above default config values', async () => {
    vi.resetModules();

    const overrideRoot = path.join(os.tmpdir(), 'electron-dev-claude-root-test');
    process.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT = overrideRoot;

    const overrides = await import('../../../../src/main/utils/electronDevPathOverrides');
    overrides.applyElectronDevPathOverrides({});

    const { ConfigManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');

    const manager = new ConfigManager(path.join(os.tmpdir(), 'missing-agent-teams-config.json'));

    expect(manager.getConfig().general.claudeRootPath).toBeNull();
    expect(pathDecoder.getClaudeBasePath()).toBe(overrideRoot);
  });
});
