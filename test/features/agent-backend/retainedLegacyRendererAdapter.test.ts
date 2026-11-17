// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createHostBackendRenderer } from '../../../src/features/agent-backend/renderer/createHostBackendRenderer';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type {
  RetainedLegacyLaunchChoice,
  RetainedLegacyLaunchRequest,
  RetainedLegacyLaunchResult,
} from '../../../src/features/agent-backend/contracts/retainedLegacyLaunch';
import type { TeamsAPI } from '../../../src/shared/types/api';

const choice: RetainedLegacyLaunchChoice = {
  mode: 'original-runtime',
  teamName: 'TEST-original-team',
  scopeId: 'TEST-original-scope',
  expiresAt: 10_000,
  projectPath: '/TEST-project',
};
const open = {
  action: 'open',
  teamName: choice.teamName,
  intentId: 'TEST-original-intent',
} satisfies RetainedLegacyLaunchRequest;
const rebind = {
  action: 'rebind',
  scopeId: choice.scopeId,
  projectPath: '/TEST-other-project',
  intentId: 'TEST-rebind-intent',
} satisfies RetainedLegacyLaunchRequest;
const closed: RetainedLegacyLaunchResult = { ok: true, action: 'close', value: null };
const unknown: RetainedLegacyLaunchResult = {
  ok: false,
  reason: 'outcome-unknown',
  outcome: 'unknown',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(
  operation: NonNullable<AgentBackendApi['retainedLegacyLaunch']> = async () => unknown
) {
  let current = true;
  const capture = vi.fn(() => () => current);
  const source: AgentBackendApi = {
    getConnections: vi.fn(async () => ({ state: 'unconfigured' as const, bindings: [] })),
    invoke: vi.fn(),
  };
  const send = vi.fn(function (this: AgentBackendApi, request: RetainedLegacyLaunchRequest) {
    expect(this).toBe(source);
    return operation(request);
  });
  source.retainedLegacyLaunch = send;
  const legacy = { launchTeam: vi.fn(), replaceMembers: vi.fn() } as unknown as TeamsAPI;
  const adapter = createHostBackendRenderer(legacy, source, capture);
  return {
    adapter,
    source,
    send,
    legacy,
    capture,
    revoke: () => {
      current = false;
    },
  };
}

describe('retained original runtime through the renderer API adapter', () => {
  it.each<RetainedLegacyLaunchRequest>([
    open,
    rebind,
    { action: 'read', scopeId: choice.scopeId },
    { action: 'status', scopeId: choice.scopeId, projectPath: '/TEST-project' },
    { action: 'account', scopeId: choice.scopeId },
    { action: 'prepare', scopeId: choice.scopeId, args: ['/TEST-project'] },
    { action: 'roster', scopeId: choice.scopeId, request: { members: [] } },
    {
      action: 'launch',
      scopeId: choice.scopeId,
      request: { teamName: choice.teamName, cwd: choice.projectPath },
    },
  ])(
    'forwards the exact $action request once to its captured owner without fallback',
    async (request) => {
      const f = fixture();
      const replacement = vi.fn();
      f.source.retainedLegacyLaunch = replacement;
      expect(await f.adapter.backend.retainedLegacyLaunch!(request)).toBe(unknown);
      expect(f.send).toHaveBeenCalledExactlyOnceWith(request);
      expect(f.send.mock.calls[0]![0]).toBe(request);
      expect(replacement).not.toHaveBeenCalled();
      expect(f.source.invoke).not.toHaveBeenCalled();
      expect(f.legacy.launchTeam).not.toHaveBeenCalled();
      expect(f.legacy.replaceMembers).not.toHaveBeenCalled();
    }
  );

  it('leaves the optional route absent when the original transport does not support it', () => {
    const source: AgentBackendApi = { getConnections: vi.fn(), invoke: vi.fn() };
    const adapter = createHostBackendRenderer({} as TeamsAPI, source, () => () => true);
    expect(adapter.backend.retainedLegacyLaunch).toBeUndefined();
  });

  it('refuses a stale request before dispatch', async () => {
    const f = fixture();
    f.revoke();
    expect(await f.adapter.backend.retainedLegacyLaunch!(open)).toEqual({
      ok: false,
      reason: 'source-changed',
      outcome: 'not-dispatched',
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([
    { request: { action: 'close', scopeId: choice.scopeId }, result: closed },
    {
      request: { action: 'closeIntent', teamName: choice.teamName, intentId: open.intentId },
      result: { ok: true, action: 'closeIntent', value: null },
    },
    {
      request: {
        action: 'cancelModels',
        scopeId: choice.scopeId,
        input: { requestGroupId: 'TEST-original-group' },
      },
      result: { ok: true, action: 'cancelModels', value: { ok: true } },
    },
  ] satisfies { request: RetainedLegacyLaunchRequest; result: RetainedLegacyLaunchResult }[])(
    'permits original $request.action cleanup after context changes without capturing another context',
    async ({ request, result }) => {
      const f = fixture(async () => result);
      const replacement = vi.fn();
      f.source.retainedLegacyLaunch = replacement;
      f.revoke();
      expect(await f.adapter.backend.retainedLegacyLaunch!(request)).toBe(result);
      expect(f.send).toHaveBeenCalledExactlyOnceWith(request);
      expect(f.capture).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
    }
  );

  it.each([open, rebind])(
    'releases a late successful $action choice before refusing the old context result',
    async (request) => {
      const opened = deferred<RetainedLegacyLaunchResult>();
      const cleanup = deferred<RetainedLegacyLaunchResult>();
      const f = fixture((request) =>
        request.action === 'close' ? cleanup.promise : opened.promise
      );
      const pending = f.adapter.backend.retainedLegacyLaunch!(request);
      const freshChoice = {
        ...choice,
        scopeId: 'TEST-new-scope',
        projectPath: '/TEST-other-project',
      };
      let finished = false;
      void pending.then(() => {
        finished = true;
      });
      f.revoke();
      opened.resolve({ ok: true, action: request.action, value: freshChoice });
      await Promise.resolve();
      expect(f.send).toHaveBeenLastCalledWith({ action: 'close', scopeId: freshChoice.scopeId });
      expect(finished).toBe(false);
      cleanup.resolve(closed);
      expect(await pending).toEqual({ ok: false, reason: 'source-changed', outcome: 'unknown' });
      expect(f.send).toHaveBeenCalledTimes(2);
    }
  );

  it.each([open, rebind])(
    'returns a current successful $action choice without closing it',
    async (request) => {
      const result: RetainedLegacyLaunchResult = {
        ok: true,
        action: request.action,
        value: choice,
      };
      const f = fixture(async () => result);
      expect(await f.adapter.backend.retainedLegacyLaunch!(request)).toBe(result);
      expect(f.send).toHaveBeenCalledExactlyOnceWith(request);
    }
  );

  it('refuses a late read result without closing the choice or replaying the read', async () => {
    const response = deferred<RetainedLegacyLaunchResult>();
    const f = fixture(() => response.promise);
    const request: RetainedLegacyLaunchRequest = {
      action: 'status',
      scopeId: choice.scopeId,
      projectPath: choice.projectPath,
    };
    const pending = f.adapter.backend.retainedLegacyLaunch!(request);
    f.revoke();
    response.resolve(unknown);
    expect(await pending).toEqual({ ok: false, reason: 'source-changed', outcome: 'unknown' });
    expect(f.send).toHaveBeenCalledExactlyOnceWith(request);
  });

  it('keeps UNKNOWN when late-choice cleanup is lost, without another cleanup attempt', async () => {
    const opened = deferred<RetainedLegacyLaunchResult>();
    const f = fixture((request) =>
      request.action === 'close'
        ? Promise.reject(new Error('TEST-cleanup-ACK-lost'))
        : opened.promise
    );
    const pending = f.adapter.backend.retainedLegacyLaunch!(open);
    f.revoke();
    opened.resolve({ ok: true, action: 'open', value: choice });
    expect(await pending).toEqual({ ok: false, reason: 'source-changed', outcome: 'unknown' });
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it.each<RetainedLegacyLaunchResult>([
    unknown,
    { ok: true, action: 'launch', value: { runId: 'TEST-run' } },
  ])('does not automatically close or retry a late mutation', async (result) => {
    const response = deferred<RetainedLegacyLaunchResult>();
    const f = fixture(() => response.promise);
    const request: RetainedLegacyLaunchRequest = {
      action: 'launch',
      scopeId: choice.scopeId,
      request: { teamName: choice.teamName, cwd: choice.projectPath },
    };
    const pending = f.adapter.backend.retainedLegacyLaunch!(request);
    f.revoke();
    response.resolve(result);
    expect(await pending).toEqual({ ok: false, reason: 'source-changed', outcome: 'unknown' });
    expect(f.send).toHaveBeenCalledExactlyOnceWith(request);
  });

  it('does not retry or fall back when the original transport rejects', async () => {
    const error = new Error('TEST-response-lost');
    const f = fixture(async () => {
      throw error;
    });
    await expect(f.adapter.backend.retainedLegacyLaunch!(open)).rejects.toBe(error);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(open);
    expect(f.legacy.launchTeam).not.toHaveBeenCalled();
  });
});
