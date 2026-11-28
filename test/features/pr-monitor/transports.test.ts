import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  PR_MONITOR_CHANNEL,
  PR_MONITOR_CONSENT_CHANNEL,
  PR_MONITOR_ROUTE,
} from '../../../src/features/pr-monitor/contracts';
import { registerPrMonitorHttp } from '../../../src/features/pr-monitor/main/adapters/input/http';
import { registerPrMonitorIpc } from '../../../src/features/pr-monitor/main/adapters/input/ipc';

import type { PrMonitorFeature } from '../../../src/features/pr-monitor/main';
import type { IpcMain } from 'electron';

const feature = (): PrMonitorFeature => ({
  read: vi.fn<PrMonitorFeature['read']>(async () => ({
    ok: false,
    error: { kind: 'consent_required', message: 'Connect first.', retryAt: null },
  })),
  consent: vi.fn(),
  login: vi.fn(),
  reset: vi.fn(),
  dispose: vi.fn(),
});

describe('private repository transport boundary', () => {
  it('shares the read facade on HTTP while refusing foreign origins and remote clients', async () => {
    const app = Fastify();
    const instance = feature();
    registerPrMonitorHttp(app, instance);
    const body = { operation: 'describe', contextId: 'local', projectId: 'TEST' };
    const local = await app.inject({
      method: 'POST',
      url: PR_MONITOR_ROUTE,
      headers: { host: 'localhost:3456', origin: 'http://localhost:3456' },
      payload: body,
    });
    expect(local.json().error.kind).toBe('consent_required');
    expect(instance.read).toHaveBeenCalledWith(body);
    for (const headers of [
      { host: 'evil.test' },
      { host: 'localhost:3456', origin: 'https://evil.test' },
      { host: 'localhost:3456', 'sec-fetch-site': 'cross-site' },
    ]) {
      expect(
        (await app.inject({ method: 'POST', url: PR_MONITOR_ROUTE, headers, payload: body }))
          .statusCode
      ).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: PR_MONITOR_ROUTE,
          headers: { host: 'localhost:3456' },
          remoteAddress: '203.0.113.1',
          payload: body,
        })
      ).statusCode
    ).toBe(403);
    expect(instance.read).toHaveBeenCalledTimes(1);
    expect(
      (await app.inject({ method: 'POST', url: PR_MONITOR_ROUTE + '/consent', payload: body }))
        .statusCode
    ).toBe(404);
    await app.close();
  });
  it('accepts only the intended Electron top-level frame, and disposes all handlers', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const ipc = {
      handle: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
      removeHandler: vi.fn((name: string) => handlers.delete(name)),
    };
    const instance = feature();
    const dispose = registerPrMonitorIpc(
      ipc as unknown as IpcMain,
      instance,
      () => 7,
      (url) => url === 'http://localhost:5173/'
    );
    const frame = { url: 'http://localhost:5173/' };
    const accepted = { sender: { id: 7, mainFrame: frame }, senderFrame: frame };
    await handlers.get(PR_MONITOR_CHANNEL)!(accepted, { operation: 'describe' });
    expect(instance.read).toHaveBeenCalledTimes(1);
    expect(
      await handlers.get(PR_MONITOR_CHANNEL)!({ ...accepted, senderFrame: {} }, {})
    ).toMatchObject({ error: { kind: 'forbidden' } });
    expect(
      await handlers.get(PR_MONITOR_CONSENT_CHANNEL)!(
        { ...accepted, sender: { id: 8, mainFrame: frame } },
        {},
        true
      )
    ).toMatchObject({ error: { kind: 'forbidden' } });
    const foreign = { url: 'https://evil.test/' };
    expect(
      await handlers.get(PR_MONITOR_CONSENT_CHANNEL)!(
        { sender: { id: 7, mainFrame: foreign }, senderFrame: foreign },
        {},
        true
      )
    ).toMatchObject({ error: { kind: 'forbidden' } });
    expect(instance.consent).not.toHaveBeenCalled();
    dispose();
    expect(handlers.size).toBe(0);
  });
});
