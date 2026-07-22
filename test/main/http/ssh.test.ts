import { registerSshRoutes } from '@main/http/ssh';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { SshConnectionManager } from '@main/services/infrastructure/SshConnectionManager';

vi.mock('@main/services/infrastructure/ConfigManager', () => ({
  ConfigManager: {
    getInstance: () => ({}),
  },
}));
vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

function createConnectionManager() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
      state: 'connected',
      host: 'example.test',
      error: null,
      remoteProjectsPath: '/home/test/.claude/projects',
    }),
  } as unknown as SshConnectionManager;
}

describe('HTTP SSH routes', () => {
  it('serializes disconnect behind an in-flight connection', async () => {
    const app = Fastify();
    const connectionManager = createConnectionManager();
    let finishConnecting: (() => void) | undefined;
    vi.mocked(connectionManager.connect).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishConnecting = resolve;
        })
    );
    const modeSwitchCallback = vi.fn<(mode: 'local' | 'ssh') => Promise<void>>();
    registerSshRoutes(app, connectionManager, modeSwitchCallback);
    await app.ready();

    try {
      const connectResponse = app.inject({
        method: 'POST',
        url: '/api/ssh/connect',
        payload: {
          host: 'example.test',
          port: 22,
          username: 'test',
          authMethod: 'agent',
        },
      });
      await vi.waitFor(() => expect(connectionManager.connect).toHaveBeenCalledOnce());

      const disconnectResponse = app.inject({ method: 'POST', url: '/api/ssh/disconnect' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(connectionManager.disconnect).not.toHaveBeenCalled();
      expect(modeSwitchCallback).not.toHaveBeenCalled();

      finishConnecting?.();
      await Promise.all([connectResponse, disconnectResponse]);

      expect(modeSwitchCallback).toHaveBeenNthCalledWith(1, 'ssh');
      expect(connectionManager.disconnect).toHaveBeenCalledOnce();
      expect(modeSwitchCallback).toHaveBeenNthCalledWith(2, 'local');
    } finally {
      await app.close();
    }
  });

  it('rolls back a connection when switching to SSH mode fails', async () => {
    const app = Fastify();
    const connectionManager = createConnectionManager();
    const modeSwitchCallback = vi
      .fn<(mode: 'local' | 'ssh') => Promise<void>>()
      .mockRejectedValueOnce(new Error('SSH context switch failed'))
      .mockResolvedValueOnce(undefined);
    registerSshRoutes(app, connectionManager, modeSwitchCallback);
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/ssh/connect',
        payload: {
          host: 'example.test',
          port: 22,
          username: 'test',
          authMethod: 'agent',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: false,
        error: 'SSH context switch failed',
      });
      expect(connectionManager.disconnect).toHaveBeenCalledOnce();
      expect(modeSwitchCallback).toHaveBeenNthCalledWith(1, 'ssh');
      expect(modeSwitchCallback).toHaveBeenNthCalledWith(2, 'local');
    } finally {
      await app.close();
    }
  });

  it('does not overwrite connection failure state by disconnecting again', async () => {
    const app = Fastify();
    const connectionManager = createConnectionManager();
    vi.mocked(connectionManager.connect).mockRejectedValueOnce(new Error('Authentication failed'));
    const modeSwitchCallback = vi.fn<(mode: 'local' | 'ssh') => Promise<void>>();
    registerSshRoutes(app, connectionManager, modeSwitchCallback);
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/ssh/connect',
        payload: {
          host: 'example.test',
          port: 22,
          username: 'test',
          authMethod: 'agent',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: false,
        error: 'Authentication failed',
      });
      expect(connectionManager.disconnect).not.toHaveBeenCalled();
      expect(modeSwitchCallback).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
