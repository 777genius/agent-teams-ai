import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  contextId: 'local',
  epoch: 1,
  api: {
    describe: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    signOut: vi.fn(),
    beginLogin: vi.fn(),
    cancelLogin: vi.fn(),
  },
}));
vi.mock('@renderer/api', () => ({ api: { prMonitor: fixture.api } }));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: { activeContextId: string }) => unknown) =>
    selector({ activeContextId: fixture.contextId }),
}));
vi.mock('@renderer/store/utils/contextScopedRequestEpoch', () => ({
  captureContextScopedRequestEpoch: () => fixture.epoch,
  subscribeContextScopedRequestEpoch: () => () => undefined,
}));

import { useGitHubLogin } from '../../../src/features/pr-monitor/renderer/hooks/useGitHubLogin';
import {
  nextPollDelay,
  useProjectPullRequests,
} from '../../../src/features/pr-monitor/renderer/hooks/useProjectPullRequests';

import type { DeviceLogin, MonitorResult } from '../../../src/features/pr-monitor/contracts';
import type { PullRequestSnapshot, PullRequestSummary } from '@pr-monitor/core';

const repo = { provider: 'github' as const, owner: 'TEST', repo: 'fixture' };
const summary = (number: number): PullRequestSummary => ({
  repository: repo,
  number,
  title: `PR ${number}`,
  url: `https://github.com/TEST/fixture/pull/${number}`,
  author: 'tester',
  headSha: 'a'.repeat(40),
  headBranch: 'topic',
  baseBranch: 'main',
  state: 'open',
  draft: false,
  createdAt: '2026-11-28T15:00:00Z',
  updatedAt: '2026-11-28T16:00:00Z',
});
const snapshot = (number: number): PullRequestSnapshot => ({
  pullRequest: summary(number),
  checks: [],
  runs: [],
  reviews: [],
  merge: { mergeable: null, state: 'unknown' },
  coverage: { checks: 'complete', workflows: 'complete', jobs: 'complete', reviews: 'complete' },
  fetchedAt: '2026-11-28T16:00:00Z',
  issues: [],
});
let latest!: ReturnType<typeof useProjectPullRequests>;
const host = document.createElement('div');
let root: ReturnType<typeof createRoot>;
function Probe({ project = 'TEST-A', active = true }: { project?: string; active?: boolean }) {
  latest = useProjectPullRequests(project, active);
  return null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.contextId = 'local';
  fixture.epoch = 1;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  vi.clearAllMocks();
  vi.useFakeTimers();
  fixture.api.describe.mockResolvedValue({
    ok: true,
    value: { repository: repo, connected: true },
  });
  fixture.api.list.mockResolvedValue({
    ok: true,
    value: { items: [summary(1), summary(2)], nextPage: null, fetchedAt: '2026-11-28T16:00:00Z' },
  });
  fixture.api.get.mockImplementation(async ({ number }: { number: number }) => ({
    ok: true,
    value: snapshot(number),
  }));
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('project polling', () => {
  it('pauses hidden tabs and resumes without discarding the selected PR', async () => {
    await act(async () => root.render(<Probe />));
    await act(async () => latest.select(summary(1)));
    expect(latest.snapshot?.pullRequest.number).toBe(1);
    await act(async () => root.render(<Probe active={false} />));
    const count = fixture.api.list.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fixture.api.list).toHaveBeenCalledTimes(count);
    await act(async () => root.render(<Probe />));
    expect(fixture.api.list).toHaveBeenCalledTimes(count + 1);
    expect(latest.snapshot?.pullRequest.number).toBe(1);
  });
  it('clears detail loading when a polling response supersedes a manual selection', async () => {
    let finishList!: (value: unknown) => void;
    let finishSelected!: (value: unknown) => void;
    await act(async () => root.render(<Probe />));
    fixture.api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishList = resolve;
        })
    );
    fixture.api.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSelected = resolve;
        })
    );
    await act(async () => {
      latest.refresh();
    });
    let selected!: Promise<void>;
    await act(async () => {
      selected = latest.select(summary(1));
    });
    expect(latest.loadingDetail).toBe(true);
    await act(async () => {
      finishList({
        ok: true,
        value: { items: [summary(1)], nextPage: null, fetchedAt: '2026-11-28T16:00:00Z' },
      });
    });
    expect(latest.snapshot?.pullRequest.number).toBe(1);
    expect(latest.loadingDetail).toBe(false);
    await act(async () => {
      finishSelected({ ok: true, value: snapshot(1) });
      await selected;
    });
    expect(latest.loadingDetail).toBe(false);
  });
  it('never replaces a newer selection with an older slow response', async () => {
    let finish!: (value: MonitorResult<PullRequestSnapshot>) => void;
    fixture.api.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await act(async () => root.render(<Probe />));
    let old!: Promise<void>;
    await act(async () => {
      old = latest.select(summary(1));
    });
    await act(async () => latest.select(summary(2)));
    await act(async () => {
      finish({ ok: true, value: snapshot(1) });
      await old;
    });
    expect(latest.selectedNumber).toBe(2);
    expect(latest.snapshot?.pullRequest.number).toBe(2);
  });
  it('discards a pending response on a context/project change', async () => {
    let finish!: (value: MonitorResult<PullRequestSnapshot>) => void;
    fixture.api.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await act(async () => root.render(<Probe />));
    let old!: Promise<void>;
    await act(async () => {
      old = latest.select(summary(1));
    });
    fixture.epoch++;
    await act(async () => root.render(<Probe project="TEST-B" />));
    await act(async () => {
      finish({ ok: true, value: snapshot(1) });
      await old;
    });
    expect(latest.snapshot).toBeNull();
    expect(latest.selectedNumber).toBeUndefined();
  });
  it('does not bypass server Retry-After on manual refresh', async () => {
    const retryAt = new Date(Date.now() + 300_000).toISOString();
    fixture.api.list.mockResolvedValue({
      ok: false,
      error: { kind: 'rate_limited', message: 'Wait.', retryAt },
    });
    await act(async () => root.render(<Probe />));
    await act(async () => {
      latest.refresh();
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fixture.api.list).toHaveBeenCalledTimes(1);
    expect(
      nextPollDelay({ kind: 'rate_limited', message: 'Wait.', retryAt }, 1, Date.now())
    ).toBeGreaterThanOrEqual(240_000);
  });
  it('reflects local sign-out immediately while provider requests are cooling down', async () => {
    fixture.api.list.mockResolvedValue({
      ok: false,
      error: {
        kind: 'rate_limited',
        message: 'Wait.',
        retryAt: new Date(Date.now() + 300_000).toISOString(),
      },
    });
    await act(async () => root.render(<Probe />));
    fixture.api.describe.mockResolvedValue({
      ok: true,
      value: { repository: repo, connected: false },
    });
    await act(async () => latest.connectionChanged());
    expect(latest.repository?.connected).toBe(false);
    expect(latest.snapshot).toBeNull();
    expect(latest.error).toBeNull();
    expect(fixture.api.list).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    'clears an inactive monitor on global sign-out, including failed vault deletion (%s)',
    async (deletionFails) => {
      let first!: ReturnType<typeof useProjectPullRequests>;
      let second!: ReturnType<typeof useProjectPullRequests>;
      let login!: ReturnType<typeof useGitHubLogin>;
      function Monitors({ secondActive = true }: { secondActive?: boolean }) {
        first = useProjectPullRequests('TEST-A', true);
        second = useProjectPullRequests('TEST-B', secondActive);
        login = useGitHubLogin('TEST-A', true, first.connectionChanged);
        return null;
      }
      await act(async () => root.render(<Monitors />));
      await act(async () => {
        await first.select(summary(1));
        await second.select(summary(2));
      });
      await act(async () => root.render(<Monitors secondActive={false} />));
      expect(second.snapshot?.pullRequest.number).toBe(2);
      expect(second.items).toHaveLength(2);
      fixture.api.signOut.mockImplementationOnce(async () => {
        fixture.api.describe.mockResolvedValue({
          ok: true,
          value: { repository: repo, connected: false },
        });
        if (deletionFails)
          throw new Error('TEST vault deletion failed after authority was retired');
        return { ok: true, value: null };
      });
      await act(async () => login.signOut());
      for (const monitor of [first, second]) {
        expect(monitor.items).toEqual([]);
        expect(monitor.snapshot).toBeNull();
        expect(monitor.selectedNumber).toBeUndefined();
      }
      expect(second.repository).toBeNull();
    }
  );
  it.each(['rejected', 'stale-project', 'stale-sign-out'] as const)(
    'clears another inactive monitor when an account change settles with %s',
    async (outcome) => {
      let first!: ReturnType<typeof useProjectPullRequests>;
      let second!: ReturnType<typeof useProjectPullRequests>;
      let login!: ReturnType<typeof useGitHubLogin>;
      function Monitors({
        firstProject = 'TEST-A',
        secondActive = true,
      }: {
        firstProject?: string;
        secondActive?: boolean;
      }) {
        first = useProjectPullRequests(firstProject, true);
        second = useProjectPullRequests('TEST-B', secondActive);
        login = useGitHubLogin(firstProject, true, first.connectionChanged);
        return null;
      }
      await act(async () => root.render(<Monitors />));
      await act(async () => second.select(summary(2)));
      await act(async () => root.render(<Monitors secondActive={false} />));
      let resolve!: (value: MonitorResult<DeviceLogin | null>) => void;
      let reject!: (error: Error) => void;
      const operation = outcome === 'stale-sign-out' ? 'signOut' : 'beginLogin';
      fixture.api[operation].mockImplementationOnce(
        () =>
          new Promise((done, fail) => {
            resolve = done;
            reject = fail;
          })
      );
      fixture.api.cancelLogin.mockResolvedValue({ ok: true, value: null });
      let pending!: Promise<void>;
      await act(async () => {
        pending = operation === 'signOut' ? login.signOut() : login.begin();
      });
      fixture.api.describe.mockResolvedValue({
        ok: true,
        value: { repository: repo, connected: false },
      });
      if (outcome !== 'rejected')
        await act(async () => root.render(<Monitors firstProject="TEST-C" secondActive={false} />));
      expect(second.snapshot?.pullRequest.number).toBe(2);
      await act(async () => {
        if (outcome === 'rejected') reject(new Error('TEST IPC failure after account retirement'));
        else if (outcome === 'stale-sign-out') resolve({ ok: true, value: null });
        else
          resolve({
            ok: true,
            value: {
              attemptId: 'TEST-attempt',
              userCode: 'TEST-CODE',
              verificationUri: 'https://github.com/login/device',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              intervalMs: 5000,
            },
          });
        await pending;
      });
      expect(second.items).toEqual([]);
      expect(second.snapshot).toBeNull();
      expect(second.selectedNumber).toBeUndefined();
    }
  );
  it('clears previous-account observations immediately after authority is revoked', async () => {
    await act(async () => root.render(<Probe />));
    await act(async () => latest.select(summary(1)));
    expect(latest.snapshot?.pullRequest.number).toBe(1);
    fixture.api.list.mockResolvedValue({
      ok: false,
      error: { kind: 'sign_in_required', message: 'Connect GitHub again.', retryAt: null },
    });
    await act(async () => latest.refresh());
    expect(latest.repository?.connected).toBe(false);
    expect(latest.items).toEqual([]);
    expect(latest.snapshot).toBeNull();
    expect(latest.selectedNumber).toBeUndefined();
    expect(latest.error?.kind).toBe('sign_in_required');
  });
  it('refreshes the loaded page range without losing later selection or pagination', async () => {
    fixture.api.list.mockImplementation(async ({ page = 1 }: { page?: number }) => ({
      ok: true,
      value: {
        items: page === 1 ? [summary(1), summary(2)] : [summary(page + 1)],
        nextPage: page < 3 ? page + 1 : null,
        fetchedAt: '2026-11-28T16:00:00Z',
      },
    }));
    await act(async () => root.render(<Probe />));
    await act(async () => latest.loadMore());
    await act(async () => latest.select(summary(3)));
    expect(latest.items.map((item) => item.number)).toEqual([1, 2, 3]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(latest.items.map((item) => item.number)).toEqual([1, 2, 3]);
    expect(latest.selectedNumber).toBe(3);
    expect(latest.snapshot?.pullRequest.number).toBe(3);
    expect(latest.nextPage).toBe(3);
    await act(async () => latest.loadMore());
    expect(latest.items.map((item) => item.number)).toEqual([1, 2, 3, 4]);
    expect(latest.nextPage).toBeNull();
  });
});
