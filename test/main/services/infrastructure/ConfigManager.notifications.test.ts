import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('ConfigManager notification config shape', () => {
  let overrideRoot: string | null = null;

  afterEach(async () => {
    if (overrideRoot) {
      fs.rmSync(overrideRoot, { recursive: true, force: true });
      overrideRoot = null;
    }
    vi.resetModules();
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(null);
  });

  it('strips unknown notification keys while keeping autoResumeOnRateLimit', async () => {
    vi.resetModules();

    overrideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-notifications-'));
    const configPath = path.join(overrideRoot, 'agent-teams-config.json');
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(overrideRoot);

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        notifications: {
          notifyOnInboxMessages: true,
          autoResumeOnRateLimit: true,
          notifyOnTeamLaunched: false,
        },
      })
    );

    const { configManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');
    const config = configManager.getConfig();

    expect(config.notifications.autoResumeOnRateLimit).toBe(true);
    expect(config.teamRuntimeRecovery.rateLimitsEnabled).toBe(true);
    expect(config.notifications.notifyOnTeamLaunched).toBe(false);
    expect('notifyOnInboxMessages' in config.notifications).toBe(false);

    await vi.waitFor(() => {
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        notifications: Record<string, unknown>;
      };
      expect(persisted.notifications.autoResumeOnRateLimit).toBe(true);
      expect(persisted.notifications.notifyOnTeamLaunched).toBe(false);
      expect('notifyOnInboxMessages' in persisted.notifications).toBe(false);
    });
  });

  it('prefers explicit recovery settings over the legacy rate-limit toggle and clamps persisted bounds', async () => {
    vi.resetModules();
    overrideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-recovery-'));
    const configPath = path.join(overrideRoot, 'agent-teams-config.json');
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(overrideRoot);
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        notifications: { autoResumeOnRateLimit: true },
        teamRuntimeRecovery: {
          transientErrorsEnabled: true,
          rateLimitsEnabled: false,
          initialDelaySeconds: 1,
          maxAttempts: 99,
        },
      })
    );

    const { configManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');

    expect(configManager.getConfig().teamRuntimeRecovery).toEqual({
      transientErrorsEnabled: true,
      rateLimitsEnabled: false,
      initialDelaySeconds: 15,
      maxAttempts: 5,
    });
    await vi.waitFor(() => {
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        teamRuntimeRecovery: { initialDelaySeconds: number; maxAttempts: number };
      };
      expect(persisted.teamRuntimeRecovery).toMatchObject({
        initialDelaySeconds: 15,
        maxAttempts: 5,
      });
    });
  });

  it('copies legacy config to the new Agent Teams config filename', async () => {
    vi.resetModules();

    overrideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-notifications-'));
    const legacyConfigPath = path.join(overrideRoot, 'claude-devtools-config.json');
    const configPath = path.join(overrideRoot, 'agent-teams-config.json');
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(overrideRoot);

    fs.writeFileSync(
      legacyConfigPath,
      JSON.stringify({
        notifications: {
          autoResumeOnRateLimit: true,
        },
      })
    );

    const { configManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');

    expect(configManager.getConfigPath()).toBe(configPath);
    expect(configManager.getConfig().notifications.autoResumeOnRateLimit).toBe(true);
    expect(fs.existsSync(legacyConfigPath)).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);

    await vi.waitFor(() => {
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        notifications: Record<string, unknown>;
      };
      expect(persisted.notifications.autoResumeOnRateLimit).toBe(true);
      expect(persisted.notifications.enabled).toBe(true);
    });
  });

  it('does not overwrite an existing Agent Teams config with legacy config', async () => {
    vi.resetModules();

    overrideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-notifications-'));
    const legacyConfigPath = path.join(overrideRoot, 'claude-devtools-config.json');
    const configPath = path.join(overrideRoot, 'agent-teams-config.json');
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(overrideRoot);

    fs.writeFileSync(
      legacyConfigPath,
      JSON.stringify({
        notifications: {
          autoResumeOnRateLimit: true,
        },
      })
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        notifications: {
          autoResumeOnRateLimit: false,
        },
      })
    );

    const { configManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');

    expect(configManager.getConfigPath()).toBe(configPath);
    expect(configManager.getConfig().notifications.autoResumeOnRateLimit).toBe(false);

    await vi.waitFor(() => {
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        notifications: Record<string, unknown>;
      };
      expect(persisted.notifications.autoResumeOnRateLimit).toBe(false);
      expect(persisted.notifications.enabled).toBe(true);
    });
  });

  it('copies pre-devtools legacy config when newer legacy config is absent', async () => {
    vi.resetModules();

    overrideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-notifications-'));
    const legacyConfigPath = path.join(overrideRoot, 'claude-code-context-config.json');
    const configPath = path.join(overrideRoot, 'agent-teams-config.json');
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(overrideRoot);

    fs.writeFileSync(
      legacyConfigPath,
      JSON.stringify({
        notifications: {
          autoResumeOnRateLimit: true,
        },
      })
    );

    const { configManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');

    expect(configManager.getConfigPath()).toBe(configPath);
    expect(configManager.getConfig().notifications.autoResumeOnRateLimit).toBe(true);
    expect(fs.existsSync(legacyConfigPath)).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);

    await vi.waitFor(() => {
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        notifications: Record<string, unknown>;
      };
      expect(persisted.notifications.autoResumeOnRateLimit).toBe(true);
      expect(persisted.notifications.enabled).toBe(true);
    });
  });

  it('prefers a valid older legacy config over an invalid newer legacy config', async () => {
    vi.resetModules();

    overrideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-notifications-'));
    const invalidNewerLegacyPath = path.join(overrideRoot, 'claude-devtools-config.json');
    const validOlderLegacyPath = path.join(overrideRoot, 'claude-code-context-config.json');
    const configPath = path.join(overrideRoot, 'agent-teams-config.json');
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(overrideRoot);

    fs.writeFileSync(invalidNewerLegacyPath, '', 'utf8');
    fs.writeFileSync(
      validOlderLegacyPath,
      JSON.stringify({
        notifications: {
          autoResumeOnRateLimit: true,
        },
      })
    );

    const { configManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');

    expect(configManager.getConfigPath()).toBe(configPath);
    expect(configManager.getConfig().notifications.autoResumeOnRateLimit).toBe(true);

    await vi.waitFor(() => {
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        notifications: Record<string, unknown>;
      };
      expect(persisted.notifications.autoResumeOnRateLimit).toBe(true);
      expect(persisted.notifications.enabled).toBe(true);
    });
    expect(fs.existsSync(validOlderLegacyPath)).toBe(true);
  });
});
