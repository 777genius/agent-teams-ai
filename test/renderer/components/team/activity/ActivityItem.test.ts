import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', isDark: true, isLight: false }),
}));
vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => React.createElement('div', null, content),
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
  TaskTooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
vi.mock('@renderer/components/ui/ExpandableContent', () => ({
  ExpandableContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));
vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));
vi.mock('@renderer/components/team/activity/ReplyQuoteBlock', () => ({
  ReplyQuoteBlock: () => null,
}));

import {
  ActivityItem,
  getCrossTeamSentMemberName,
  getCrossTeamSentTarget,
  getSystemMessageLabel,
  isNoiseMessage,
  isQualifiedExternalRecipient,
} from '@renderer/components/team/activity/ActivityItem';
import type { InboxMessage } from '@shared/types';

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

    expect(host.textContent).toContain('update');
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

  it('renders user-directed peer-summary rows as passive updates instead of pseudo messages', async () => {
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

    expect(host.textContent).toContain('update');
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
});
