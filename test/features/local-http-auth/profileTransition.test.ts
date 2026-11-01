// @vitest-environment node
import {
  cancelApiProfileChanges,
  configureApiProfileChanges,
  registerProfileParticipant,
  runApiProfileChange,
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('reports sanitized late HTTP resume failure without delaying its result or detaching the queue', async () => {
  const report = vi.fn();
  configureApiProfileChanges(() => undefined, report);
  const finish = deferred();
  unregister = registerProfileParticipant({
    pause: async () => async () => {
      await finish.promise;
      throw new Error('TEST-secret-token-and-config');
    },
  });
  const changing = runApiProfileChange(() => 'accepted', {} as import('fastify').FastifyRequest);
  await expect(changing).resolves.toBe('accepted');
  expect(report).not.toHaveBeenCalled();
  const nextCommit = vi.fn();
  const next = scheduleApiProfileChange(nextCommit);
  expect(nextCommit).not.toHaveBeenCalled();
  finish.resolve();
  // Join physical completion without pausing the next transition's participant again.
  unregister();
  unregister = undefined;
  await next.settled;
  await next.result;
  expect(report).toHaveBeenCalledExactlyOnceWith({
    code: 'API_PROFILE_TRANSITION_FAILED',
    phase: 'resume',
  });
  expect(JSON.stringify(report.mock.calls)).not.toContain('TEST-secret');
});

it('reports failed unchanged restoration in addition to the original guard rejection', async () => {
  const report = vi.fn();
  configureApiProfileChanges(() => undefined, report);
  const resume = Object.assign(async () => undefined, {
    unchanged: async () => {
      throw new Error('TEST-secret-config');
    },
  });
  unregister = registerProfileParticipant({ pause: async () => resume });
  const change = scheduleApiProfileChange(
    (rejectBeforeMutation) => rejectBeforeMutation(new Error('Live consumer')),
    undefined,
    { assertUnchanged: () => undefined }
  );
  await expect(change.result).rejects.toThrow('Live consumer');
  await expect(change.settled).rejects.toThrow('rejection restoration failed');
  expect(report).toHaveBeenCalledExactlyOnceWith({
    code: 'API_PROFILE_TRANSITION_FAILED',
    phase: 'unchanged-restoration',
  });
});

it('keeps expected early guard rejection quiet', async () => {
  const report = vi.fn();
  configureApiProfileChanges(() => undefined, report);
  const change = scheduleApiProfileChange(() => undefined, undefined, {
    beforePause: () => {
      throw new Error('Live consumer');
    },
  });
  await expect(change.result).rejects.toThrow('Live consumer');
  await expect(change.settled).rejects.toThrow('Live consumer');
  expect(report).not.toHaveBeenCalled();
});

it('does not notify a disposed owner when cancellation wins a late resume failure', async () => {
  const report = vi.fn();
  configureApiProfileChanges(() => undefined, report);
  const finish = deferred();
  unregister = registerProfileParticipant({
    pause: async () => async () => {
      await finish.promise;
      throw new Error('Late failure');
    },
  });
  const change = scheduleApiProfileChange(() => undefined, {} as import('fastify').FastifyRequest);
  await change.result;
  const cancelled = cancelApiProfileChanges();
  finish.resolve();
  await expect(change.settled).rejects.toThrow('resume failed');
  await cancelled;
  expect(report).not.toHaveBeenCalled();
});

it('keeps the profile queue joined even if the owner reporter itself throws', async () => {
  configureApiProfileChanges(
    () => undefined,
    () => {
      throw new Error('TEST-secret-reporter');
    }
  );
  unregister = registerProfileParticipant({
    pause: async () => async () => {
      throw new Error('Late resume failure');
    },
  });
  const failed = scheduleApiProfileChange(() => 'accepted', {} as import('fastify').FastifyRequest);
  await expect(failed.result).resolves.toBe('accepted');
  await expect(failed.settled).rejects.toThrow('owner failure reporting failed');
  unregister();
  unregister = undefined;
  const next = scheduleApiProfileChange(() => 'next');
  await expect(next.result).resolves.toBe('next');
  await expect(next.settled).resolves.toBeUndefined();
});

it.each([false, true])(
  'seals the current HTTP registration after a resumed transition fails (HTTP result=%s)',
  async (http) => {
    const current = await fixture();
    const report = vi.fn();
    configureApiProfileChanges(() => undefined, report);
    const change = scheduleApiProfileChange(
      () => 'accepted',
      http ? ({} as import('fastify').FastifyRequest) : undefined,
      {
        afterResume: () => {
          throw new Error('TEST-secret-after-resume');
        },
      }
    );
    if (http) await expect(change.result).resolves.toBe('accepted');
    else await expect(change.result).rejects.toThrow('TEST-secret-after-resume');
    await expect(change.settled).rejects.toThrow('TEST-secret-after-resume');
    expect(current.isRunning()).toBe(false);
    expect(physical.listen).toHaveBeenCalledTimes(2);
    expect(physical.close).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledExactlyOnceWith({
      code: 'API_PROFILE_TRANSITION_FAILED',
      phase: 'resume',
    });
  }
);

it('attempts every current admission seal before reporting, even when one hook throws', async () => {
  const order: string[] = [];
  const report = vi.fn(() => {
    order.push('report');
  });
  configureApiProfileChanges(() => undefined, report);
  const first = registerProfileParticipant({
    pause: async () => async () => undefined,
    closeAdmission: () => {
      order.push('first');
      throw new Error('TEST-secret-hook');
    },
  });
  const second = registerProfileParticipant({
    pause: async () => async () => undefined,
    closeAdmission: () => {
      order.push('second');
    },
  });
  unregister = () => {
    first();
    second();
  };
  const change = scheduleApiProfileChange(
    () => 'accepted',
    {} as import('fastify').FastifyRequest,
    {
      afterResume: () => {
        throw new Error('TEST-secret-resume');
      },
    }
  );
  await expect(change.result).resolves.toBe('accepted');
  await expect(change.settled).rejects.toThrow('admission closure failed');
  expect(order).toEqual(['first', 'second', 'report']);
  expect(report).toHaveBeenCalledExactlyOnceWith({
    code: 'API_PROFILE_TRANSITION_FAILED',
    phase: 'resume',
  });
  expect(JSON.stringify(report.mock.calls)).not.toContain('TEST-secret');
});
