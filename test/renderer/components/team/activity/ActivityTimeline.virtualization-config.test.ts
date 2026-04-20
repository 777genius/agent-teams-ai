import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '@shared/types';

const useVirtualizerMock = vi.fn(
  (options: Record<string, unknown>) =>
    ({
      getVirtualItems: () => [],
      getTotalSize: () => 0,
      measureElement: () => undefined,
      options,
    }) as const
);

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: Record<string, unknown>) => useVirtualizerMock(options),
}));

vi.mock('@renderer/components/team/activity/ActivityItem', () => ({
  ActivityItem: ({ message }: { message: InboxMessage }) =>
    React.createElement('div', { 'data-testid': 'activity-item' }, message.text),
  isNoiseMessage: () => false,
}));

vi.mock('@renderer/components/team/activity/AnimatedHeightReveal', () => ({
  ENTRY_REVEAL_ANIMATION_MS: 220,
  AnimatedHeightReveal: ({
    children,
    containerRef,
  }: {
    children: React.ReactNode;
    containerRef?: React.RefObject<HTMLDivElement | null>;
  }) => React.createElement('div', { ref: containerRef }, children),
}));

vi.mock('@renderer/components/team/activity/useNewItemKeys', () => ({
  useNewItemKeys: () => new Set<string>(),
}));

import { ActivityTimeline } from '@renderer/components/team/activity/ActivityTimeline';

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'alice',
    text: 'message',
    timestamp: '2026-04-20T10:00:00.000Z',
    read: true,
    source: 'inbox',
    messageId: 'message-id',
    leadSessionId: 'lead-session-1',
    ...overrides,
  };
}

describe('ActivityTimeline virtualization config', () => {
  let container: HTMLDivElement;
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useVirtualizerMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    originalResizeObserver = globalThis.ResizeObserver;
    class FakeResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });

  afterEach(() => {
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    }
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('passes the direct-path row gap into useVirtualizer when virtualization activates', async () => {
    const scrollHost = document.createElement('div');
    document.body.appendChild(scrollHost);
    const scrollRef = { current: scrollHost };
    const root = createRoot(container);
    const messages = Array.from({ length: 80 }, (_, i) =>
      makeMessage({
        messageId: `msg-${i}`,
        text: `message ${i}`,
        timestamp: new Date(Date.UTC(2026, 3, 20, 10, 0, i)).toISOString(),
        leadSessionId: `member-session-${i}`,
      })
    );

    await act(async () => {
      root.render(
        React.createElement(ActivityTimeline, {
          messages,
          teamName: 'demo-team',
          viewport: {
            scrollElementRef: scrollRef,
            observerRoot: scrollRef,
            scrollMargin: 0,
            virtualizationEnabled: true,
          },
        })
      );
    });

    const showAllButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.toLowerCase().includes('show all')
    );
    expect(showAllButton).toBeDefined();

    await act(async () => {
      showAllButton?.click();
    });

    const lastCall = useVirtualizerMock.mock.calls.at(-1)?.[0] as
      | { count?: number; gap?: number }
      | undefined;

    expect(lastCall?.count).toBeGreaterThanOrEqual(60);
    expect(lastCall?.gap).toBe(4);

    await act(async () => {
      root.unmount();
    });
    scrollHost.remove();
  });
});
