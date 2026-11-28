import { describe, expect, it, vi } from 'vitest';

import { isMonitorRequest } from '../../../src/features/pr-monitor/contracts';
import { createProjectMonitor } from '../../../src/features/pr-monitor/core/application/projectMonitor';

import type { ProjectMonitorDependencies } from '../../../src/features/pr-monitor/core/application/projectMonitor';
import type {
  PullRequestPage,
  PullRequestReader,
  PullRequestSnapshot,
  ReaderResult,
  RepositoryKey,
} from '@pr-monitor/core';

const repository: RepositoryKey = { provider: 'github', owner: 'TEST', repo: 'fixture' };
const request = { contextId: 'local', projectId: 'TEST-project' };
const page: PullRequestPage = { items: [], nextPage: null, fetchedAt: '2026-11-28T18:00:00Z' };

function fixture() {
  let scope = {};
  const list = vi.fn<PullRequestReader['list']>(async () => ({ ok: true, value: page }));
  const get = vi.fn<PullRequestReader['get']>();
  const projects = {
    currentScope: () => scope,
    resolve: vi.fn(async () => ({ ok: true as const, value: { repository, scope } })),
  };
  const hasNativeAccount = vi.fn(() => true);
  const createReader = vi.fn(() => ({ list, get }));
  const isCurrent = vi.fn(async () => true);
  const connectAccount = vi.fn<ProjectMonitorDependencies['connectAccount']>(async () =>
    hasNativeAccount()
      ? { ok: true, value: { kind: 'cli', createReader, isCurrent } }
      : { ok: false, error: { kind: 'sign_in_required', message: 'Sign in.', retryAt: null } }
  );
  return {
    feature: createProjectMonitor({ projects, connectAccount }),
    connectAccount,
    list,
    get,
    projects,
    hasNativeAccount,
    createReader,
    isCurrent,
    changeContext: () => {
      scope = {};
    },
  };
}

describe('project account boundary', () => {
  it('describes a project without accessing the GitHub CLI account', async () => {
    const f = fixture();
    expect(await f.feature.describe(request)).toEqual({
      ok: true,
      value: { repository, connected: false },
    });
    expect(f.hasNativeAccount).not.toHaveBeenCalled();
    expect((await f.feature.list(request)).ok).toBe(false);
    expect(f.createReader).not.toHaveBeenCalled();
  });
  it('reads only after consent, and revocation prevents further reads', async () => {
    const f = fixture();
    await f.feature.connect(request);
    expect(await f.feature.list(request)).toEqual({ ok: true, value: page });
    expect(f.list).toHaveBeenCalledWith({
      repository,
      page: undefined,
      signal: expect.any(AbortSignal),
    });
    await f.feature.disconnect(request);
    expect((await f.feature.list(request)).ok).toBe(false);
    expect(f.list).toHaveBeenCalledTimes(1);
  });
  it('does not transfer grants to another context object', async () => {
    const f = fixture();
    await f.feature.connect(request);
    f.changeContext();
    expect(await f.feature.describe(request)).toMatchObject({ value: { connected: false } });
    expect((await f.feature.list(request)).ok).toBe(false);
  });
  it('rejects an in-flight result after disconnect and reconnect', async () => {
    const f = fixture();
    let finish!: (result: ReaderResult<PullRequestPage>) => void;
    f.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await f.feature.connect(request);
    const pending = f.feature.list(request);
    await vi.waitFor(() => expect(f.list).toHaveBeenCalled());
    await f.feature.disconnect(request);
    await f.feature.connect(request);
    finish({ ok: true, value: page });
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
  });
  it('aborts active reads on revocation and creates a fresh reader on reconnect', async () => {
    const f = fixture();
    await f.feature.connect(request);
    await f.feature.list(request);
    const signal = f.list.mock.calls[0][0].signal!;
    await f.feature.disconnect(request);
    expect(signal.aborted).toBe(true);
    await f.feature.connect(request);
    await f.feature.list(request);
    expect(f.createReader).toHaveBeenCalledTimes(2);
  });
  it('does not revoke a replacement grant when an old account check finishes late', async () => {
    const f = fixture();
    let finish!: (current: boolean) => void;
    f.isCurrent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await f.feature.connect(request);
    const pending = f.feature.list(request);
    await vi.waitFor(() => expect(f.isCurrent).toHaveBeenCalledOnce());
    await f.feature.disconnect(request);
    await f.feature.connect(request);
    finish(false);
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    expect(await f.feature.describe(request)).toMatchObject({ value: { connected: true } });
    expect(await f.feature.list(request)).toEqual({ ok: true, value: page });
  });
  it('discards a response revoked while its final account check was pending', async () => {
    const f = fixture();
    let finish!: (current: boolean) => void;
    f.isCurrent.mockResolvedValueOnce(true).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await f.feature.connect(request);
    const pending = f.feature.list(request);
    await vi.waitFor(() => expect(f.isCurrent).toHaveBeenCalledTimes(2));
    await f.feature.disconnect(request);
    finish(true);
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
  });
  it.each(['unauthorized', 'forbidden', 'not_found'] as const)(
    'revokes a grant on definitive provider %s even when the account stays current',
    async (kind) => {
      const f = fixture();
      await f.feature.connect(request);
      f.list.mockResolvedValue({ ok: false, error: { kind, message: 'Safe.', retryAt: null } });
      expect(await f.feature.list(request)).toMatchObject({
        ok: false,
        error: { kind: 'sign_in_required' },
      });
      expect(await f.feature.describe(request)).toMatchObject({ value: { connected: false } });
    }
  );
  it.each(['unauthorized', 'forbidden', 'not_found'] as const)(
    'distinguishes partial %s from a deleted historical workflow resource',
    async (code) => {
      const f = fixture();
      await f.feature.connect(request);
      const value: PullRequestSnapshot = {
        pullRequest: {
          repository,
          number: 3,
          title: 'TEST private PR',
          url: 'https://github.com/TEST/fixture/pull/3',
          author: 'TEST',
          headSha: 'a'.repeat(40),
          headBranch: 'topic',
          baseBranch: 'main',
          state: 'open',
          draft: false,
          createdAt: page.fetchedAt,
          updatedAt: page.fetchedAt,
        },
        checks: [],
        runs: [],
        reviews: [],
        merge: { mergeable: null, state: 'unknown' },
        coverage: {
          checks: 'complete',
          workflows: 'complete',
          jobs: 'partial',
          reviews: 'complete',
        },
        fetchedAt: page.fetchedAt,
        issues: [{ section: 'jobs', code, message: 'Safe.', retryAt: null }],
      };
      f.get.mockResolvedValue({ ok: true, value });
      const result = await f.feature.get({ ...request, number: 3 });
      expect(result.ok).toBe(code === 'not_found');
      expect(await f.feature.describe(request)).toMatchObject({
        value: { connected: code === 'not_found' },
      });
    }
  );
  it('aborts active reads when the shell retires the context', async () => {
    const f = fixture();
    await f.feature.connect(request);
    await f.feature.list(request);
    const signal = f.list.mock.calls[0][0].signal!;
    f.feature.reset();
    expect(signal.aborted).toBe(true);
    expect((await f.feature.list(request)).ok).toBe(false);
  });
  it('does not grant access if GitHub CLI is absent', async () => {
    const f = fixture();
    f.hasNativeAccount.mockReturnValue(false);
    expect(await f.feature.connect(request)).toMatchObject({
      ok: false,
      error: { kind: 'sign_in_required' },
    });
    expect(await f.feature.describe(request)).toMatchObject({ value: { connected: false } });
  });
  it('forgets every grant on disposal', async () => {
    const f = fixture();
    await f.feature.connect(request);
    f.feature.dispose();
    expect((await f.feature.list(request)).ok).toBe(false);
  });
  it.each(['disconnect', 'reset', 'dispose'] as const)(
    'aborts pending account authentication on %s and rejects its late result',
    async (action) => {
      const f = fixture();
      let finish!: () => void;
      let signal!: AbortSignal;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      f.connectAccount.mockImplementationOnce(async (pendingSignal) => {
        signal = pendingSignal;
        await waiting;
        return {
          ok: true,
          value: { kind: 'cli', createReader: f.createReader, isCurrent: f.isCurrent },
        };
      });
      const pending = f.feature.connect(request);
      await vi.waitFor(() => expect(f.connectAccount).toHaveBeenCalledOnce());
      if (action === 'disconnect') await f.feature.disconnect(request);
      else f.feature[action]();
      expect(signal.aborted).toBe(true);
      finish();
      expect((await pending).ok).toBe(false);
      expect(await f.feature.describe(request)).toMatchObject({ value: { connected: false } });
    }
  );
  it.each(['same', 'different'] as const)(
    'scopes overlapping connects to the %s repository',
    async (mode) => {
      const f = fixture();
      f.projects.resolve.mockImplementation(async (input = request) => ({
        ok: true,
        value: {
          repository: { ...repository, repo: input.projectId },
          scope: f.projects.currentScope(),
        },
      }));
      let finish!: () => void;
      let signal!: AbortSignal;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      f.connectAccount.mockImplementationOnce(async (pendingSignal) => {
        signal = pendingSignal;
        await waiting;
        return {
          ok: true,
          value: { kind: 'cli', createReader: f.createReader, isCurrent: f.isCurrent },
        };
      });
      const first = f.feature.connect(request);
      await vi.waitFor(() => expect(f.connectAccount).toHaveBeenCalledOnce());
      const other = mode === 'same' ? request : { ...request, projectId: 'TEST-other' };
      expect((await f.feature.connect(other)).ok).toBe(true);
      expect(signal.aborted).toBe(mode === 'same');
      finish();
      expect((await first).ok).toBe(mode === 'different');
      expect(await f.feature.describe(other)).toMatchObject({ value: { connected: true } });
    }
  );
  it.each([
    null,
    { ...request, operation: 'get', number: -1 },
    { ...request, operation: 'get', number: 1.5 },
    { ...request, operation: 'list', page: 0 },
    { ...request, operation: 'list', page: 1001 },
    { ...request, operation: 'shell', command: 'TEST' },
    { ...request, operation: 'describe', projectId: '\0' },
  ])('rejects unbounded or unrecognized transport request %j', (value) =>
    expect(isMonitorRequest(value)).toBe(false)
  );
});
