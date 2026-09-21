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
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '@shared/types';

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
  MemberBadge: ({ name }: { name: string }) => React.createElement('span', null, name),
}));
vi.mock('@renderer/components/team/TaskTooltip', () => ({
  TaskTooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));
vi.mock('@renderer/components/ui/ExpandableContent', () => ({
  ExpandableContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
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
    avoidCollisions,
    collisionPadding,
    'data-chat-toolbar-appearance': toolbarAppearance,
    'data-wide-chat-message-footer': wideFooter,
  }: {
    children: React.ReactNode;
    className?: string;
    side?: string;
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
        })
      );
    });

    const article = host.querySelector('article');
    expect(article?.dataset.messagePresentation).toBe('ordinary-agent');
    expect(article?.dataset.continuesAuthor).toBe('true');
    expect(article?.dataset.wideAgent).toBe('true');
    expect(article?.textContent).toContain('A compact continuation');
    expect(article?.textContent).not.toContain('alice');
    const footer = host.querySelector('[data-wide-chat-message-footer="true"]');
    const toolbar = footer?.querySelector('[data-activity-message-toolbar="true"]');
    expect(footer?.querySelector('[data-wide-chat-timestamp="true"]')?.textContent).toMatch(
      /\d{2}:\d{2}/
    );
    expect(toolbar?.getAttribute('data-orientation')).toBe('horizontal');
    expect(footer?.getAttribute('data-side')).toBe('bottom');
    expect(footer?.getAttribute('data-avoid-collisions')).toBe('true');
    expect(article?.contains(toolbar ?? null)).toBe(false);

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
    expect(host.textContent).toContain('user');
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

  it('hides from→to on bootstrap start rows in a 1:1 thread', async () => {
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

    expect(host.querySelectorAll('.lucide-move-right')).toHaveLength(0);
    expect(host.textContent).toContain('oscar');

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
