/* eslint-disable @typescript-eslint/naming-convention -- Component mocks mirror PascalCase exports. */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

/* eslint-enable @typescript-eslint/naming-convention -- Re-enable after component mocks. */

import { UnreadCommentsBadge } from './UnreadCommentsBadge';

async function flushReact(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('UnreadCommentsBadge', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('applies the comment pulse class only when pulseKey is positive', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(UnreadCommentsBadge, { unreadCount: 1, totalCount: 2 }));
      await flushReact();
    });

    expect(host.querySelector('.kanban-comment-badge-pulse')).toBeNull();

    await act(async () => {
      root.render(
        React.createElement(UnreadCommentsBadge, {
          unreadCount: 1,
          totalCount: 2,
          pulseKey: 1,
        })
      );
      await flushReact();
    });

    const firstPulse = host.querySelector('.kanban-comment-badge-pulse');
    expect(firstPulse).not.toBeNull();

    await act(async () => {
      root.render(
        React.createElement(UnreadCommentsBadge, {
          unreadCount: 1,
          totalCount: 2,
          pulseKey: 2,
        })
      );
      await flushReact();
    });

    expect(host.querySelector('.kanban-comment-badge-pulse')).not.toBe(firstPulse);

    await act(async () => {
      root.render(
        React.createElement(UnreadCommentsBadge, {
          unreadCount: 1,
          totalCount: 2,
          pulseKey: 0,
        })
      );
      await flushReact();
    });

    expect(host.querySelector('.kanban-comment-badge-pulse')).toBeNull();

    await act(async () => {
      root.unmount();
      await flushReact();
    });
  });

  it('can appear with a pulse after rendering no badge', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(UnreadCommentsBadge, { unreadCount: 0, totalCount: 0 }));
      await flushReact();
    });

    expect(host.querySelector('.kanban-comment-badge-pulse')).toBeNull();

    await act(async () => {
      root.render(
        React.createElement(UnreadCommentsBadge, {
          unreadCount: 1,
          totalCount: 1,
          pulseKey: 1,
        })
      );
      await flushReact();
    });

    expect(host.querySelector('.kanban-comment-badge-pulse')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await flushReact();
    });
  });
});
