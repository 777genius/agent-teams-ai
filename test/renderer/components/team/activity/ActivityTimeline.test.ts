import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '@shared/types';

vi.mock('@renderer/components/team/activity/ActivityItem', () => ({
  ActivityItem: ({ message }: { message: InboxMessage }) =>
    React.createElement('div', { 'data-testid': 'activity-item' }, message.text),
  isNoiseMessage: () => false,
}));

vi.mock('@renderer/components/team/activity/AnimatedHeightReveal', () => ({
  ENTRY_REVEAL_ANIMATION_MS: 220,
  AnimatedHeightReveal: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('@renderer/components/team/activity/useNewItemKeys', () => ({
  useNewItemKeys: () => new Set<string>(),
}));

import { ActivityTimeline } from '@renderer/components/team/activity/ActivityTimeline';

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'team-lead',
    text: 'message',
    timestamp: '2026-04-18T13:00:00.000Z',
    read: true,
    source: 'inbox',
    messageId: 'message-id',
    leadSessionId: 'lead-session-1',
    ...overrides,
  };
}

describe('ActivityTimeline session separators', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('does not render New session for regular message rows even when their session ids differ', async () => {
    const root = createRoot(container);
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'member-newest',
        text: 'member newest',
        leadSessionId: 'member-session-2',
        from: 'alice',
        source: 'inbox',
      }),
      makeMessage({
        messageId: 'member-older',
        text: 'member older',
        leadSessionId: 'member-session-1',
        from: 'alice',
        source: 'inbox',
      }),
    ];

    await act(async () => {
      root.render(React.createElement(ActivityTimeline, { messages, teamName: 'demo-team' }));
    });

    expect(container.textContent).not.toContain('New session');

    await act(async () => {
      root.unmount();
    });
  });

  it('renders New session between lead thought groups from different sessions', async () => {
    const root = createRoot(container);
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'thought-newest',
        text: 'lead thought newest',
        leadSessionId: 'lead-session-2',
        from: 'team-lead',
        source: 'lead_session',
      }),
      makeMessage({
        messageId: 'regular-between',
        text: 'regular message between sessions',
        leadSessionId: 'member-session-1',
        from: 'alice',
        source: 'inbox',
      }),
      makeMessage({
        messageId: 'thought-older',
        text: 'lead thought older',
        leadSessionId: 'lead-session-1',
        from: 'team-lead',
        source: 'lead_session',
      }),
    ];

    await act(async () => {
      root.render(React.createElement(ActivityTimeline, { messages, teamName: 'demo-team' }));
    });

    expect(container.textContent).toContain('New session');

    await act(async () => {
      root.unmount();
    });
  });

  it('still renders New session when the newest thought belongs to currentLeadSessionId', async () => {
    const root = createRoot(container);
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'thought-current',
        text: 'current lead thought',
        leadSessionId: 'lead-session-current',
        from: 'team-lead',
        source: 'lead_session',
      }),
      makeMessage({
        messageId: 'thought-history',
        text: 'historical lead thought',
        leadSessionId: 'lead-session-history',
        from: 'team-lead',
        source: 'lead_session',
      }),
    ];

    await act(async () => {
      root.render(
        React.createElement(ActivityTimeline, {
          messages,
          teamName: 'demo-team',
          currentLeadSessionId: 'lead-session-current',
        })
      );
    });

    expect(container.textContent).toContain('New session');

    await act(async () => {
      root.unmount();
    });
  });

  it('renders a separator for every session transition across three lead sessions', async () => {
    const root = createRoot(container);
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'thought-s3',
        text: 'thought session 3',
        leadSessionId: 'lead-session-3',
        from: 'team-lead',
        source: 'lead_session',
      }),
      makeMessage({
        messageId: 'thought-s2',
        text: 'thought session 2',
        leadSessionId: 'lead-session-2',
        from: 'team-lead',
        source: 'lead_session',
      }),
      makeMessage({
        messageId: 'thought-s1',
        text: 'thought session 1',
        leadSessionId: 'lead-session-1',
        from: 'team-lead',
        source: 'lead_session',
      }),
    ];

    await act(async () => {
      root.render(React.createElement(ActivityTimeline, { messages, teamName: 'demo-team' }));
    });

    const matches = container.textContent?.match(/New session/g) ?? [];
    expect(matches.length).toBe(2);

    await act(async () => {
      root.unmount();
    });
  });

  it('finds the previous anchor even when many non-anchor items sit between lead thought groups', async () => {
    const root = createRoot(container);
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'thought-newest',
        text: 'newest thought',
        leadSessionId: 'lead-session-newest',
        from: 'team-lead',
        source: 'lead_session',
      }),
      ...Array.from({ length: 8 }, (_, i) =>
        makeMessage({
          messageId: `filler-${i}`,
          text: `filler message ${i}`,
          leadSessionId: `member-session-${i}`,
          from: 'alice',
          source: 'inbox',
        })
      ),
      makeMessage({
        messageId: 'thought-oldest',
        text: 'oldest thought',
        leadSessionId: 'lead-session-oldest',
        from: 'team-lead',
        source: 'lead_session',
      }),
    ];

    await act(async () => {
      root.render(React.createElement(ActivityTimeline, { messages, teamName: 'demo-team' }));
    });

    expect(container.textContent).toContain('New session');

    await act(async () => {
      root.unmount();
    });
  });

  it('does not render a separator when two consecutive lead thoughts share the same session', async () => {
    const root = createRoot(container);
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'thought-a',
        text: 'thought a',
        leadSessionId: 'lead-session-shared',
        from: 'team-lead',
        source: 'lead_session',
      }),
      makeMessage({
        messageId: 'thought-b',
        text: 'thought b',
        leadSessionId: 'lead-session-shared',
        from: 'team-lead',
        source: 'lead_session',
      }),
    ];

    await act(async () => {
      root.render(React.createElement(ActivityTimeline, { messages, teamName: 'demo-team' }));
    });

    expect(container.textContent).not.toContain('New session');

    await act(async () => {
      root.unmount();
    });
  });

  it('handles a single message list without errors or separators', async () => {
    const root = createRoot(container);
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'only',
        text: 'only message',
        leadSessionId: 'lead-session-1',
        from: 'team-lead',
        source: 'lead_session',
      }),
    ];

    await act(async () => {
      root.render(React.createElement(ActivityTimeline, { messages, teamName: 'demo-team' }));
    });

    expect(container.textContent).not.toContain('New session');
    expect(container.textContent).toContain('only message');

    await act(async () => {
      root.unmount();
    });
  });
});
