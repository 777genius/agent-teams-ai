import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DetailReadCoordinator, useCompletionRead } from '@features/member-log-reads/renderer';

import type { EnhancedUserChunk, ParsedMessage, MemberLogSummary } from '@shared/types';

const fixtures = vi.hoisted(() => ({
  summary: vi.fn(),
  detail: vi.fn(),
  subagent: vi.fn(),
  state: {
    activeTabId: 'visible-test-tab',
    activeContextId: 'synthetic-context',
    connectionMode: 'local',
    connectionState: 'connected',
    connectedHost: null,
    appConfig: { general: { claudeRootPath: '/synthetic-test/claude' } },
  },
}));

vi.mock('@renderer/store', () => ({
  useStore: Object.assign(
    (selector: (state: typeof fixtures.state) => unknown) => selector(fixtures.state),
    { getState: () => fixtures.state }
  ),
}));
vi.mock('@renderer/contexts/useTabUIContext', () => ({
  useTabIdOptional: () => 'visible-test-tab',
}));
vi.mock('@renderer/api', () => ({
  api: {
    teams: { getLogsForTask: fixtures.summary, getMemberLogs: fixtures.summary },
    getSessionDetail: fixtures.detail,
    getSubagentDetail: fixtures.subagent,
  },
}));
vi.mock('@renderer/components/team/members/MemberExecutionLog', () => ({
  MemberExecutionLog: ({ chunks }: { chunks: { id: string }[] }) =>
    React.createElement(
      'div',
      { 'data-testid': 'selected-detail' },
      chunks.map((c) => c.id).join(',')
    ),
}));
vi.mock('@renderer/components/team/members/SubagentRecentMessagesPreview', () => ({
  SubagentRecentMessagesPreview: () => React.createElement('div', null, 'Preview'),
}));
vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: () => null,
}));

import { MemberLogsTab } from '@renderer/components/team/members/MemberLogsTab';
import { invalidateContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function log(sessionId: string, ongoing = false): MemberLogSummary {
  return {
    kind: 'member_session',
    sessionId,
    projectId: 'synthetic-test-project',
    description: sessionId,
    memberName: 'test-member',
    startTime: '2026-10-06T10:00:00Z',
    durationMs: 0,
    messageCount: 1,
    isOngoing: ongoing,
  };
}

function chunk(id: string, startTime = new Date(), endTime = startTime): EnhancedUserChunk {
  const message: ParsedMessage = {
    uuid: id,
    parentUuid: null,
    type: 'user',
    timestamp: startTime,
    content: `test content ${id}`,
    isMeta: false,
    isSidechain: false,
    toolCalls: [],
    toolResults: [],
  };
  return {
    id,
    chunkType: 'user',
    rawMessages: [message],
    userMessage: message,
    startTime,
    endTime,
    durationMs: endTime.getTime() - startTime.getTime(),
    metrics: {
      durationMs: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      messageCount: 1,
    },
  };
}

function detail(id: string): { chunks: EnhancedUserChunk[] } {
  return { chunks: [chunk(id)] };
}

async function flush(action: () => void = () => undefined): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

describe('mounted synthetic member-log read ownership', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const base = { teamName: 'synthetic-test-team', taskId: 'test-task', taskOwner: 'test-member' };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
    invalidateContextScopedRequestEpoch();
    fixtures.state.activeTabId = 'visible-test-tab';
    fixtures.state.appConfig.general.claudeRootPath = '/synthetic-test/claude';
    fixtures.summary.mockReset().mockResolvedValue([]);
    fixtures.detail.mockReset().mockResolvedValue(detail('default-test-detail'));
    fixtures.subagent.mockReset().mockResolvedValue(detail('default-test-subagent'));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await flush(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function render(
    props: Partial<React.ComponentProps<typeof MemberLogsTab>> = {},
    strict = false
  ) {
    await flush(() => {
      const node = React.createElement(MemberLogsTab, { ...base, ...props });
      root.render(strict ? React.createElement(React.StrictMode, null, node) : node);
    });
  }
  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }
  async function expand(text: string) {
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(text)
    );
    expect(button).toBeTruthy();
    await flush(() => button!.click());
  }

  it('does not overlap a slow summary and waits 5000ms after settlement', async () => {
    const first = deferred<MemberLogSummary[]>();
    fixtures.summary.mockReturnValueOnce(first.promise);
    await render({ taskStatus: 'in_progress' });
    expect(fixtures.summary).toHaveBeenCalledTimes(1);
    await advance(15_000);
    expect(fixtures.summary).toHaveBeenCalledTimes(1);
    await flush(() => first.resolve([log('current-summary')]));
    expect(container.textContent).toContain('current-summary');
    await advance(4999);
    expect(fixtures.summary).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fixtures.summary).toHaveBeenCalledTimes(2);
  });

  it('skips hidden initial work and retires publication when hidden mid-read', async () => {
    fixtures.state.activeTabId = 'other-test-tab';
    await render({ taskStatus: 'in_progress' });
    expect(fixtures.summary).not.toHaveBeenCalled();
    fixtures.state.activeTabId = 'visible-test-tab';
    const pending = deferred<MemberLogSummary[]>();
    fixtures.summary.mockReturnValueOnce(pending.promise);
    await render({ taskStatus: 'in_progress' });
    fixtures.state.activeTabId = 'other-test-tab';
    await render({ taskStatus: 'in_progress' });
    await flush(() => pending.resolve([log('retired-hidden-result')]));
    expect(container.textContent).not.toContain('retired-hidden-result');
    await advance(20_000);
    expect(fixtures.summary).toHaveBeenCalledTimes(1);
  });

  it('works under StrictMode setup-cleanup-setup without duplicate physical reads', async () => {
    fixtures.summary.mockResolvedValue([log('strict-current')]);
    await render({}, true);
    expect(fixtures.summary).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('strict-current');
  });

  it('does not let old row success or finally replace a new pending selection', async () => {
    fixtures.summary.mockResolvedValue([log('row-a'), log('row-b')]);
    const a = deferred<ReturnType<typeof detail>>();
    const b = deferred<ReturnType<typeof detail>>();
    fixtures.detail.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    await render();
    await expand('row-a');
    await expand('row-b');
    await flush(() => a.resolve(detail('stale-a-detail')));
    expect(container.textContent).not.toContain('stale-a-detail');
    expect(container.querySelector('[data-testid="selected-detail"]')).toBeNull();
    await flush(() => b.resolve(detail('current-b-detail')));
    expect(container.querySelector('[data-testid="selected-detail"]')?.textContent).toBe(
      'current-b-detail'
    );
  });

  it('shares preview and row session reads while keeping row identity separate', async () => {
    fixtures.summary.mockResolvedValue([log('shared-session')]);
    const pending = deferred<ReturnType<typeof detail>>();
    fixtures.detail.mockReturnValueOnce(pending.promise);
    await render({ showSubagentPreview: true });
    expect(fixtures.detail).toHaveBeenCalledTimes(1);
    await expand('shared-session');
    expect(fixtures.detail).toHaveBeenCalledTimes(1);
    await flush(() => pending.resolve(detail('shared-detail')));
    expect(container.querySelector('[data-testid="selected-detail"]')?.textContent).toBe(
      'shared-detail'
    );
  });

  it('does not refetch detail on equivalent new summary objects but updates preview text', async () => {
    fixtures.summary.mockResolvedValue([log('stable-session')]);
    await render({ showSubagentPreview: true });
    expect(fixtures.detail).toHaveBeenCalledTimes(1);
    await render({ showSubagentPreview: true, taskStatus: 'in_progress' });
    expect(fixtures.detail).toHaveBeenCalledTimes(1);
    fixtures.summary.mockResolvedValue([
      { ...log('stable-session'), lastOutputPreview: 'new-summary-output' },
    ]);
    await advance(5000);
    expect(container.textContent).toContain('new-summary-output');
    expect(fixtures.detail).toHaveBeenCalledTimes(2);
    await advance(4999);
    expect(fixtures.detail).toHaveBeenCalledTimes(2);
  });

  it('fences same-ID context epoch and root replacement before old completion', async () => {
    const old = deferred<MemberLogSummary[]>();
    fixtures.summary.mockReturnValueOnce(old.promise).mockResolvedValue([log('new-root-result')]);
    await render();
    invalidateContextScopedRequestEpoch();
    fixtures.state.appConfig.general.claudeRootPath = '/synthetic-test/replaced-claude';
    await render();
    await flush(() => old.resolve([log('old-root-result')]));
    expect(container.textContent).not.toContain('old-root-result');
    expect(container.textContent).toContain('new-root-result');
  });

  it('preserves the 250ms refresh minimum and clears polling on disable', async () => {
    const refreshing = vi.fn();
    fixtures.summary.mockResolvedValue([log('refresh-row')]);
    await render({ taskStatus: 'in_progress', onRefreshingChange: refreshing });
    await advance(5000);
    expect(refreshing).toHaveBeenLastCalledWith(true);
    await advance(249);
    expect(refreshing).toHaveBeenLastCalledWith(true);
    await advance(1);
    expect(refreshing).toHaveBeenLastCalledWith(false);
    await render({ enabled: false, taskStatus: 'in_progress', onRefreshingChange: refreshing });
    await advance(15_000);
    expect(fixtures.summary).toHaveBeenCalledTimes(2);
    expect(refreshing).toHaveBeenLastCalledWith(false);
  });

  it('shows summary polling errors and waits for the next scheduled retry', async () => {
    fixtures.summary
      .mockResolvedValueOnce([log('before-summary-error')])
      .mockRejectedValueOnce(new Error('observable-summary-poll-error'))
      .mockResolvedValue([log('after-summary-retry')]);
    await render({ taskStatus: 'in_progress' });
    await advance(5000);
    expect(container.textContent).toContain('observable-summary-poll-error');
    expect(fixtures.summary).toHaveBeenCalledTimes(2);
    await advance(4999);
    expect(fixtures.summary).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(container.textContent).not.toContain('observable-summary-poll-error');
    expect(container.textContent).toContain('after-summary-retry');
  });

  it('shows refreshing feedback for a status-only request with retained completed rows', async () => {
    fixtures.summary.mockResolvedValue([log('status-policy-row')]);
    const refreshing = vi.fn();
    await render({ taskStatus: 'pending', onRefreshingChange: refreshing });
    expect(refreshing).toHaveBeenLastCalledWith(false);
    await render({ taskStatus: 'in_progress', onRefreshingChange: refreshing });
    expect(container.textContent).toContain('status-policy-row');
    expect(refreshing).toHaveBeenLastCalledWith(true);
    await advance(250);
    expect(refreshing).toHaveBeenLastCalledWith(false);
  });

  it('releases the completed closed owner before a replacement read settles', async () => {
    const coordinator = new DetailReadCoordinator<EnhancedUserChunk[]>();
    const scope = { key: 'synthetic-closed-view-scope', source: {}, isCurrent: () => true };
    const replacement = deferred<EnhancedUserChunk[]>();
    const read = vi
      .fn()
      .mockResolvedValueOnce([chunk('closed-owner-payload')])
      .mockReturnValueOnce(replacement.promise);
    function Probe({ open }: { open: boolean }): React.JSX.Element {
      const result = useCompletionRead({
        coordinator,
        scope,
        key: open ? 'synthetic-selected-source' : null,
        active: true,
        poll: false,
        read,
        beginRefreshing: () => () => undefined,
      });
      return React.createElement(
        'div',
        { 'data-testid': 'owned-payload' },
        result.value?.map((value) => value.id).join(',') ?? 'no-owned-payload'
      );
    }
    await flush(() => root.render(React.createElement(Probe, { open: true })));
    expect(container.textContent).toBe('closed-owner-payload');
    await flush(() => root.render(React.createElement(Probe, { open: false })));
    expect(container.textContent).toBe('no-owned-payload');
    await flush(() => root.render(React.createElement(Probe, { open: true })));
    expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('no-owned-payload');
    await flush(() => replacement.resolve([chunk('replacement-owner-payload')]));
    expect(container.textContent).toBe('replacement-owner-payload');
  });

  it('keeps another mounted subscriber and its projection when one view leaves', async () => {
    fixtures.summary.mockResolvedValue([log('shared-two-views')]);
    const pending = deferred<ReturnType<typeof detail>>();
    fixtures.detail.mockReturnValueOnce(pending.promise);
    const otherContainer = document.createElement('div');
    document.body.append(otherContainer);
    const otherRoot = createRoot(otherContainer);
    try {
      await render();
      await flush(() =>
        otherRoot.render(
          React.createElement(MemberLogsTab, {
            ...base,
            taskId: 'different-test-task',
            taskWorkIntervals: [
              { startedAt: '2026-10-06T10:02:00Z', completedAt: '2026-10-06T10:02:05Z' },
            ],
          })
        )
      );
      await expand('shared-two-views');
      const otherButton = otherContainer.querySelector('button');
      expect(otherButton).toBeTruthy();
      await flush(() => otherButton!.click());
      expect(fixtures.detail).toHaveBeenCalledTimes(1);
      await expand('shared-two-views');
      await flush(() =>
        pending.resolve({
          chunks: [
            chunk(
              'outside-other-interval',
              new Date('2026-10-06T10:00:00Z'),
              new Date('2026-10-06T10:00:01Z')
            ),
            chunk(
              'inside-other-interval',
              new Date('2026-10-06T10:02:00Z'),
              new Date('2026-10-06T10:02:01Z')
            ),
          ],
        })
      );
      expect(container.querySelector('[data-testid="selected-detail"]')).toBeNull();
      expect(otherContainer.querySelector('[data-testid="selected-detail"]')?.textContent).toBe(
        'inside-other-interval'
      );
    } finally {
      await flush(() => otherRoot.unmount());
      otherContainer.remove();
    }
  });
});
