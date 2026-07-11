import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigManager } from '../../../../src/main/services/infrastructure/ConfigManager';

describe('ConfigManager HTTP security config', () => {
  afterEach(() => {
    ConfigManager.resetInstance();
    vi.restoreAllMocks();
  });

  it('fails closed when loading a persisted non-loopback httpServer host', () => {
    const configPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-http-config-')),
      'config.json'
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        httpServer: {
          enabled: true,
          port: 4567,
          host: '0.0.0.0',
        },
      })
    );

    const manager = new ConfigManager(configPath);

    expect(manager.getConfig().httpServer).toEqual({
      enabled: false,
      port: 4567,
      host: '127.0.0.1',
    });
  });

  it('redacts path-bearing config fields for HTTP responses', () => {
    const configPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-http-redact-')),
      'config.json'
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        general: {
          claudeRootPath: '/Users/alice/.claude',
          customProjectPaths: ['/Users/alice/project-a'],
        },
        sessions: {
          pinnedSessions: {
            '-Users-alice-project-a': [{ sessionId: 'session-a', pinnedAt: 1 }],
          },
          hiddenSessions: {
            '-Users-alice-project-b': [{ sessionId: 'session-b', hiddenAt: 2 }],
          },
        },
        ssh: {
          lastConnection: {
            host: 'example.test',
            port: 22,
            username: 'alice',
            authMethod: 'privateKey',
            privateKeyPath: '/Users/alice/.ssh/id_ed25519',
          },
          profiles: [
            {
              id: 'profile-a',
              name: 'Profile A',
              host: 'example.test',
              port: 22,
              username: 'alice',
              authMethod: 'privateKey',
              privateKeyPath: '/Users/alice/.ssh/profile_key',
            },
          ],
        },
      })
    );

    const manager = new ConfigManager(configPath);
    const config = manager.getConfigForHttpResponse();

    expect(config.general.claudeRootPath).toBe('[redacted-path]');
    expect(config.general.customProjectPaths).toEqual(['[redacted-path]']);
    expect(Object.keys(config.sessions.pinnedSessions)).toEqual(['[redacted-project-1]']);
    expect(Object.keys(config.sessions.hiddenSessions)).toEqual(['[redacted-project-1]']);
    expect(config.ssh.lastConnection?.privateKeyPath).toBe('[redacted-path]');
    expect(config.ssh.profiles[0]?.privateKeyPath).toBe('[redacted-path]');
  });
});
