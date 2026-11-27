import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { USER_ATTENTION_HTTP_ROUTE } from '../../../../src/features/user-attention/contracts';
import { registerUserAttentionHttp } from '../../../../src/features/user-attention/main/adapters/input/registerUserAttentionHttp';
import { registerUserAttentionIpc, removeUserAttentionIpc } from '../../../../src/features/user-attention/main/adapters/input/registerUserAttentionIpc';
import { USER_ATTENTION_CHANNEL } from '../../../../src/features/user-attention/contracts';

import type { UserAttentionFeatureFacade } from '../../../../src/features/user-attention/main/composition/createUserAttentionFeature';
import type { IpcMain } from 'electron';

describe('Attention read transport contract', () => {
  const snapshot = { contextId: 'local', teams: [], complete: true };
  it('returns the same source snapshot over HTTP and validates team query', async () => {
    const feature: UserAttentionFeatureFacade = {
      getUserAttentionSnapshot: vi.fn(async () => snapshot),
    };
    const app = Fastify();
    registerUserAttentionHttp(app, feature);
    const response = await app.inject({ method: 'GET', url: USER_ATTENTION_HTTP_ROUTE });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);
    expect(feature.getUserAttentionSnapshot).toHaveBeenCalledWith(undefined);

    const targeted = await app.inject({
      method: 'GET', url: USER_ATTENTION_HTTP_ROUTE + '?teamName=alpha-1',
    });
    expect(targeted.statusCode).toBe(200);
    expect(feature.getUserAttentionSnapshot).toHaveBeenCalledWith('alpha-1');

    const invalid = await app.inject({
      method: 'GET', url: USER_ATTENTION_HTTP_ROUTE + '?teamName=../secrets',
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it('registers exactly one IPC handler, enforces input and tears down', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = {
      handle: vi.fn((channel: string, cb: (...args: unknown[]) => unknown) => {
        handlers.set(channel, cb);
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    } as unknown as IpcMain;
    const feature: UserAttentionFeatureFacade = {
      getUserAttentionSnapshot: vi.fn(async () => snapshot),
    };
    registerUserAttentionIpc(ipc, feature);
    const handler = handlers.get(USER_ATTENTION_CHANNEL);
    expect(handler).toBeDefined();
    await expect(handler!(null, 'alpha')).resolves.toEqual(snapshot);
    expect(() => handler!(null, '../../invalid')).toThrow('Invalid attention team name');
    removeUserAttentionIpc(ipc);
    expect(handlers.size).toBe(0);
  });
});
