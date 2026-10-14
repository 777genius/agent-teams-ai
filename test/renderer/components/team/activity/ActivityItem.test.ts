import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  ActivityItem,
  getCrossTeamSentMemberName,
  getCrossTeamSentTarget,
  getSystemMessageLabel,
  isNoiseMessage,
  isQualifiedExternalRecipient,
} from '@renderer/components/team/activity/ActivityItem';
import { MessageExpandDialog } from '@renderer/components/team/activity/MessageExpandDialog';
import { CreateTaskDialog } from '@renderer/components/team/dialogs/CreateTaskDialog';
import { useTeamCreateTaskDialog } from '@renderer/components/team/dialogs/useTeamCreateTaskDialog';
import { useMessagesTimelineActions } from '@renderer/components/team/messages/useMessagesTimelineActions';
import { useStore } from '@renderer/store';
import { buildReplyBlock } from '@renderer/utils/agentMessageFormatting';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CreateTaskRequest, InboxMessage } from '@shared/types';

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', isDark: true, isLight: false }),
}));
vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => React.createElement('div', null, content),
  CompactMarkdownPreview: ({ content, className }: { content: string; className?: string }) =>
    React.createElement('div', { className }, content),
}));
vi.mock('@renderer/components/common/CopyButton', () => ({
  CopyButton: () => null,
}));
vi.mock('@renderer/components/team/attachments/AttachmentDisplay', () => ({
  AttachmentDisplay: () => null,
}));
vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({
    name,
    hideAvatar,
    onClick,
  }: {
    name: string;
    hideAvatar?: boolean;
    onClick?: (name: string) => void;
  }) =>
    React.createElement(
      'span',
      {
        'data-member-avatar-hidden': String(!!hideAvatar),
        'data-member-interactive': String(!!onClick),
        onClick: onClick ? () => onClick(name) : undefined,
      },
      name
    ),
}));
vi.mock('@renderer/components/team/TaskTooltip', () => ({
  TaskTooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));
vi.mock('@renderer/components/ui/ExpandableContent', () => ({
  ExpandableContent: ({
    children,
    collapsedHeight,
    fadeLengthPercent,
  }: {
    children: React.ReactNode;
    collapsedHeight?: number;
    fadeLengthPercent?: number;
  }) =>
    React.createElement(
      'div',
      {
        'data-expandable-content': 'true',
        'data-collapsed-height': collapsedHeight,
        'data-fade-length-percent': fadeLengthPercent,
      },
      children
    ),
}));
vi.mock('@renderer/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  HoverCardContent: ({
    children,
    className,
    side,
    align,
    avoidCollisions,
    collisionPadding,
    'data-chat-toolbar-appearance': toolbarAppearance,
    'data-wide-chat-message-footer': wideFooter,
  }: {
    children: React.ReactNode;
    className?: string;
    side?: string;
    align?: string;
    avoidCollisions?: boolean;
    collisionPadding?: number;
    'data-chat-toolbar-appearance'?: string;
    'data-wide-chat-message-footer'?: string;
  }) =>
    React.createElement(
      'div',
      {
        className,
        'data-side': side,
        'data-align': align,
        'data-avoid-collisions': String(avoidCollisions),
        'data-collision-padding': collisionPadding,
        'data-chat-toolbar-appearance': toolbarAppearance,
        'data-wide-chat-message-footer': wideFooter,
      },
      children
    ),
}));
vi.mock('@renderer/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));
vi.mock('@renderer/components/team/activity/ReplyQuoteBlock', () => ({
  ReplyQuoteBlock: () => null,
}));

describe('ActivityItem compact header preview', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('uses the sidebar unread tint for a newly highlighted message', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const message: InboxMessage = {
      from: 'alice',
      text: 'A fresh message',
      timestamp: new Date('2026-04-18T16:30:00.000Z').toISOString(),
      read: false,
      source: 'inbox',
    };

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message,
          teamName: 'my-team',
          isNewMessageHighlighted: true,
        })
      );
      await Promise.resolve();
    });

    const article = host.querySelector('article');
    expect(article?.className).toContain('after:bg-blue-500');
    expect(article?.className).toContain('after:opacity-[0.05]');

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message,
          teamName: 'my-team',
          isNewMessageHighlighted: false,
        })
      );
      await Promise.resolve();
    });

    expect(article?.className).toContain('after:opacity-0');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders ordinary wide-chat continuations without repeated author chrome', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const message: InboxMessage = {
      from: 'alice',
      text: 'A compact continuation',
      timestamp: '2026-09-21T10:00:00.000Z',
      read: true,
      source: 'inbox',
      messageId: 'wide-agent-1',
    };

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message,
          teamName: 'demo',
          appearance: 'wide-chat',
          continuesPreviousAuthor: true,
          continuesNextAuthor: true,
        })
      );
    });

    const article = host.querySelector('article');
    expect(article?.dataset.messagePresentation).toBe('ordinary-agent');
    expect(article?.dataset.continuesAuthor).toBe('true');
    expect(article?.dataset.continuesNextAuthor).toBe('true');
    expect(article?.dataset.wideAgent).toBe('true');
    expect(article?.dataset.wideContent).toBeUndefined();
    expect(article?.textContent).toContain('A compact continuation');
    expect(article?.textContent).not.toContain('alice');
    const footer = host.querySelector('[data-wide-chat-message-footer="true"]');
    const toolbar = footer?.querySelector('[data-activity-message-toolbar="true"]');
    expect(footer?.querySelector('[data-wide-chat-hover-time="true"]')?.textContent).toMatch(
      /\d{2}:\d{2}/
    );
    expect(toolbar?.getAttribute('data-orientation')).toBe('horizontal');
    expect(footer?.getAttribute('data-side')).toBe('top');
    expect(footer?.getAttribute('data-align')).toBe('start');
    expect(footer?.getAttribute('data-avoid-collisions')).toBe('true');
    expect(article?.contains(toolbar ?? null)).toBe(false);
    expect(article?.querySelector('[data-wide-chat-hover-time="true"]')).toBeNull();

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message,
          teamName: 'demo',
          appearance: 'wide-chat',
          continuesPreviousAuthor: true,
          continuesNextAuthor: false,
        })
      );
    });
    expect(article?.dataset.continuesNextAuthor).toBeUndefined();
    // The final row retains the native avatar for viewport pinning. Wide-chat CSS
    // hides the repeated name while keeping that avatar in the DOM.
    expect(
      article?.querySelector('[data-chat-sender="true"] [data-member-avatar-hidden="false"]')
    ).not.toBeNull();

    await act(async () => root.unmount());
  });

  it('places the route after the sender and shows it again only when the recipient changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = async (to: string, continuesPreviousAuthor: boolean) => {
      await act(async () => {
        root.render(
          React.createElement(ActivityItem, {
            message: {
              from: 'alice',
              to,
              text: `Message to ${to}`,
              timestamp: '2026-09-21T10:00:00.000Z',
              read: true,
              source: 'inbox',
            },
            teamName: 'demo',
            memberRole: 'researcher',
            appearance: 'wide-chat',
            continuesPreviousAuthor,
          })
        );
      });
    };

    await render('oscar', false);
    const header = host.querySelector('.wide-chat-message-header');
    const sender = header?.querySelector('[data-chat-sender="true"]');
    const arrow = header?.querySelector('.lucide-move-right');
    const role = header?.querySelector('[data-chat-metadata="true"]');
    expect(header?.textContent).toContain('oscar');
    expect(sender?.nextElementSibling).toBe(arrow);
    expect(arrow?.nextElementSibling?.textContent).toBe('oscar');
    expect(arrow?.nextElementSibling?.nextElementSibling).toBe(role);

    await render('oscar', true);
    expect(host.querySelector('article')?.dataset.hasRecipientRoute).toBe('false');
    expect(host.querySelector('.lucide-move-right')).toBeNull();

    await render('bob', false);
    expect(host.querySelector('article')?.dataset.hasRecipientRoute).toBe('true');
    expect(host.querySelector('.wide-chat-message-header')?.textContent).toContain('bob');

    await act(async () => root.unmount());
  });

  it('positions actions above and right-aligned with an outgoing wide-chat bubble', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message: {
            from: 'user',
            to: 'alice',
            text: 'A short outgoing message',
            timestamp: '2026-09-21T10:00:00.000Z',
            read: true,
            source: 'user_sent',
          },
          teamName: 'demo',
          appearance: 'wide-chat',
        })
      );
    });

    const toolbar = host.querySelector('[data-wide-chat-message-footer="true"]');
    expect(toolbar?.getAttribute('data-side')).toBe('top');
    expect(toolbar?.getAttribute('data-align')).toBe('end');
    await act(async () => root.unmount());
  });

  it('widens long incoming messages and truncates wide chat content at 400px', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const message: InboxMessage = {
      from: 'alice',
      to: 'user',
      text: 'A readable long paragraph. '.repeat(30),
      timestamp: '2026-09-21T10:00:00.000Z',
      read: true,
      source: 'inbox',
      messageId: 'wide-agent-long',
    };

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message,
          teamName: 'demo',
          appearance: 'wide-chat',
        })
      );
    });

    const article = host.querySelector('article');
    const expandable = host.querySelector('[data-expandable-content="true"]');
    expect(article?.dataset.messagePresentation).toBe('ordinary-agent');
    expect(article?.dataset.wideContent).toBe('true');
    expect(expandable?.getAttribute('data-collapsed-height')).toBe('400');
    expect(expandable?.getAttribute('data-fade-length-percent')).toBe('20');

    await act(async () => root.unmount());
  });

  it('hides only the selected participant avatar in a wide direct thread', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const renderMessage = async (
      from: string,
      to: string,
      messageId: string,
      text = `${from} writes to ${to}`
    ): Promise<void> => {
      await act(async () => {
        root.render(
          React.createElement(ActivityItem, {
            message: {
              from,
              to,
              text,
              timestamp: '2026-09-21T10:00:00.000Z',
              read: true,
              source: 'inbox',
              messageId,
            } satisfies InboxMessage,
            teamName: 'demo',
            appearance: 'wide-chat',
            directParticipant: 'alice',
          })
        );
      });
    };

    await renderMessage('alice', 'user', 'direct-alice');
    expect(host.querySelector('article')?.dataset.hideDirectAvatar).toBe('true');
    expect(
      host.querySelector('[data-member-avatar-hidden]')?.getAttribute('data-member-avatar-hidden')
    ).toBe('true');

    await renderMessage('oscar', 'alice', 'direct-oscar');
    expect(host.querySelector('article')?.dataset.hideDirectAvatar).toBeUndefined();
    expect(host.querySelector('article')?.dataset.hasRecipientRoute).toBe('true');
    expect(host.querySelectorAll('.lucide-move-right')).toHaveLength(1);
    expect(
      [...host.querySelectorAll('[data-member-avatar-hidden="false"]')].map(
        (badge) => badge.textContent
      )
    ).toEqual(['oscar', 'alice']);
    expect(host.querySelector('[data-chat-sender="true"]')?.textContent).toBe('oscar');

    await renderMessage(
      'oscar',
      'alice',
      'direct-oscar-reply',
      buildReplyBlock('alice', 'Hi', 'Done')
    );
    expect(host.querySelector('article')?.dataset.hasRecipientRoute).toBe('true');
    expect(host.querySelectorAll('.lucide-move-right')).toHaveLength(1);

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message: {
            from: 'alice',
            to: 'user',
            text: 'Short direct continuation',
            timestamp: '2026-09-21T10:01:00.000Z',
            read: true,
            source: 'inbox',
            messageId: 'direct-alice-continuation',
          } satisfies InboxMessage,
          teamName: 'demo',
          appearance: 'wide-chat',
          directParticipant: 'alice',
          continuesPreviousAuthor: true,
          continuesNextAuthor: false,
        })
      );
    });
    expect(host.querySelector('[data-member-avatar-hidden]')).toBeNull();
    expect(host.querySelector('article')?.textContent).toContain('Short direct continuation');

    await act(async () => root.unmount());
  });

  it('uses a two-line clamped preview in compact mode', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const summary =
      'Делегировал alice длинную задачу с заметно более длинным описанием, чтобы превью занимало больше одной строки в компактном режиме.';

    const message: InboxMessage = {
      from: 'team-lead',
      text: summary,
      summary,
      timestamp: new Date('2026-04-18T16:30:00.000Z').toISOString(),
      read: true,
      source: 'lead_process',
    };

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message,
          teamName: 'my-team',
          memberColor: 'green',
          compactHeader: true,
          collapseMode: 'managed',
          isCollapsed: true,
          canToggleCollapse: true,
          collapseToggleKey: 'message-key',
        })
      );
      await Promise.resolve();
    });

    const preview = host.querySelector('.line-clamp-2');
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toBe(summary);
    expect(preview?.getAttribute('title')).toBeNull();
    expect(preview?.className).toContain('line-clamp-2');
    expect(preview?.className).toContain('w-full');
    expect(preview?.className).toContain('max-w-full');
    expect(preview?.className).not.toContain('min-h-8');
    expect(preview?.className).not.toContain('truncate');

    const accent = host.querySelector<HTMLElement>('[data-timeline-header-accent]');
    expect(accent).not.toBeNull();
    expect(accent?.className).toContain('left-0');
    expect(accent?.className).toContain('h-6');
    expect(accent?.style.backgroundColor).toBe('#22c55e');
    expect(accent?.parentElement?.className).toContain('relative');
    expect((accent?.parentElement as HTMLElement | null)?.style.backgroundImage).toBe('');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows edit message action only when revision is enabled', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRevise = vi.fn();
    const message: InboxMessage = {
      from: 'user',
      to: 'alice',
      text: 'incomplete',
      summary: 'incomplete',
      timestamp: new Date('2026-04-18T16:30:00.000Z').toISOString(),
      read: true,
      source: 'user_sent',
      messageId: 'msg-1',
    };

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message,
          teamName: 'my-team',
          canRevise: true,
          onRevise,
        })
      );
      await Promise.resolve();
    });

    const editButton = host.querySelector('button[aria-label="Edit message"]');
    expect(editButton).not.toBeNull();

    await act(async () => {
      (editButton as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(onRevise).toHaveBeenCalledWith(message);

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message,
          teamName: 'my-team',
          canRevise: false,
          onRevise,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('button[aria-label="Edit message"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders message actions in a right-side toolbar instead of overlaying the body', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const message: InboxMessage = {
      from: 'alice',
      text: 'Codex second cycle writes the marker',
      timestamp: new Date('2026-04-18T16:30:00.000Z').toISOString(),
      read: true,
      source: 'inbox',
    };

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message,
          teamName: 'my-team',
          onReply: vi.fn(),
          onCreateTask: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const article = host.querySelector('article');
    const toolbar = host.querySelector('[data-activity-message-toolbar="true"]');
    const toolbarHost = toolbar?.closest('[data-side]');

    expect(article).not.toBeNull();
    expect(toolbar).not.toBeNull();
    expect(article?.contains(toolbar)).toBe(false);
    expect(toolbarHost?.getAttribute('data-side')).toBe('right');
    expect(toolbarHost?.getAttribute('data-avoid-collisions')).toBe('false');
    expect(toolbarHost?.className).toContain('activity-message-toolbar');
    expect(toolbar?.className).not.toContain('absolute');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders the right-side hover toolbar for collapsed older messages', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const message: InboxMessage = {
      from: 'oscar',
      text: 'agent-teams_task_create { "teamName": "local-7b-teammate-20260918" }',
      timestamp: new Date('2026-04-18T16:29:00.000Z').toISOString(),
      read: true,
      source: 'inbox',
    };

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message,
          teamName: 'my-team',
          collapseMode: 'managed',
          isCollapsed: true,
          compactHeader: true,
          onReply: vi.fn(),
          onCreateTask: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const toolbar = host.querySelector('[data-activity-message-toolbar="true"]');
    const toolbarHost = toolbar?.closest('[data-side]');

    expect(toolbar).not.toBeNull();
    expect(toolbarHost?.getAttribute('data-side')).toBe('right');
    expect(toolbarHost?.getAttribute('data-avoid-collisions')).toBe('false');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('prefers full message text over a pre-truncated summary in compact mode', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const fullText =
      'Делегировал bob ещё один узкий шаг: собрать fix-batch с учётом landing P0 по render->generate и пройтись по оставшимся edge cases.';

    const message: InboxMessage = {
      from: 'team-lead',
      text: fullText,
      summary: 'Делегировал bob ещё один узкий шаг: собрать fix-batch с у...',
      timestamp: new Date('2026-04-18T16:29:00.000Z').toISOString(),
      read: true,
      source: 'lead_process',
    };

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message,
          teamName: 'my-team',
          compactHeader: true,
          collapseMode: 'managed',
          isCollapsed: true,
          canToggleCollapse: true,
          collapseToggleKey: 'message-key-full-text',
        })
      );
      await Promise.resolve();
    });

    const preview = host.querySelector('.line-clamp-2');
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toBe(fullText);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('strips info_for_agent blocks from compact preview text', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const visibleText = 'New task assigned to you: #3fd70e2 Собрать fix-batch';
    const message: InboxMessage = {
      from: 'team-lead',
      text: `${visibleText}\n<info_for_agent>\ninternal only\n</info_for_agent>`,
      timestamp: new Date('2026-04-18T16:28:00.000Z').toISOString(),
      read: true,
      source: 'lead_process',
    };

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message,
          teamName: 'my-team',
          compactHeader: true,
          collapseMode: 'managed',
          isCollapsed: true,
          canToggleCollapse: true,
          collapseToggleKey: 'message-key-strip-agent-block',
        })
      );
      await Promise.resolve();
    });

    const preview = host.querySelector('.line-clamp-2');
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain('**New task assigned to you:**');
    expect(preview?.textContent).toContain('[#3fd70e2](task://3fd70e2)');
    expect(preview?.textContent).toContain('Собрать fix-batch');
    expect(preview?.textContent).not.toContain('info_for_agent');
    expect(preview?.textContent).not.toContain('internal only');

    const directMessage: InboxMessage = {
      ...message,
      from: 'alice',
      to: 'user',
      source: 'inbox',
      text: '**Visible direct message**\n<info_for_agent>\ninternal only\n</info_for_agent>\n```info_for_agent\nlegacy internal only\n```',
    };
    for (const isCollapsed of [true, false]) {
      await act(async () => {
        root.render(
          React.createElement(ActivityItem, {
            message: directMessage,
            teamName: 'my-team',
            directParticipant: 'alice',
            compactHeader: true,
            collapseMode: 'managed',
            isCollapsed,
            canToggleCollapse: true,
            collapseToggleKey: 'message-key-strip-agent-block',
          })
        );
        await Promise.resolve();
      });
      expect(host.textContent).toContain('Visible direct message');
      expect(host.textContent).not.toContain('info_for_agent');
      expect(host.textContent).not.toContain('internal only');
    }

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('reuses markdown display content for compact preview formatting', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const markdownText = '**Важно** проверить `CurrentTaskIndicator` и #abc123';

    const message: InboxMessage = {
      from: 'team-lead',
      text: markdownText,
      timestamp: new Date('2026-04-18T16:31:00.000Z').toISOString(),
      read: true,
      source: 'lead_process',
      taskRefs: [{ taskId: 'abc123', displayId: '#abc123', teamName: 'my-team' }],
    };

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message,
          teamName: 'my-team',
          compactHeader: true,
          collapseMode: 'managed',
          isCollapsed: true,
          canToggleCollapse: true,
          collapseToggleKey: 'message-key-markdown-preview',
        })
      );
      await Promise.resolve();
    });

    const preview = host.querySelector('.line-clamp-2');
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain('**Важно**');
    expect(preview?.textContent).toContain('task://abc123');
    expect(preview?.textContent).toContain('`CurrentTaskIndicator`');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('uses a two-line preview in collapsed wide mode, not inline one-line summary', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const fullText =
      'Делегировал alice финальную общую сводку и remediation plan по всем findings команды.';

    const message: InboxMessage = {
      from: 'team-lead',
      text: fullText,
      timestamp: new Date('2026-04-18T16:30:00.000Z').toISOString(),
      read: true,
      source: 'lead_process',
    };

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message,
          teamName: 'my-team',
          compactHeader: false,
          collapseMode: 'managed',
          isCollapsed: true,
          canToggleCollapse: true,
          collapseToggleKey: 'message-key-wide-collapsed',
        })
      );
      await Promise.resolve();
    });

    const preview = host.querySelector('.line-clamp-2');
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toBe(fullText);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

describe('ActivityItem slash command rendering', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders standalone sent slash commands with command-specific styling content', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const message: InboxMessage = {
      from: 'user',
      text: '/compact keep kanban aligned',
      timestamp: new Date('2026-03-27T12:00:00.000Z').toISOString(),
      read: true,
      source: 'user_sent',
    };

    await act(async () => {
      root.render(React.createElement(ActivityItem, { message, teamName: 'my-team' }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('command');
    expect(host.textContent).toContain('/compact');
    expect(host.textContent).toContain('Compact conversation with optional focus instructions.');
    expect(host.textContent).toContain('keep kanban aligned');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders slash command results as a distinct command output row', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const message: InboxMessage = {
      from: 'team-lead',
      text: 'Model set to sonnet\nContext usage reset',
      timestamp: new Date('2026-03-27T12:01:00.000Z').toISOString(),
      read: true,
      source: 'lead_session',
      messageKind: 'slash_command_result',
      commandOutput: {
        stream: 'stdout',
        commandLabel: '/model',
      },
      summary: 'Model set to sonnet',
    };

    await act(async () => {
      root.render(React.createElement(ActivityItem, { message, teamName: 'my-team' }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('result');
    expect(host.textContent).toContain('stdout');
    expect(host.textContent).toContain('/model');
    expect(host.textContent).toContain('Model set to sonnet');
    expect(host.textContent).toContain('Context usage reset');
    expect(host.textContent).not.toContain('team-lead');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders agent error messages with the dedicated Agent Error badge', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const message: InboxMessage = {
      from: 'bob',
      to: 'team-lead',
      text: 'bob hit a mailbox turn execution error for #abc12345. API Error: Credit balance is too low',
      timestamp: new Date('2026-05-01T12:02:00.000Z').toISOString(),
      read: false,
      source: 'inbox',
      messageKind: 'agent_error',
      summary: 'Mailbox turn execution failed',
    };

    await act(async () => {
      root.render(React.createElement(ActivityItem, { message, teamName: 'my-team' }));
      await Promise.resolve();
    });

    const badgeTexts = Array.from(host.querySelectorAll('span')).map((node) =>
      node.textContent?.trim()
    );
    expect(badgeTexts).toContain('Agent Error');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

describe('ActivityItem legacy system message fallback', () => {
  it('recognizes historical assignment and review message wording', () => {
    expect(getSystemMessageLabel('New task assigned to you: #abcd1234 "Implement feature".')).toBe(
      'Task'
    );
    expect(getSystemMessageLabel('Task #abcd1234 approved by reviewer.')).toBe('Task approved');
    expect(getSystemMessageLabel('Task #abcd1234 needs fixes before approval.')).toBe(
      'Review changes requested'
    );
  });

  it('does not treat new controller-authored summaries as legacy system noise', () => {
    expect(getSystemMessageLabel('Review request for #abcd1234')).toBeNull();
    expect(getSystemMessageLabel('Approved abcd1234')).toBeNull();
    expect(getSystemMessageLabel('Fix request for abcd1234')).toBeNull();
  });

  it('does not classify dotted local teammates as external recipients', () => {
    expect(isQualifiedExternalRecipient('ops.bot', 'my-team', new Set(['ops.bot']))).toBe(false);
    expect(isQualifiedExternalRecipient('team-best.user', 'my-team', new Set(['ops.bot']))).toBe(
      true
    );
  });

  it('recognizes pseudo cross-team recipients in activity rows', () => {
    expect(getCrossTeamSentTarget('cross-team:team-best', 'my-team', new Set(['ops.bot']))).toBe(
      'team-best'
    );
    expect(getCrossTeamSentTarget('team-best.user', 'my-team', new Set(['ops.bot']))).toBe(
      'team-best'
    );
    expect(getCrossTeamSentMemberName('team-best.user')).toBe('user');
    expect(getCrossTeamSentMemberName('cross-team:team-best')).toBeNull();
  });

  it('keeps heartbeat peer summaries out of compact idle noise rendering', () => {
    expect(isNoiseMessage('{"type":"idle_notification","idleReason":"available"}')).toBe(true);
    expect(
      isNoiseMessage(
        JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        })
      )
    ).toBe(false);
  });

  it('renders peer-summary idle rows with semantic summary text instead of generic idle noise', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const message: InboxMessage = {
      from: 'alice',
      text: JSON.stringify({
        type: 'idle_notification',
        from: 'alice',
        timestamp: '2026-04-08T12:01:00.000Z',
        idleReason: 'available',
        summary: '[to bob] aligned on rollout order',
      }),
      timestamp: new Date('2026-04-08T12:01:00.000Z').toISOString(),
      read: true,
      source: 'inbox',
    };

    await act(async () => {
      root.render(React.createElement(ActivityItem, { message, teamName: 'my-team' }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('note');
    expect(host.textContent).toContain('alice');
    expect(host.textContent).toContain('bob');
    expect(host.textContent).toContain('aligned on rollout order');
    expect(host.textContent).not.toContain('[to bob]');
    expect(host.textContent).not.toContain('idle');
    expect(host.textContent).not.toContain('Idle (available)');
    expect(host.textContent).not.toContain('Raw JSON');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders user-directed peer-summary rows as passive notes instead of pseudo messages', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const message: InboxMessage = {
      from: 'alice',
      text: JSON.stringify({
        type: 'idle_notification',
        from: 'alice',
        timestamp: '2026-04-08T12:02:00.000Z',
        idleReason: 'available',
        summary: '[to user] Я здесь.',
      }),
      timestamp: new Date('2026-04-08T12:02:00.000Z').toISOString(),
      read: true,
      source: 'inbox',
    };

    await act(async () => {
      root.render(React.createElement(ActivityItem, { message, teamName: 'my-team' }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('note');
    expect(host.textContent).toContain('alice');
    expect(host.textContent).toContain('you');
    expect(host.textContent).not.toContain('user');
    expect(host.textContent).toContain('Я здесь.');
    expect(host.textContent).not.toContain('[to user]');
    expect(host.textContent).not.toContain('idle');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders task comments as comments addressed to a task, not a participant', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const message: InboxMessage = {
      from: 'jack',
      to: 'team-lead',
      text: 'Короткий отчёт по contributor/internal implementation navigation',
      summary: '#8fdd6803 Короткий отчёт по contributor/internal implementation navigation',
      timestamp: new Date('2026-04-13T13:35:00.000Z').toISOString(),
      read: true,
      source: 'inbox',
      messageKind: 'task_comment_notification',
      taskRefs: [{ taskId: 'task-1', displayId: '#8fdd6803', teamName: 'my-team' }],
    };

    await act(async () => {
      root.render(React.createElement(ActivityItem, { message, teamName: 'my-team' }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Comment');
    expect(host.textContent).toContain('jack');
    expect(host.textContent).toContain('#8fdd6803');
    expect(host.textContent).not.toContain('team-lead');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders task stall remediation as a compact automation row', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const message: InboxMessage = {
      from: 'system',
      to: 'jack',
      text: 'Task #1c24a4c4 may be stalled after a low-signal progress update.',
      summary: 'Potential stalled task',
      timestamp: new Date('2026-04-13T13:36:00.000Z').toISOString(),
      read: true,
      source: 'system_notification',
      messageKind: 'task_stall_remediation',
      messageId: 'task-stall:demo:task-a:epoch-a',
      taskRefs: [{ taskId: 'task-a', displayId: '#1c24a4c4', teamName: 'my-team' }],
    };

    await act(async () => {
      root.render(React.createElement(ActivityItem, { message, teamName: 'my-team' }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('automation');
    expect(host.textContent).toContain('stall nudge');
    expect(host.textContent).toContain('jack');
    expect(host.textContent).toContain('#1c24a4c4');
    expect(host.textContent).not.toContain('may be stalled after a low-signal progress update');
    expect(host.textContent).not.toContain('Do not send acknowledgement-only replies');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders member work sync nudges as a compact automation row', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const message: InboxMessage = {
      from: 'system',
      to: 'tom',
      text: [
        'Work sync check: you have current actionable work assigned.',
        'Required sync action: call member_work_sync_status with teamName "launchpad".',
        'Then call member_work_sync_report with reportToken.',
      ].join('\n'),
      summary: 'Work sync check',
      timestamp: new Date('2026-04-13T13:36:00.000Z').toISOString(),
      read: true,
      source: 'system_notification',
      messageKind: 'member_work_sync_nudge',
      workSyncIntent: 'agenda_sync',
      messageId: 'member-work-sync:launchpad:tom:agenda-a',
      taskRefs: [{ taskId: 'task-a', displayId: '#b63b9065', teamName: 'launchpad' }],
    };

    await act(async () => {
      root.render(React.createElement(ActivityItem, { message, teamName: 'launchpad' }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('automation');
    expect(host.textContent).toContain('work sync');
    expect(host.textContent).toContain('tom');
    expect(host.textContent).toContain('#b63b9065');
    expect(host.textContent).not.toContain('member_work_sync_status');
    expect(host.textContent).not.toContain('member_work_sync_report');
    expect(host.textContent).not.toContain('reportToken');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

describe('ActivityItem bootstrap recipient route', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  const bootstrapMessage: InboxMessage = {
    from: 'oscar',
    to: 'alice',
    text: [
      'You are alice, on team "demo".',
      'Your FIRST action: call MCP tool member_briefing',
      'Do NOT start work, claim tasks, or improvise workflow/task/process rules before member_briefing succeeds.',
      'If member_briefing fails, send',
    ].join('\n'),
    timestamp: new Date('2026-09-17T12:00:00.000Z').toISOString(),
    read: true,
    source: 'inbox',
  };

  it('shows the recipient on teammate bootstrap rows in a direct thread', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message: bootstrapMessage,
          teamName: 'demo',
          directParticipant: 'alice',
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelectorAll('.lucide-move-right')).toHaveLength(1);
    expect(host.textContent).toContain('oscar');
    expect(host.textContent).toContain('alice');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps bootstrap teammate routes visible in the lead thread', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message: bootstrapMessage,
          teamName: 'demo',
          directParticipant: 'team-lead',
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelectorAll('.lucide-move-right').length).toBeGreaterThan(0);
    expect(host.textContent).toContain('alice');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the task chip clickable in a 1:1 thread', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onTaskIdClick = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message: {
            from: 'alice',
            to: 'user',
            text: 'please review',
            timestamp: new Date('2026-09-17T12:00:00.000Z').toISOString(),
            read: false,
            source: 'inbox',
            messageKind: 'task_comment_notification',
            taskRefs: [{ taskId: 'task-abc123', displayId: '#42', teamName: 'demo' }],
          },
          teamName: 'demo',
          directParticipant: 'alice',
          onTaskIdClick,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('#42');
    expect(host.querySelectorAll('.lucide-move-right').length).toBeGreaterThan(0);
    const taskChip = Array.from(host.querySelectorAll('button')).find((button) =>
      (button.textContent ?? '').includes('#42')
    );
    expect(taskChip).toBeDefined();
    await act(async () => {
      taskChip?.click();
      await Promise.resolve();
    });
    expect(onTaskIdClick).toHaveBeenCalledWith('task-abc123');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps lead→teammate routes visible in the lead thread', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ActivityItem, {
          message: {
            from: 'lead',
            to: 'cody',
            text: 'please take this',
            timestamp: new Date('2026-09-17T12:00:00.000Z').toISOString(),
            read: false,
            source: 'inbox',
          },
          teamName: 'demo',
          directParticipant: 'team-lead',
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelectorAll('.lucide-move-right').length).toBeGreaterThan(0);
    expect(host.textContent).toContain('cody');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

// These UI primitives keep the actual message/action/dialog state boundary under test.
vi.mock('@renderer/components/ui/dialog', () => {
  const Container = ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children);
  return {
    Dialog: Container,
    DialogContent: Container,
    DialogDescription: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogFooter: Container,
  };
});
vi.mock('@renderer/services/draftStorage', () => ({
  draftStorage: {
    loadDraft: () => Promise.resolve(null),
    saveDraft: () => Promise.resolve(),
    deleteDraft: () => Promise.resolve(),
  },
}));
vi.mock('@renderer/hooks/useTaskSuggestions', () => ({
  useTaskSuggestions: () => ({ suggestions: [] }),
}));
vi.mock('@renderer/components/ui/MemberSelect', () => ({ MemberSelect: () => null }));
vi.mock('@renderer/components/ui/tiptap', () => ({
  TiptapEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) =>
    React.createElement('textarea', {
      'aria-label': 'Description',
      value: content,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
    }),
}));
vi.mock('@renderer/components/ui/MentionableTextarea', () => ({
  MentionableTextarea: ({
    value,
    onValueChange,
  }: {
    value: string;
    onValueChange: (value: string) => void;
  }) =>
    React.createElement('textarea', {
      'aria-label': 'Prompt',
      value,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        onValueChange(event.target.value),
    }),
}));
vi.mock('@renderer/components/team/dialogs/TaskGroupChatField', () => ({
  TaskGroupChatField: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (value: string | null) => void;
  }) =>
    React.createElement(
      'select',
      {
        'aria-label': 'Group',
        value: value ?? '',
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          onChange(event.target.value || null),
      },
      React.createElement('option', { value: '' }, 'None'),
      React.createElement('option', { value: 'group-a' }, 'Group A'),
      React.createElement('option', { value: 'group-b' }, 'Group B')
    ),
}));

describe('message task action and dialog ownership', () => {
  afterEach(() => {
    useStore.setState({ activeContextId: 'local' });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });
  const message: InboxMessage = {
    from: 'alice',
    text: 'Keep the original group\n<info_for_agent>\nprivate task context\n</info_for_agent>',
    summary: 'Group task',
    groupChatId: 'group-a',
    messageId: 'message-a',
    timestamp: '2026-10-10T12:00:00.000Z',
    read: true,
    source: 'inbox',
  };
  const taskAction = (host: HTMLElement) =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Create task from message"]')!;
  const createButton = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Create'
    )!;

  it('preserves source A over filter B and keeps the rejected form and command for explicit retry', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useStore.setState({ activeContextId: 'root-a' });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const submit = vi
      .fn<(request: CreateTaskRequest) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Group A is archived'))
      .mockRejectedValueOnce(new Error('Group A is archived'))
      .mockResolvedValue(undefined);
    let dialog!: ReturnType<typeof useTeamCreateTaskDialog>;
    function Boundary() {
      dialog = useTeamCreateTaskDialog('demo');
      const onSubmit = async (request: CreateTaskRequest) => {
        dialog.assertCreateTaskOriginCurrent();
        await submit(request);
        dialog.closeCreateTaskDialog();
      };
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(ActivityItem, {
          message,
          teamName: 'demo',
          onCreateTask: dialog.handleCreateTaskFromMessage,
        }),
        dialog.createTaskDialog.open && dialog.isCreateTaskOriginCurrent
          ? React.createElement(CreateTaskDialog, {
              open: true,
              teamName: 'demo',
              members: [],
              tasks: [],
              defaultSubject: dialog.createTaskDialog.defaultSubject,
              defaultDescription: dialog.createTaskDialog.defaultDescription,
              defaultGroupChatId: dialog.defaultMessageGroupChatId('group-b'),
              onClose: dialog.closeCreateTaskDialog,
              onSubmit,
            })
          : null
      );
    }
    await act(() => Promise.resolve(root.render(React.createElement(Boundary))));
    await act(() => Promise.resolve(taskAction(host).click()));
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Group"]')?.value).toBe('group-a');
    expect(host.querySelector<HTMLInputElement>('#task-subject')?.value).toBe('Group task');
    const description = host.querySelector<HTMLTextAreaElement>(
      '[aria-label="Description"]'
    )?.value;
    expect(description).toContain('Keep the original group');
    expect(description).not.toContain('info_for_agent');
    expect(description).not.toContain('private task context');
    await act(() => Promise.resolve(createButton(host).click()));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Group A is archived');
    expect(submit.mock.calls[0][0].groupChatId).toBe('group-a');
    const command = submit.mock.calls[0][0].command;
    expect(command?.commandId).toBeTruthy();
    expect(createButton(host).disabled).toBe(false);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Group"]')?.value).toBe('group-a');
    expect(host.querySelector<HTMLInputElement>('#task-subject')?.value).toBe('Group task');
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Description"]')?.value).toContain(
      'Keep the original group'
    );
    await act(() => Promise.resolve(createButton(host).click()));
    expect(submit.mock.calls[1][0].command).toEqual(command);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Group A is archived');
    await act(() => {
      const field = host.querySelector<HTMLSelectElement>('[aria-label="Group"]')!;
      field.value = '';
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return Promise.resolve();
    });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(() => Promise.resolve(createButton(host).click()));
    expect(submit.mock.calls[2][0].groupChatId).toBeUndefined();
    expect(submit.mock.calls[2][0].command).not.toEqual(command);
    expect(host.querySelector('#task-subject')).toBeNull();
    await act(() => Promise.resolve(dialog.openCreateTaskDialog('Ordinary task')));
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Group"]')?.value).toBe('group-b');
    await act(() => {
      dialog.closeCreateTaskDialog();
      return Promise.resolve();
    });
    await act(() =>
      Promise.resolve(
        dialog.handleCreateTaskFromMessage({
          subject: 'Legacy DM',
          description: 'No group',
          source: { teamName: 'demo' },
        })
      )
    );
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Group"]')?.value).toBe('');
    await act(() => Promise.resolve(root.unmount()));
  });

  it('invalidates same-team root A to B before render or a retained submit/action callback', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useStore.setState({ activeContextId: 'root-a' });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let dialog!: ReturnType<typeof useTeamCreateTaskDialog>;
    let actions!: ReturnType<typeof useMessagesTimelineActions>;
    const submit = vi.fn();
    const reply = vi.fn();
    const revise = vi.fn();
    function Boundary() {
      dialog = useTeamCreateTaskDialog('demo');
      const contextId = useStore((state) => state.activeContextId);
      const [expandedItemKey, setExpandedItemKey] = React.useState<string | null>(null);
      actions = useMessagesTimelineActions({
        contextId,
        teamName: 'demo',
        scopeKey: 'group-a',
        scope: { kind: 'group', groupChatId: 'group-a' },
        members: [],
        messages: [message],
        expandedItemKey,
        setExpandedItemKey,
        groupId: 'group-a',
        groupQuote: reply,
        onRevise: revise,
        onCreateTask: dialog.handleCreateTaskFromMessage,
      });
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(ActivityItem, {
          message,
          teamName: 'demo',
          onCreateTask: actions.createTask,
        }),
        dialog.createTaskDialog.open && dialog.isCreateTaskOriginCurrent
          ? React.createElement(
              'div',
              { role: 'dialog' },
              dialog.defaultMessageGroupChatId('group-b')
            )
          : null
      );
    }
    await act(() => Promise.resolve(root.render(React.createElement(Boundary))));
    await act(() => Promise.resolve(taskAction(host).click()));
    expect(host.querySelector('[role="dialog"]')?.textContent).toBe('group-a');
    const oldOpen = actions.createTask!;
    const oldReply = actions.reply!;
    const oldSubmit = () => {
      try {
        dialog.assertCreateTaskOriginCurrent();
        submit();
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    };
    await act(async () => {
      useStore.setState({ activeContextId: 'root-b' });
      await expect(oldSubmit()).rejects.toThrow('context has changed');
      oldOpen({
        subject: 'Old intent',
        description: '',
        source: { teamName: 'demo', groupChatId: 'group-a' },
      });
      oldReply(message);
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(dialog.createTaskDialog.defaultSubject).toBe('Group task');
    await act(() => Promise.resolve(root.unmount()));
  });

  it('retains expansion text while removing contextual actions for missing or changed owners', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const owner = { contextId: 'root-a', teamName: 'demo', scopeKey: 'group-a' };
    const create = vi.fn(),
      reply = vi.fn(),
      revise = vi.fn();
    const restart = vi.fn(),
      memberNavigate = vi.fn(),
      taskNavigate = vi.fn(),
      teamNavigate = vi.fn();
    let displayedMessage = message;
    const render = async (current = owner, live = true, open = true) => {
      await act(() =>
        Promise.resolve(
          root.render(
            React.createElement(MessageExpandDialog, {
              expandedItem: live ? { type: 'message', message: displayedMessage } : null,
              open,
              onOpenChange: vi.fn(),
              teamName: current.teamName,
              actionOwner: current,
              expandedOwner: owner,
              onCreateTaskFromMessage: create,
              onReplyToMessage: reply,
              revisionMessageId: message.messageId,
              onReviseMessage: revise,
              onRestartTeam: restart,
              onMemberClick: memberNavigate,
              onTaskIdClick: taskNavigate,
              onTeamClick: teamNavigate,
            })
          )
        )
      );
    };
    await render();
    await act(() => Promise.resolve(taskAction(host).click()));
    expect(create.mock.calls[0][0].source).toEqual({ teamName: 'demo', groupChatId: 'group-a' });
    for (const current of [
      { ...owner, contextId: 'root-b' },
      { ...owner, teamName: 'other' },
      { ...owner, scopeKey: 'group-b' },
    ]) {
      await render(current);
      expect(host.textContent).toContain('Keep the original group');
      expect(taskAction(host)).toBeNull();
      expect(host.querySelector('button[aria-label="Reply to message"]')).toBeNull();
      expect(host.querySelector('button[aria-label="Edit message"]')).toBeNull();
    }
    await render(owner, false, false);
    expect(host.textContent).toContain('Keep the original group');
    expect(taskAction(host)).toBeNull();
    expect(host.querySelector('button[aria-label="Copy to clipboard"]')).not.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(revise).not.toHaveBeenCalled();
    await act(() => Promise.resolve(root.render(null)));
    displayedMessage = {
      ...message,
      groupChatId: undefined,
      to: 'other-team',
      text: 'API Error: 401 authentication_error: token expired',
      summary: undefined,
    };
    await render();
    const restartAction = () =>
      Array.from(host.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Restart team')
      );
    expect(host.querySelector('[data-member-interactive="true"]')).not.toBeNull();
    expect(restartAction()).toBeDefined();
    await act(() => Promise.resolve(restartAction()!.click()));
    expect(restart).toHaveBeenCalledTimes(1);
    await render({ ...owner, contextId: 'root-b' });
    expect(host.textContent).toContain('authentication_error: token expired');
    expect(restartAction()).toBeUndefined();
    expect(host.querySelector('[data-member-interactive="true"]')).toBeNull();
    expect(memberNavigate).not.toHaveBeenCalled();
    expect(taskNavigate).not.toHaveBeenCalled();
    expect(teamNavigate).not.toHaveBeenCalled();
    await act(() => Promise.resolve(root.unmount()));
  });
});
