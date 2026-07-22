import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { describe, expect, it } from 'vitest';
import { afterEach, beforeEach, vi } from 'vitest';

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => React.createElement('span', null, name),
}));
vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  CompactMarkdownPreview: ({ content, className }: { content: string; className?: string }) =>
    React.createElement('div', { className }, content),
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
vi.mock('../../../../../src/renderer/components/team/activity/AnimatedHeightReveal', () => ({
  ENTRY_REVEAL_ANIMATION_MS: 220,
  ENTRY_REVEAL_EASING: 'ease',
  AnimatedHeightReveal: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));
vi.mock('../../../../../src/renderer/components/team/activity/ThoughtBodyContent', () => ({
  ThoughtBodyContent: ({ thought }: { thought: { text: string } }) =>
    React.createElement('div', null, thought.text),
}));
vi.mock('@renderer/utils/memberHelpers', () => ({
  agentAvatarUrl: () => '/avatar.png',
}));

import {
  groupTimelineItems,
  isLeadThought,
  LeadThoughtsGroupRow,
} from '../../../../../src/renderer/components/team/activity/LeadThoughtsGroup';

import type { InboxMessage } from '../../../../../src/shared/types';

function makeLeadSessionMsg(text: string, overrides?: Partial<InboxMessage>): InboxMessage {
  return {
    from: 'team-lead',
    text,
    timestamp: '2026-03-28T18:30:00.000Z',
    read: true,
    source: 'lead_session',
    ...overrides,
  };
}

describe('LeadThoughtsGroup', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('does not classify slash command results as lead thoughts', () => {
    const resultMessage: InboxMessage = {
      from: 'team-lead',
      text: 'Total cost: $1.05',
      timestamp: '2026-03-27T22:06:00.000Z',
      read: true,
      source: 'lead_session',
      messageKind: 'slash_command_result',
      commandOutput: {
        stream: 'stdout',
        commandLabel: '/cost',
      },
    };

    expect(isLeadThought(resultMessage)).toBe(false);
    expect(groupTimelineItems([resultMessage])).toEqual([
      {
        type: 'message',
        message: resultMessage,
      },
    ]);
  });

  describe('teammate-message noise filtering', () => {
    it('excludes closed <teammate-message> blocks with idle_notification from timeline', () => {
      const noise = makeLeadSessionMsg(
        '<teammate-message teammate_id="tom" color="blue"> {"type":"idle_notification","from":"tom","timestamp":"2026-03-28T18:30:49.102Z","idleReason":"available"}</teammate-message>'
      );
      expect(isLeadThought(noise)).toBe(false);
      expect(groupTimelineItems([noise])).toEqual([]);
    });

    it('excludes unclosed <teammate-message> blocks with idle_notification from timeline', () => {
      const noise = makeLeadSessionMsg(
        '<teammate-message teammate_id="tom" color="blue"> {"type":"idle_notification","from":"tom","timestamp":"2026-03-28T18:30:49.102Z","idleReason":"available"}'
      );
      expect(isLeadThought(noise)).toBe(false);
      expect(groupTimelineItems([noise])).toEqual([]);
    });

    it('excludes <teammate-message> blocks with shutdown_request from timeline', () => {
      const noise = makeLeadSessionMsg(
        '<teammate-message teammate_id="bob" color="green"> {"type":"shutdown_request"}</teammate-message>'
      );
      expect(isLeadThought(noise)).toBe(false);
      expect(groupTimelineItems([noise])).toEqual([]);
    });

    it('excludes raw idle_notification JSON from timeline', () => {
      const noise = makeLeadSessionMsg(
        '{"type":"idle_notification","from":"alice","idleReason":"available"}'
      );
      expect(isLeadThought(noise)).toBe(false);
      expect(groupTimelineItems([noise])).toEqual([]);
    });

    it('excludes Human-prefixed internal control echoes from timeline', () => {
      const leadRelayEcho =
        makeLeadSessionMsg(`Human: You have new inbox messages addressed to you (team lead "team-lead").
Process them in order (oldest first).
If action is required, delegate via task creation or SendMessage, and keep responses minimal.

Messages:
1) From: tom
   Timestamp: 2026-05-06T15:02:54.853Z
   Text:
   #f8d7235a done.`);
      const teammateEcho = makeLeadSessionMsg(
        'Human: <teammate-message teammate_id="alice">{"type":"idle_notification"}</teammate-message>'
      );
      const nativeBootstrapControlEcho =
        makeLeadSessionMsg(`Human: <agent_teams_native_bootstrap_control>
System-level bootstrap rules:
- This is a private startup context handoff.
</agent_teams_native_bootstrap_control>`);

      expect(isLeadThought(leadRelayEcho)).toBe(false);
      expect(isLeadThought(teammateEcho)).toBe(false);
      expect(isLeadThought(nativeBootstrapControlEcho)).toBe(false);
      expect(groupTimelineItems([leadRelayEcho, teammateEcho, nativeBootstrapControlEcho])).toEqual(
        []
      );
    });

    it('does not exclude noise messages with a recipient (captured SendMessage)', () => {
      const sendMsg = makeLeadSessionMsg(
        '{"type":"idle_notification","from":"tom","idleReason":"available"}',
        { to: 'alice' }
      );
      // Has a recipient, so isLeadThought returns false (line 61), but isLeadSessionNoise
      // also returns false because `to` is non-empty — message should appear in timeline.
      expect(groupTimelineItems([sendMsg])).toEqual([{ type: 'message', message: sendMsg }]);
    });

    it('does not exclude non-lead noise messages from timeline', () => {
      const inboxMsg: InboxMessage = {
        from: 'tom',
        text: '{"type":"idle_notification","from":"tom","idleReason":"available"}',
        timestamp: '2026-03-28T18:30:00.000Z',
        read: true,
        // No source — regular inbox message
      };
      expect(groupTimelineItems([inboxMsg])).toEqual([{ type: 'message', message: inboxMsg }]);
    });

    it('keeps regular lead thoughts alongside noise', () => {
      const thought = makeLeadSessionMsg('Team is ready. Distributing tasks...');
      const noise = makeLeadSessionMsg(
        '<teammate-message teammate_id="tom" color="blue"> {"type":"idle_notification","from":"tom","idleReason":"available"}</teammate-message>'
      );
      const thought2 = makeLeadSessionMsg('Assigned task #1 to bob.');

      const items = groupTimelineItems([thought, noise, thought2]);
      // Noise is excluded; both thoughts should be grouped
      expect(items.length).toBe(1);
      expect(items[0].type).toBe('lead-thoughts');
      if (items[0].type === 'lead-thoughts') {
        expect(items[0].group.thoughts).toHaveLength(2);
        expect(items[0].group.thoughts[0].text).toBe(thought.text);
        expect(items[0].group.thoughts[1].text).toBe(thought2.text);
      }
    });
  });

  it('uses a two-line clamped preview in compact header mode', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const preview =
      'Это длинный preview текста для lead thoughts, который должен занимать до двух строк в compact header, а не одну.';

    const thought = makeLeadSessionMsg(preview, {
      messageId: 'thought-1',
      leadSessionId: 'lead-session-1',
    });

    await act(async () => {
      root.render(
        React.createElement(LeadThoughtsGroupRow, {
          group: { type: 'lead-thoughts', thoughts: [thought] },
          memberColor: 'green',
          collapseMode: 'managed',
          isCollapsed: true,
          canToggleCollapse: true,
          compactHeader: true,
        })
      );
      await Promise.resolve();
    });

    const previewNode = host.querySelector('.line-clamp-2');
    expect(previewNode).not.toBeNull();
    expect(previewNode?.textContent).toBe(preview);
    expect(previewNode?.getAttribute('title')).toBeNull();
    expect(previewNode?.className).toContain('line-clamp-2');
    expect(previewNode?.className).toContain('w-full');
    expect(previewNode?.className).toContain('max-w-full');
    expect(previewNode?.className).not.toContain('min-h-8');
    expect(previewNode?.className).not.toContain('truncate');

    const accent = host.querySelector<HTMLElement>('[data-timeline-header-accent]');
    expect(accent).not.toBeNull();
    expect(accent?.className).toContain('left-0');
    expect(accent?.className).toContain('h-6');
    expect(accent?.style.backgroundColor).toBe('#22c55e');
    expect(accent?.parentElement?.className).toContain('relative');
    expect((accent?.closest('[role="button"]') as HTMLElement | null)?.style.backgroundImage).toBe(
      ''
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('uses the normalized full thought text instead of only the first line in compact header mode', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const firstLine = 'Собрать единый remediation plan.';
    const secondLine = 'Проверить remaining edge cases по graph и messages.';
    const preview = `${firstLine} ${secondLine}`;

    const thought = makeLeadSessionMsg(`${firstLine}\n${secondLine}`, {
      messageId: 'thought-2',
      leadSessionId: 'lead-session-2',
    });

    await act(async () => {
      root.render(
        React.createElement(LeadThoughtsGroupRow, {
          group: { type: 'lead-thoughts', thoughts: [thought] },
          collapseMode: 'managed',
          isCollapsed: true,
          canToggleCollapse: true,
          compactHeader: true,
        })
      );
      await Promise.resolve();
    });

    const previewNode = host.querySelector('.line-clamp-2');
    expect(previewNode).not.toBeNull();
    expect(previewNode?.textContent).toBe(preview);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('strips info_for_agent blocks from compact thoughts preview', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const visibleText = 'Собрать единый remediation plan.';

    const thought = makeLeadSessionMsg(
      `${visibleText}\n<info_for_agent>\ninternal note\n</info_for_agent>`,
      {
        messageId: 'thought-3',
        leadSessionId: 'lead-session-3',
      }
    );

    await act(async () => {
      root.render(
        React.createElement(LeadThoughtsGroupRow, {
          group: { type: 'lead-thoughts', thoughts: [thought] },
          collapseMode: 'managed',
          isCollapsed: true,
          canToggleCollapse: true,
          compactHeader: true,
        })
      );
      await Promise.resolve();
    });

    const previewNode = host.querySelector('.line-clamp-2');
    expect(previewNode).not.toBeNull();
    expect(previewNode?.textContent).toBe(visibleText);
    expect(previewNode?.textContent).not.toContain('info_for_agent');
    expect(previewNode?.textContent).not.toContain('internal note');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('uses a two-line preview in collapsed wide mode for thought groups', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const preview =
      'Делегировал alice финальную общую сводку и remediation plan по всем findings команды.';

    const thought = makeLeadSessionMsg(preview, {
      messageId: 'thought-4',
      leadSessionId: 'lead-session-4',
    });

    await act(async () => {
      root.render(
        React.createElement(LeadThoughtsGroupRow, {
          group: { type: 'lead-thoughts', thoughts: [thought] },
          collapseMode: 'managed',
          isCollapsed: true,
          canToggleCollapse: true,
          compactHeader: false,
        })
      );
      await Promise.resolve();
    });

    const previewNode = host.querySelector('.line-clamp-2');
    expect(previewNode).not.toBeNull();
    expect(previewNode?.textContent).toBe(preview);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('reuses the expanded thought markdown preprocessing for compact preview', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const thought = makeLeadSessionMsg('**Важно** проверить #task123 и ping @alice', {
      messageId: 'thought-4',
      leadSessionId: 'lead-session-4',
      taskRefs: [{ taskId: 'task123', displayId: '#task123', teamName: 'my-team' }],
    });

    await act(async () => {
      root.render(
        React.createElement(LeadThoughtsGroupRow, {
          group: { type: 'lead-thoughts', thoughts: [thought] },
          collapseMode: 'managed',
          isCollapsed: true,
          canToggleCollapse: true,
          compactHeader: true,
          memberColorMap: new Map([['alice', 'blue']]),
          teamNames: ['my-team'],
        })
      );
      await Promise.resolve();
    });

    const previewNode = host.querySelector('.line-clamp-2');
    expect(previewNode).not.toBeNull();
    expect(previewNode?.textContent).toContain('**Важно**');
    expect(previewNode?.textContent).toContain('[#task123](task://task123)');
    expect(previewNode?.textContent).toContain('mention://blue/alice');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
