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
    const configPath = path.join(overrideRoot, 'claude-devtools-config.json');
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

    const { configManager } = await import(
      '../../../../src/main/services/infrastructure/ConfigManager'
    );
    const config = configManager.getConfig();

    expect(config.notifications.autoResumeOnRateLimit).toBe(true);
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
});
