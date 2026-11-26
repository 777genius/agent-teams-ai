import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { requestAttentionChatNavigation } from '@features/user-attention/renderer/hooks/conversationAttentionNavigation';
import { useTeamTaskFilters } from '@renderer/components/team/kanban/useTeamTaskFilters';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KanbanFilterState } from '@renderer/components/team/kanban/KanbanFilterPopover';
import type { Session } from '@renderer/types/data';

const store = vi.hoisted(() => ({
  activeContextId: 'attention-session-context',
  groupTaskNavigation: null,
  consumeGroupTaskNavigation: vi.fn(),
}));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof store) => unknown) => selector(store),
}));
vi.mock('@features/team-group-chats/renderer', () => ({
  useTeamGroupChats: () => ({ allGroups: [], loading: false, error: null }),
}));
vi.mock('@features/user-attention/renderer', async () => ({
  useAttentionConversationNavigation: (
    await import('@features/user-attention/renderer/hooks/conversationAttentionNavigation')
  ).useAttentionConversationNavigation,
}));

const sessions: Session[] = [
  {
    id: 'historical',
    projectId: 'project',
    projectPath: '/fixture',
    createdAt: 100,
    hasSubagents: false,
    messageCount: 1,
  },
  {
    id: 'current',
    projectId: 'project',
    projectPath: '/fixture',
    createdAt: 200,
    hasSubagents: false,
    messageCount: 1,
  },
];

function SessionFilterFixture({ teamName }: { teamName: string }): React.JSX.Element {
  const [filter, setFilter] = useState<KanbanFilterState>({
    sessionId: 'historical',
    groupChatId: 'group',
    selectedOwners: new Set(['alice']),
    columns: new Set(['todo']),
  });
  const [, setSearch] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const { timeWindow } = useTeamTaskFilters(
    teamName, null, sessions, filter, setFilter, setSearch, true, contentRef, () => {}
  );
  return (
    <div ref={contentRef} data-team={teamName}>
      <span data-window>{JSON.stringify(timeWindow)}</span>
      <span data-filters>
        {JSON.stringify([filter.groupChatId, [...filter.selectedOwners], [...filter.columns]])}
      </span>
      <button type="button" onClick={() => setFilter((previous) => ({ ...previous, sessionId: 'historical' }))}>
        Select historical session
      </button>
    </div>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Attention session filter navigation', () => {
  it('clears the mounted target session window only, preserving other filters and later selection', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const target = 'attention-session-project-b';
    const other = 'attention-session-project-a';
    const scope = { kind: 'direct' as const, participant: 'alice' };
    const windowFor = (teamName: string): string | null | undefined =>
      host.querySelector(`[data-team="${teamName}"] [data-window]`)?.textContent;
    try {
      await act(async () => root.render(
        <>
          <SessionFilterFixture teamName={target} />
          <SessionFilterFixture teamName={other} />
        </>
      ));
      const historical = JSON.stringify({ start: 100, end: 200 });
      expect(windowFor(target)).toBe(historical);
      expect(windowFor(other)).toBe(historical);

      await act(async () => requestAttentionChatNavigation({
        contextId: 'different-context', teamName: target, scope,
      }));
      expect(windowFor(target)).toBe(historical);

      await act(async () => requestAttentionChatNavigation({
        contextId: store.activeContextId, teamName: target, scope,
      }));
      expect(windowFor(target)).toBe('null');
      expect(windowFor(other)).toBe(historical);
      expect(host.querySelector(`[data-team="${target}"] [data-filters]`)?.textContent)
        .toBe(JSON.stringify(['group', ['alice'], ['todo']]));

      await act(async () => {
        host.querySelector<HTMLButtonElement>(`[data-team="${target}"] button`)?.click();
      });
      expect(windowFor(target)).toBe(historical);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
