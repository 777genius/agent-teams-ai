// @vitest-environment node
import {
  configureApiProfileChanges,
  registerProfileParticipant,
  scheduleApiProfileChange,
} from '@features/local-http-auth/main/application/profileTransition';
import { HttpServer } from '@main/services/infrastructure/HttpServer';
import { afterEach, expect, it, vi } from 'vitest';

import type { HttpServices } from '@main/http';

const physical = vi.hoisted(() => ({
  listen: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  token: 0,
  hooks: new Map<string, unknown>(),
}));
vi.mock(
  '@features/local-http-auth/main',
  async () => import('@features/local-http-auth/main/application/profileTransition')
);
vi.mock('@main/http', () => ({ registerHttpRoutes: vi.fn() }));
vi.mock('@main/http/events', () => ({ broadcastEvent: vi.fn(), closeEventStreams: vi.fn() }));
vi.mock('@shared/utils/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@fastify/cors', () => ({ default: vi.fn() }));
vi.mock('@fastify/static', () => ({ default: vi.fn() }));
vi.mock('fs', () => ({ existsSync: () => false }));
vi.mock('fastify', () => ({
  default: () => ({
    addHook: (name: string, handler: unknown) => physical.hooks.set(name, handler),
    register: vi.fn(async () => undefined),
    get: vi.fn(),
    listen: physical.listen,
    close: physical.close,
    server: { address: () => ({ port: 41000 }) },
  }),
}));
vi.mock('@main/services/infrastructure/HttpServerAuth', () => ({
  buildHttpAccessUrl: () => 'http://TEST-profile',
  createHttpAuthToken: () => `TEST-token-${++physical.token}`,
  exactHttpOrigins: () => [],
  registerHttpApiAuth: vi.fn(),
}));

let server: HttpServer | undefined;
let unregister: (() => void) | undefined;
afterEach(async () => {
  unregister?.();
  unregister = undefined;
  await server?.stop();
  server = undefined;
  configureApiProfileChanges(() => undefined);
  vi.clearAllMocks();
});
async function fixture() {
  configureApiProfileChanges(() => undefined);
  server = new HttpServer();
  await server.start({} as HttpServices, async () => undefined);
  return server;
}

it('unpauses the exact unchanged physical listener without replacing its credential or restarting', async () => {
  const current = await fixture();
  const token = current.getAuthToken();
  const error = new Error('Live consumer');
  const change = scheduleApiProfileChange(
    (rejectBeforeMutation) => rejectBeforeMutation(error),
    undefined,
    { assertUnchanged: () => undefined }
  );
  await expect(change.result).rejects.toBe(error);
  await expect(change.settled).rejects.toBe(error);
  expect(current.isRunning()).toBe(true);
  expect(current.getAuthToken()).toBe(token);
  expect(physical.listen).toHaveBeenCalledOnce();
  expect(physical.close).not.toHaveBeenCalled();
});

it('does not reopen or rotate credentials if authority changes while the response drain is pending', async () => {
  const current = await fixture();
  const token = current.getAuthToken();
  const request = {} as import('fastify').FastifyRequest;
  const onRequest = physical.hooks.get('onRequest') as (
    request: object,
    reply: object
  ) => Promise<void>;
  const onResponse = physical.hooks.get('onResponse') as (request: object) => Promise<void>;
  await onRequest(request, {});
  let authorityValid = true;
  const change = scheduleApiProfileChange(
    (rejectBeforeMutation) => rejectBeforeMutation(new Error('Live consumer')),
    request,
    {
      assertUnchanged: () => {
        if (!authorityValid) throw new Error('Authority changed during response drain');
      },
    }
  );
  await expect(change.result).rejects.toThrow('Live consumer');
  // The changing response is still active: physical unchanged restoration must join it.
  authorityValid = false;
  await onResponse(request);
  await expect(change.settled).rejects.toThrow('rejection restoration failed');
  expect(current.isRunning()).toBe(false);
  expect(current.getAuthToken()).toBe(token);
  expect(physical.close).not.toHaveBeenCalled();
});

it('never revives a listener after an explicit stop wins unchanged restoration', async () => {
  const current = await fixture();
  const change = scheduleApiProfileChange(
    (rejectBeforeMutation) => {
      void current.stop();
      rejectBeforeMutation(new Error('Live consumer'));
    },
    undefined,
    { assertUnchanged: () => undefined }
  );
  await expect(change.result).rejects.toThrow('Live consumer');
  await expect(change.settled).rejects.toThrow('rejection restoration failed');
  expect(current.isRunning()).toBe(false);
  expect(current.getAuthToken()).toBeNull();
  expect(physical.listen).toHaveBeenCalledOnce();
});

it('keeps every participant closed if one cannot restore an unchanged profile', async () => {
  const current = await fixture();
  const resume = vi.fn(async () => undefined);
  unregister = registerProfileParticipant({ pause: async () => resume });
  const change = scheduleApiProfileChange(
    (rejectBeforeMutation) => rejectBeforeMutation(new Error('Live consumer')),
    undefined,
    { assertUnchanged: () => undefined }
  );
  await expect(change.result).rejects.toThrow('Live consumer');
  await expect(change.settled).rejects.toThrow('rejection restoration failed');
  expect(current.isRunning()).toBe(false);
  expect(resume).not.toHaveBeenCalled();
  expect(physical.close).not.toHaveBeenCalled();
});

it('keeps unknown commit failures closed rather than treating them as unchanged rejection', async () => {
  const current = await fixture();
  const change = scheduleApiProfileChange(() => {
    throw new Error('Mutation outcome unknown');
  });
  await expect(change.result).rejects.toThrow('Mutation outcome unknown');
  await expect(change.settled).rejects.toThrow('Mutation outcome unknown');
  expect(current.isRunning()).toBe(false);
  expect(physical.close).not.toHaveBeenCalled();
});
