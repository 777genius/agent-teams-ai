import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { DEFAULT_CLAUDE_LOGS_FILTER } from '@renderer/components/team/claudeLogsFilterState';
import {
  HostMemberActivityLog,
  useHostLogViewport,
} from '@renderer/components/team/members/HostMemberActivityLog';
import { MemberLogsTab } from '@renderer/components/team/members/MemberLogsTab';
import { MemberStatsTab } from '@renderer/components/team/members/MemberStatsTab';
import { createDefaultClaudeLogsSidebarUiState } from '@renderer/components/team/sidebar/teamSidebarUiState';
import { afterEach, expect, it, vi } from 'vitest';

import type { HostLogViewOptions } from '@renderer/components/team/members/HostMemberActivityLog';
import type { AppState } from '@renderer/store/types';
import type { HostMemberActivityLog as HostLog } from '@shared/types/teamActivity';
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
        | 'activeTabId'
        | 'activeContextId'
        | 'connectionMode'
        | 'connectionState'
        | 'connectedHost'
        | 'searchMatchItemIds'
        | 'searchQuery'
        | 'searchMatches'
        | 'currentSearchIndex'
      >
    >(() => ({
      activeTabId: null,
      activeContextId: 'local',
      connectionMode: 'local',
      connectionState: 'disconnected',
      connectedHost: null,
      searchMatchItemIds: new Set(),
      searchQuery: 'final',
      searchMatches: [],
      currentSearchIndex: -1,
    })),
  };
});
vi.mock('@renderer/components/team/members/MemberExecutionLog', () => ({
  MemberExecutionLog: () => null,
}));
vi.mock('@renderer/components/team/members/SubagentRecentMessagesPreview', () => ({
  SubagentRecentMessagesPreview: () => null,
}));
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ isLight: false }) }));
vi.mock('@renderer/components/chat/viewers/useResolvedViewerTeamContext', () => ({
  useResolvedViewerTeamContext: () => ({ teamColorByName: new Map() }),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

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

function ControlledLog({
  log,
  query = '',
  filter = DEFAULT_CLAUDE_LOGS_FILTER,
  pane = 'compact',
}: {
  log: HostLog;
  query?: string;
  filter?: HostLogViewOptions['filter'];
  pane?: string;
}) {
  const [viewerState, onViewerStateChange] = React.useState(
    () => createDefaultClaudeLogsSidebarUiState().viewerState
  );
  return (
    <HostMemberActivityLog
      key={pane}
      log={log}
      expanded
      onToggle={() => undefined}
      view={{ searchQuery: query, filter, viewerState, onViewerStateChange }}
    />
  );
}

it('deduplicates before filtering, preserves complete blocks and renders copyable rich output', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const finalText = 'actual **final output**';
  const log: HostLog = {
    ...facts,
    events: [
      ...facts.events.filter((event) => event.eventId !== 'b'),
      {
        eventId: 'b',
        sequence: 2,
        inputId: 'input',
        data: { kind: 'text', messageRef: 'msg', block: 0, phase: 'complete', text: finalText },
      },
      {
        eventId: 'late',
        sequence: 5,
        inputId: 'input',
        data: {
          kind: 'text',
          messageRef: 'msg',
          block: 0,
          phase: 'snapshot',
          text: 'late stale snapshot',
        },
      },
      {
        eventId: 'other',
        sequence: 6,
        inputId: 'input',
        data: {
          kind: 'text',
          messageRef: 'different-message',
          block: 0,
          phase: 'complete',
          text: finalText,
        },
      },
      {
        eventId: 'thinking',
        sequence: 7,
        inputId: 'input',
        data: {
          kind: 'thinking',
          messageRef: 'msg',
          block: 0,
          phase: 'complete',
          text: 'actual reasoning',
        },
      },
      {
        eventId: 'result',
        sequence: 8,
        inputId: 'input',
        data: {
          kind: 'tool-result',
          toolRef: 'tool',
          content: 'actual tool output',
          isError: true,
        },
      },
      {
        eventId: 'other-input',
        sequence: 9,
        inputId: 'different-input',
        data: {
          kind: 'text',
          messageRef: 'msg',
          block: 0,
          phase: 'complete',
          text: 'separate input',
        },
      },
    ],
  };
  const host = document.createElement('div'),
    root = createRoot(host);
  const copy = vi.fn().mockResolvedValue(undefined);
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  document.body.appendChild(host);
  const render = async (query = '', filter = DEFAULT_CLAUDE_LOGS_FILTER, pane = 'compact') => {
    await act(async () =>
      root.render(<ControlledLog log={log} query={query} filter={filter} pane={pane} />)
    );
  };
  try {
    await render();
    expect(host.querySelectorAll('[data-host-log-kind="text"]')).toHaveLength(3);
    expect(host.querySelector('[data-host-log-event-id="late"]')).toBeNull();
    expect(host.querySelector('[data-host-log-event-id="a"]')).toBeNull();
    const failedResult = host.querySelector<HTMLElement>('[data-host-log-event-id="result"]')!;
    expect(failedResult.dataset.hostLogIsError).toBe('true');
    expect(
      failedResult.querySelector<HTMLElement>('.base-item-status-dot')?.style.backgroundColor
    ).toBe('#ef4444');
    await act(async () => failedResult.querySelector<HTMLElement>('[role="button"]')!.click());
    expect(failedResult.querySelector('[data-host-log-content]')?.textContent).toContain(
      'actual tool output'
    );
    await act(async () => {
      host.querySelector<HTMLElement>('[data-host-log-event-id="b"] [role="button"]')!.click();
    });
    expect(host.querySelector('[data-host-log-event-id="b"] strong')?.textContent).toBe(
      'final output'
    );
    expect(host.querySelector('[data-host-log-event-id="b"] [data-search-result]')).toBeNull();
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(
          '[data-host-log-event-id="b"] button[title="actions.copyToClipboard"]'
        )!
        .click();
    });
    expect(copy).toHaveBeenCalledWith(finalText);
    await render('', DEFAULT_CLAUDE_LOGS_FILTER, 'fullscreen');
    expect(
      host.querySelector('[data-host-log-event-id="b"] [data-host-log-content]')
    ).not.toBeNull();
    await render('older snapshot');
    expect(host.querySelectorAll('[data-host-log-kind]')).toHaveLength(0);
    expect(host.textContent).toContain('claudeLogs.noMatchingLogs');
    expect(host.textContent).toContain('retention');
    await render('Read', { streams: new Set(['stdout']), kinds: new Set(['tool']) });
    expect(
      host.querySelectorAll('[data-host-log-kind="tool"],[data-host-log-kind="tool-result"]')
    ).toHaveLength(2);
    expect(host.querySelector('[data-host-log-kind="text"]')).toBeNull();
    for (const streams of [new Set<'stderr'>(['stderr']), new Set<'stdout' | 'stderr'>()]) {
      await render('', { streams, kinds: new Set(['thinking']) });
      expect(host.textContent).toContain('actual reasoning');
      expect(host.querySelector('[data-host-log-kind="text"]')).toBeNull();
      expect(host.querySelector('[data-host-log-kind="tool"]')).toBeNull();
    }
    await render();
    expect(host.querySelectorAll('[data-host-log-kind="text"]')).toHaveLength(3);
    expect(host.querySelector('[data-host-log-event-id="thinking"]')).not.toBeNull();
    await act(async () =>
      root.render(
        <ControlledLog log={{ ...log, sessionId: 'host-other-member', memberName: 'bob' }} />
      )
    );
    expect(host.textContent).toContain('bob');
    expect(host.querySelector('[data-host-log-event-id="b"] [data-host-log-content]')).toBeNull();
    await render();
    expect(
      host.querySelector('[data-host-log-event-id="b"] [data-host-log-content]')
    ).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
});

it('keeps equal child message identities independent and preserves their collapse on remount', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const log: HostLog = {
    ...facts,
    events: [
      {
        eventId: 'child-a-partial',
        sequence: 1,
        inputId: 'input',
        data: {
          kind: 'subagent',
          childId: 'child-a',
          parentToolRef: 'parent',
          phase: 'fact',
          fact: {
            kind: 'text',
            messageRef: 'same',
            block: 0,
            text: 'child old',
            phase: 'snapshot',
          },
        },
      },
      {
        eventId: 'child-a-final',
        sequence: 2,
        inputId: 'input',
        data: {
          kind: 'subagent',
          childId: 'child-a',
          parentToolRef: 'parent',
          phase: 'fact',
          fact: {
            kind: 'text',
            messageRef: 'same',
            block: 0,
            text: 'child A final',
            phase: 'complete',
          },
        },
      },
      {
        eventId: 'child-b-final',
        sequence: 3,
        inputId: 'input',
        data: {
          kind: 'subagent',
          childId: 'child-b',
          parentToolRef: 'parent',
          phase: 'fact',
          fact: {
            kind: 'text',
            messageRef: 'same',
            block: 0,
            text: 'child B final',
            phase: 'complete',
          },
        },
      },
    ],
  };
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.appendChild(host);
  try {
    await act(async () => root.render(<ControlledLog log={log} />));
    const childA = [...host.querySelectorAll<HTMLElement>('[role="button"]')].find((element) =>
      element.textContent?.includes('child-a')
    )!;
    await act(async () => childA.click());
    expect(host.textContent).toContain('child A final');
    expect(host.textContent).not.toContain('child old');
    expect(host.textContent).not.toContain('child B final');
    await act(async () => root.render(<ControlledLog log={log} pane="fullscreen" />));
    expect(host.textContent).toContain('child A final');
    expect(host.textContent).not.toContain('child B final');
    const childB = [...host.querySelectorAll<HTMLElement>('[role="button"]')].find((element) =>
      element.textContent?.includes('child-b')
    )!;
    await act(async () => childB.click());
    expect(host.textContent).toContain('child B final');
    expect(host.querySelectorAll('[data-host-log-kind="text"]')).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('restores the viewed anchor when the compact viewport is replaced by fullscreen', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const view: HostLogViewOptions = {
    ...createDefaultClaudeLogsSidebarUiState(),
    onViewerStateChange: (state: HostLogViewOptions['viewerState']) => {
      view.viewerState = state;
    },
  };
  function Probe() {
    const viewport = useHostLogViewport(view, facts.events);
    return (
      <div
        onScroll={viewport.onScroll}
        ref={(element) => {
          viewport.ref.current = element;
          if (!element) return;
          Object.defineProperties(element, {
            scrollHeight: { configurable: true, value: 1000 },
            clientHeight: { configurable: true, value: 200 },
          });
          element.getBoundingClientRect = () => ({ top: 100, bottom: 300 }) as DOMRect;
          element.firstElementChild!.getBoundingClientRect = () =>
            ({ top: 350 - element.scrollTop, bottom: 390 - element.scrollTop }) as DOMRect;
        }}
      >
        <div data-host-log-anchor="original-fact">Original retained fact</div>
      </div>
    );
  }
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.appendChild(host);
  try {
    await act(async () => root.render(<Probe key="compact" />));
    const compact = host.firstElementChild as HTMLDivElement;
    await act(async () => {
      compact.scrollTop = 200;
      compact.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(view.viewerState.viewport).toEqual({
      mode: 'anchor',
      anchorId: 'original-fact',
      offsetTop: 50,
    });
    await act(async () => root.render(<Probe key="fullscreen" />));
    expect((host.firstElementChild as HTMLDivElement).scrollTop).toBe(200);
    await act(async () => root.render(<Probe key="fullscreen-reopened" />));
    expect((host.firstElementChild as HTMLDivElement).scrollTop).toBe(200);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('renders captured stderr as copyable Output and applies real stream filters without hiding gaps or unmarked facts', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const stderr = {
    kind: 'process-output' as const,
    stream: 'stderr' as const,
    text: 'TEST actual stderr line',
  };
  const log: HostLog = {
    ...facts,
    events: [
      ...facts.events,
      { eventId: 'stderr-a', sequence: 5, data: stderr },
      { eventId: 'stderr-a', sequence: 5, data: stderr },
      { eventId: 'stderr-b', sequence: 6, data: stderr },
      { eventId: 'stderr-gap', sequence: 7, data: { kind: 'gap', reason: 'oversized' } },
    ],
  };
  const host = document.createElement('div'),
    root = createRoot(host);
  const copy = vi.fn().mockResolvedValue(undefined);
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  document.body.appendChild(host);
  const render = async (query = '', filter = DEFAULT_CLAUDE_LOGS_FILTER, pane = 'compact') => {
    await act(async () =>
      root.render(<ControlledLog log={log} query={query} filter={filter} pane={pane} />)
    );
  };
  try {
    await render();
    expect(host.querySelectorAll('[data-host-log-kind="process-output"]')).toHaveLength(2);
    const row = host.querySelector<HTMLElement>('[data-host-log-event-id="stderr-a"]')!;
    expect(row.dataset.hostLogStream).toBe('stderr');
    expect(row.textContent).toContain('Output');
    await act(async () => row.querySelector<HTMLElement>('[role="button"]')!.click());
    expect(row.querySelector('[data-host-log-content] p')?.textContent).toBe(stderr.text);
    await act(async () =>
      row.querySelector<HTMLButtonElement>('button[title="actions.copyToClipboard"]')!.click()
    );
    expect(copy).toHaveBeenCalledWith(stderr.text);
    await render('', DEFAULT_CLAUDE_LOGS_FILTER, 'fullscreen');
    expect(
      host.querySelector('[data-host-log-event-id="stderr-a"] [data-host-log-content] p')
        ?.textContent
    ).toBe(stderr.text);
    await render('', { streams: new Set(['stdout']), kinds: new Set(['output']) });
    expect(host.querySelector('[data-host-log-kind="process-output"]')).toBeNull();
    expect(host.textContent).toContain('actual final output');
    expect(host.textContent).toContain('oversized');
    await render('', { streams: new Set(['stderr']), kinds: new Set(['output']) });
    expect(host.querySelectorAll('[data-host-log-kind="process-output"]')).toHaveLength(2);
    expect(host.textContent).toContain('actual final output');
    await render('ACTUAL STDERR', { streams: new Set(['stderr']), kinds: new Set(['output']) });
    expect(host.querySelectorAll('[data-host-log-kind="process-output"]')).toHaveLength(2);
    expect(host.querySelector('[data-host-log-kind="text"]')).toBeNull();
    await render('', { streams: new Set(['stderr']), kinds: new Set(['tool']) });
    expect(host.querySelector('[data-host-log-kind="process-output"]')).toBeNull();
    expect(host.textContent).toContain('Read');
    await render('no matching stderr');
    expect(host.querySelector('[data-host-log-kind="process-output"]')).toBeNull();
    expect(host.textContent).toContain('retention');
    expect(host.textContent).toContain('oversized');
    await render();
    expect(host.querySelectorAll('[data-host-log-kind="process-output"]')).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
});
