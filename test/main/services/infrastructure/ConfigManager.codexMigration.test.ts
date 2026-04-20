import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('ConfigManager Codex migration hardening', () => {
  let tempRoot: string | null = null;

  afterEach(async () => {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
    vi.resetModules();
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(null);
  });

  it('persists the normalized Codex auth and runtime shape after loading a legacy config', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-codex-migration-'));
    const configPath = path.join(tempRoot, 'claude-devtools-config.json');

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        providerConnections: {
          codex: {
            authMode: 'oauth',
            apiKeyBetaEnabled: true,
          },
        },
        runtime: {
          providerBackends: {
            codex: 'api',
          },
        },
      })
    );

    const { ConfigManager } = await import(
      '../../../../src/main/services/infrastructure/ConfigManager'
    );

    const manager = new ConfigManager(configPath);
    const config = manager.getConfig();

    expect(config.providerConnections.codex.preferredAuthMode).toBe('chatgpt');
    expect(config.runtime.providerBackends.codex).toBe('codex-native');

    await vi.waitFor(() => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        providerConnections: { codex: Record<string, unknown> };
        runtime: { providerBackends: { codex: string } };
      };

      expect(persisted.providerConnections.codex).toEqual({
        preferredAuthMode: 'chatgpt',
      });
      expect(persisted.runtime.providerBackends.codex).toBe('codex-native');
    });
  });

  it('normalizes legacy Codex runtime backend updates inside ConfigManager updateConfig', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-codex-runtime-update-'));
    const configPath = path.join(tempRoot, 'claude-devtools-config.json');

    const { ConfigManager } = await import(
      '../../../../src/main/services/infrastructure/ConfigManager'
    );

    const manager = new ConfigManager(configPath);
    const updated = manager.updateConfig('runtime', {
      providerBackends: {
        codex: 'api' as never,
      },
    } as never);

    expect(updated.runtime.providerBackends.codex).toBe('codex-native');

    await vi.waitFor(() => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        runtime: { providerBackends: { codex: string } };
      };

      expect(persisted.runtime.providerBackends.codex).toBe('codex-native');
    });
  });
});
