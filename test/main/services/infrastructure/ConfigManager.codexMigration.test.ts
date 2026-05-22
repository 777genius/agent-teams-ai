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

  it('loads legacy Anthropic provider connections with compatible endpoint defaults', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-anthropic-compatible-default-'));
    const configPath = path.join(tempRoot, 'agent-teams-config.json');

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        providerConnections: {
          anthropic: {
            authMode: 'oauth',
            fastModeDefault: true,
          },
        },
      })
    );

    const { ConfigManager } = await import(
      '../../../../src/main/services/infrastructure/ConfigManager'
    );

    const manager = new ConfigManager(configPath);
    const config = manager.getConfig();

    expect(config.providerConnections.anthropic).toEqual({
      authMode: 'oauth',
      fastModeDefault: true,
      compatibleEndpoint: {
        enabled: false,
        baseUrl: '',
      },
    });

    await vi.waitFor(() => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        providerConnections: {
          anthropic: {
            compatibleEndpoint: { enabled: boolean; baseUrl: string };
          };
        };
      };

      expect(persisted.providerConnections.anthropic.compatibleEndpoint).toEqual({
        enabled: false,
        baseUrl: '',
      });
    });
  });

  it('deep-merges partial Anthropic compatible endpoint updates', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-anthropic-compatible-update-'));
    const configPath = path.join(tempRoot, 'agent-teams-config.json');

    const { ConfigManager } = await import(
      '../../../../src/main/services/infrastructure/ConfigManager'
    );

    const manager = new ConfigManager(configPath);
    manager.updateConfig('providerConnections', {
      anthropic: {
        authMode: 'oauth',
        fastModeDefault: true,
      },
    } as never);

    await vi.waitFor(() => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        providerConnections: {
          anthropic: {
            authMode: string;
            fastModeDefault: boolean;
          };
        };
      };

      expect(persisted.providerConnections.anthropic.authMode).toBe('oauth');
      expect(persisted.providerConnections.anthropic.fastModeDefault).toBe(true);
    });

    const updated = manager.updateConfig('providerConnections', {
      anthropic: {
        compatibleEndpoint: {
          baseUrl: ' http://localhost:1234 ',
        },
      },
    } as never);

    expect(updated.providerConnections.anthropic).toEqual({
      authMode: 'oauth',
      fastModeDefault: true,
      compatibleEndpoint: {
        enabled: false,
        baseUrl: 'http://localhost:1234',
      },
    });

    await vi.waitFor(() => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        providerConnections: {
          anthropic: {
            authMode: string;
            fastModeDefault: boolean;
            compatibleEndpoint: { enabled: boolean; baseUrl: string };
          };
        };
      };

      expect(persisted.providerConnections.anthropic).toEqual({
        authMode: 'oauth',
        fastModeDefault: true,
        compatibleEndpoint: {
          enabled: false,
          baseUrl: 'http://localhost:1234',
        },
      });
    });
  });

  it('strips derived Anthropic compatible endpoint token status when loading config', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-anthropic-compatible-derived-'));
    const configPath = path.join(tempRoot, 'agent-teams-config.json');

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        providerConnections: {
          anthropic: {
            authMode: 'auto',
            compatibleEndpoint: {
              enabled: true,
              baseUrl: ' http://localhost:1234 ',
              tokenConfigured: true,
              tokenSource: 'stored',
              tokenSourceLabel: 'Stored in app',
            },
          },
        },
      })
    );

    const { ConfigManager } = await import(
      '../../../../src/main/services/infrastructure/ConfigManager'
    );

    const manager = new ConfigManager(configPath);
    expect(manager.getConfig().providerConnections.anthropic.compatibleEndpoint).toEqual({
      enabled: true,
      baseUrl: 'http://localhost:1234',
    });

    await vi.waitFor(() => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        providerConnections: {
          anthropic: {
            compatibleEndpoint: Record<string, unknown>;
          };
        };
      };

      expect(persisted.providerConnections.anthropic.compatibleEndpoint).toEqual({
        enabled: true,
        baseUrl: 'http://localhost:1234',
      });
    });
  });

  it('strips derived Anthropic compatible endpoint token status from partial updates', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-anthropic-compatible-derived-update-'));
    const configPath = path.join(tempRoot, 'agent-teams-config.json');

    const { ConfigManager } = await import(
      '../../../../src/main/services/infrastructure/ConfigManager'
    );

    const manager = new ConfigManager(configPath);
    const updated = manager.updateConfig('providerConnections', {
      anthropic: {
        compatibleEndpoint: {
          enabled: true,
          baseUrl: 'http://localhost:1234',
          tokenConfigured: true,
          tokenSource: 'environment',
        },
      },
    } as never);

    expect(updated.providerConnections.anthropic.compatibleEndpoint).toEqual({
      enabled: true,
      baseUrl: 'http://localhost:1234',
    });

    await vi.waitFor(() => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        providerConnections: {
          anthropic: {
            compatibleEndpoint: Record<string, unknown>;
          };
        };
      };

      expect(persisted.providerConnections.anthropic.compatibleEndpoint).toEqual({
        enabled: true,
        baseUrl: 'http://localhost:1234',
      });
    });
  });
});
