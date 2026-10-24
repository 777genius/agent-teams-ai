import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { MemberLogsTab } from '@renderer/components/team/members/MemberLogsTab';
import { MemberStatsTab } from '@renderer/components/team/members/MemberStatsTab';
import { expect, it, vi } from 'vitest';

import type { AppState } from '@renderer/store/types';
const mocks = vi.hoisted(() => ({
  stats: vi.fn(),
  logs: vi.fn(),
  session: vi.fn(),
  usage: vi.fn(() => {
    throw new Error('Legacy usage must not run for Host facts');
  }),
}));
vi.mock('@renderer/api', () => ({
  api: {
    teams: { getMemberStats: mocks.stats, getMemberLogs: mocks.logs, getLogsForTask: mocks.logs },
    getSessionDetail: mocks.session,
  },
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@features/token-usage/renderer', () => ({
  useTokenUsageSnapshot: mocks.usage,
  formatKiroCredits: String,
}));
vi.mock('@renderer/contexts/useTabUIContext', () => ({ useTabIdOptional: () => null }));
vi.mock('@renderer/store', async () => {
  const { create } = await import('zustand');
  return {
    useStore: create<
      Pick<
        AppState,
        'activeTabId' | 'activeContextId' | 'connectionMode' | 'connectionState' | 'connectedHost'
      >
    >(() => ({
      activeTabId: null,
      activeContextId: 'local',
      connectionMode: 'local',
      connectionState: 'disconnected',
      connectedHost: null,
    })),
  };
});
vi.mock('@renderer/components/team/members/MemberExecutionLog', () => ({
  MemberExecutionLog: () => null,
}));
vi.mock('@renderer/components/team/members/SubagentRecentMessagesPreview', () => ({
  SubagentRecentMessagesPreview: () => null,
}));
const facts = {
  kind: 'host_activity' as const,
  sessionId: 'host-TEST',
  memberId: 'alice',
  memberName: 'alice',
  generation: '1',
  description: 'Captured runtime activity',
  startTime: null,
  durationMs: null,
  messageCount: 1,
  isOngoing: false,
  gaps: ['retention'],
  events: [
    {
      sequence: 1,
      eventId: 'a',
      inputId: 'input',
      data: {
        kind: 'text' as const,
        messageRef: 'msg',
        block: 0,
        phase: 'snapshot' as const,
        text: 'older snapshot',
      },
    },
    {
      sequence: 2,
      eventId: 'b',
      inputId: 'input',
      data: {
        kind: 'text' as const,
        messageRef: 'msg',
        block: 0,
        phase: 'complete' as const,
        text: 'actual final output',
      },
    },
    {
      sequence: 3,
      eventId: 'c',
      inputId: 'input',
      data: {
        kind: 'tool' as const,
        messageRef: 'msg',
        toolRef: 'tool',
        name: 'Read',
        input: { file_path: 'TEST-file' },
      },
    },
    {
      sequence: 4,
      eventId: 'd',
      inputId: 'input',
      data: { kind: 'compaction' as const, sourceRef: 'compact', reason: 'automatic' as const },
    },
  ],
};
it('mounted existing Stats/Logs show actual facts/unknowns without legacy transcript or metering reads', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.stats.mockResolvedValue({
    kind: 'host_activity_stats',
    memberName: 'alice',
    scope: 'retained_runtime_activity',
    generations: 1,
    observedMessages: 1,
    toolUsage: { Read: 1 },
    compactions: 1,
    inputTokens: null,
    outputTokens: 7,
    costUsd: null,
    gaps: ['retention'],
    computedAt: '2026-10-23T00:00:00Z',
  });
  mocks.logs.mockResolvedValue([facts]);
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.appendChild(host);
  try {
    await act(async () => {
      root.render(<MemberStatsTab teamName="host-team:TEST" memberName="alice" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('Unknown');
    expect(host.textContent).toContain('Reported output tokens');
    expect(host.textContent).toContain('7');
    expect(host.textContent).toContain('retention');
    expect(mocks.usage).not.toHaveBeenCalled();
    await act(async () => {
      root.render(<MemberLogsTab teamName="host-team:TEST" memberName="alice" enabled />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('timestamps unavailable');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-expanded]')!.click();
    });
    expect(host.textContent).toContain('actual final output');
    expect(host.textContent).not.toContain('older snapshot');
    expect(host.textContent).toContain('Read');
    expect(host.textContent).toContain('compaction');
    expect(mocks.session).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
