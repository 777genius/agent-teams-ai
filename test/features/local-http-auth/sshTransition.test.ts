// @vitest-environment node
import { registerSshRoutes } from '@main/http/ssh';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import type { SshConnectionManager } from '@main/services/infrastructure/SshConnectionManager';

vi.mock('@main/services/infrastructure/ConfigManager', () => ({
  ConfigManager: {
    getInstance: () => ({ getConfig: () => ({ ssh: {} }) }),
  },
}));

it('rejects a second HTTP context change before it can wait behind the active transition', async () => {
  const app = Fastify();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const connect = vi.fn(async () => undefined);
  registerSshRoutes(
    app,
    { connect, getStatus: () => ({ state: 'connected' }) } as unknown as SshConnectionManager,
    async () => undefined,
    async (operation) => {
      entered();
      await gate;
      await operation();
    }
  );
  try {
    const first = app.inject({
      method: 'POST',
      url: '/api/ssh/connect',
      payload: { host: 'fixture.test' },
    });
    await ready;
    const secondRequest = app.inject({
      method: 'POST',
      url: '/api/ssh/connect',
      payload: { host: 'fixture.test' },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const second = await Promise.race([
      secondRequest,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 500);
      }),
    ]);
    if (timer) clearTimeout(timer);
    release();
    expect(second?.statusCode).toBe(409);
    expect(connect).not.toHaveBeenCalled();
    release();
    expect((await first).statusCode).toBe(200);
    expect(connect).toHaveBeenCalledOnce();
  } finally {
    release();
    await app.close();
  }
});
