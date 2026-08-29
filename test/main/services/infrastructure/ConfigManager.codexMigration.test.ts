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
    vi.doUnmock('@main/utils/atomicWrite');
    const pathDecoder = await import('../../../../src/main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(null);
  });

  it('serializes startup migration before an immediate runtime update', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-codex-write-order-'));
    const configPath = path.join(tempRoot, 'agent-teams-config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ runtime: { providerBackends: { codex: 'api' } } })
    );
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    vi.doMock('@main/utils/atomicWrite', () => ({
      atomicWriteAsync: vi.fn(async (targetPath: string, content: string) => {
        calls += 1;
        if (calls === 1) await firstGate;
        await fs.promises.writeFile(targetPath, content, 'utf8');
      }),
    }));
    const { ConfigManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');
    const manager = new ConfigManager(configPath);
    manager.updateConfig('runtime', { providerBackends: { codex: 'adapter' } } as never);

    await vi.waitFor(() => expect(calls).toBe(1));
    releaseFirst();
    await vi.waitFor(() => expect(calls).toBe(2));
    await vi.waitFor(() => {
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
        runtime: {
          providerBackendsVersion: 2,
          providerBackends: { codex: 'adapter' },
        },
      });
    });
  });

  it.each(['auto', 'adapter', 'api', 'codex-native'] as const)(
    'migrates a raw legacy Codex %s backend without treating it as a new route',
    async (legacyBackend) => {
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
              codex: legacyBackend,
            },
          },
        })
      );

      const { ConfigManager } =
        await import('../../../../src/main/services/infrastructure/ConfigManager');

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
          customProvider: {
            enabled: false,
            baseUrl: '',
            model: '',
          },
        });
        expect(persisted.runtime.providerBackends.codex).toBe('codex-native');
      });
    }
  );

  it('preserves the explicit Codex connection schema without reviving a legacy backend', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-codex-explicit-route-'));
    const configPath = path.join(tempRoot, 'agent-teams-config.json');

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        providerConnections: {
          codex: {
            preferredAuthMode: 'api_key',
            customProvider: {
              enabled: true,
              baseUrl: ' https://gateway.example.com/v1 ',
              model: ' gateway-codex-model ',
            },
          },
        },
        runtime: {
          providerBackends: {
            codex: 'api',
          },
        },
      })
    );

    const { ConfigManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');

    const manager = new ConfigManager(configPath);
    expect(manager.getConfig()).toMatchObject({
      providerConnections: {
        codex: {
          preferredAuthMode: 'api_key',
          customProvider: {
            enabled: true,
            baseUrl: 'https://gateway.example.com/v1',
            model: 'gateway-codex-model',
          },
        },
      },
      runtime: {
        providerBackends: {
          codex: 'codex-native',
        },
      },
    });

    await vi.waitFor(() => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        providerConnections: { codex: Record<string, unknown> };
        runtime: { providerBackends: { codex: string } };
      };

      expect(persisted.providerConnections.codex).toEqual({
        preferredAuthMode: 'api_key',
        customProvider: {
          enabled: true,
          baseUrl: 'https://gateway.example.com/v1',
          model: 'gateway-codex-model',
        },
      });
      expect(persisted.runtime.providerBackends.codex).toBe('codex-native');
    });
  });

  it('deep-merges and persists Codex custom provider updates', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-codex-custom-provider-'));
    const configPath = path.join(tempRoot, 'agent-teams-config.json');

    const { ConfigManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');

    const manager = new ConfigManager(configPath);
    const updated = manager.updateConfig('providerConnections', {
      codex: {
        preferredAuthMode: 'api_key',
        customProvider: {
          enabled: true,
          baseUrl: ' https://gateway.example.com/v1 ',
          model: ' gateway-codex-model ',
        },
      },
    } as never);

    expect(updated.providerConnections.codex).toEqual({
      preferredAuthMode: 'api_key',
      customProvider: {
        enabled: true,
        baseUrl: 'https://gateway.example.com/v1',
        model: 'gateway-codex-model',
      },
    });

    await vi.waitFor(() => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        providerConnections: {
          codex: {
            preferredAuthMode: string;
            customProvider: { enabled: boolean; baseUrl: string; model: string };
          };
        };
      };

      expect(persisted.providerConnections.codex).toEqual({
        preferredAuthMode: 'api_key',
        customProvider: {
          enabled: true,
          baseUrl: 'https://gateway.example.com/v1',
          model: 'gateway-codex-model',
        },
      });
    });

    const disabled = manager.updateConfig('providerConnections', {
      codex: {
        customProvider: {
          enabled: false,
        },
      },
    } as never);

    expect(disabled.providerConnections.codex).toEqual({
      preferredAuthMode: 'api_key',
      customProvider: {
        enabled: false,
        baseUrl: 'https://gateway.example.com/v1',
        model: 'gateway-codex-model',
      },
    });

    await vi.waitFor(() => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        providerConnections: {
          codex: {
            preferredAuthMode: string;
            customProvider: { enabled: boolean; baseUrl: string; model: string };
          };
        };
      };

      expect(persisted.providerConnections.codex).toEqual({
        preferredAuthMode: 'api_key',
        customProvider: {
          enabled: false,
          baseUrl: 'https://gateway.example.com/v1',
          model: 'gateway-codex-model',
        },
      });
    });
  });

  it.each(['api', 'adapter', 'auto', 'codex-native'] as const)(
    'durably marks and preserves an explicit Codex backend %s update across restart',
    async (providerBackendId) => {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-codex-runtime-update-'));
      const configPath = path.join(tempRoot, 'claude-devtools-config.json');

      const { ConfigManager } =
        await import('../../../../src/main/services/infrastructure/ConfigManager');

      const manager = new ConfigManager(configPath);
      const updated = manager.updateConfig('runtime', {
        providerBackends: {
          codex: providerBackendId as never,
        },
      } as never);

      expect(updated.runtime.providerBackends.codex).toBe(providerBackendId);

      await vi.waitFor(() => {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
        const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
          runtime: { providerBackendsVersion: number; providerBackends: { codex: string } };
        };

        expect(persisted.runtime.providerBackendsVersion).toBe(2);
        expect(persisted.runtime.providerBackends.codex).toBe(providerBackendId);
      });

      const reloaded = new ConfigManager(configPath);
      expect(reloaded.getConfig().runtime.providerBackends.codex).toBe(providerBackendId);

      await vi.waitFor(() => {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture path
        const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
          runtime: { providerBackends: { codex: string } };
        };

        expect(persisted.runtime.providerBackends.codex).toBe(providerBackendId);
      });
    }
  );

  it('fails closed for an unknown runtime backend schema version', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-codex-unknown-version-'));
    const configPath = path.join(tempRoot, 'agent-teams-config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        runtime: { providerBackendsVersion: 999, providerBackends: { codex: 'api' } },
      })
    );

    const { ConfigManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');
    expect(new ConfigManager(configPath).getConfig().runtime.providerBackends.codex).toBe(
      'codex-native'
    );
    await vi.waitFor(() => {
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        runtime: { providerBackendsVersion: number; providerBackends: { codex: string } };
      };
      expect(persisted.runtime).toMatchObject({
        providerBackendsVersion: 2,
        providerBackends: { codex: 'codex-native' },
      });
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

    const { ConfigManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');

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

    const { ConfigManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');

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

    const { ConfigManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');

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
    tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'config-anthropic-compatible-derived-update-')
    );
    const configPath = path.join(tempRoot, 'agent-teams-config.json');

    const { ConfigManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');

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
