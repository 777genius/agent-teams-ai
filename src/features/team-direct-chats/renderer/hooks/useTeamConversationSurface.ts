import { useCallback, useEffect, useRef, useState } from 'react';

import { getTeamMessagesSidebarUiState } from '@renderer/components/team/sidebar/teamSidebarUiState';
import { isLeadMember } from '@shared/utils/leadDetection';

import { isLeadConversationParticipant } from '../../core/domain/belongsToConversation';
import {
  type ConversationScope,
  type ConversationSurface,
  normalizeConversationParticipant,
} from '../../core/domain/conversationScope';

const AUTO_LOAD_OLDER_PAGE_CAP = 8;
export const TEAM_DIRECT_CHAT_AUTO_OLDER_PAGE_CAP = AUTO_LOAD_OLDER_PAGE_CAP;

export interface TeamConversationSurfaceState {
  renderSurface: ConversationSurface;
  navigationSurface: ConversationSurface;
  scope: ConversationScope;
  openChat: (scope: ConversationScope) => void;
  backToList: () => void;
  threadOpenedAt: number;
}

function memberNames(members: readonly { name: string }[]): Set<string> {
  return new Set(members.map((member) => normalizeConversationParticipant(member.name)));
}

function isScopeAvailable(
  scope: ConversationScope,
  members: readonly { name: string; agentType?: unknown; role?: unknown }[]
): boolean {
  if (scope.kind === 'team-feed') {
    return true;
  }
  if (members.length === 0) {
    return true;
  }
  const participant = normalizeConversationParticipant(scope.participant);
  if (memberNames(members).has(participant)) {
    return true;
  }
  const leadNames = members.filter((member) => isLeadMember(member)).map((member) => member.name);
  return isLeadConversationParticipant(participant, leadNames);
}

export function useTeamConversationSurface(args: {
  teamName: string;
  members: readonly { name: string; agentType?: unknown; role?: unknown }[];
  position: string;
  onScopeChange?: () => void;
}): TeamConversationSurfaceState {
  const initial = getTeamMessagesSidebarUiState(args.teamName);
  const [surface, setSurface] = useState<ConversationSurface>(
    () => initial.conversationSurface ?? 'list'
  );
  const [scope, setScope] = useState<ConversationScope>(
    () => initial.conversationScope ?? { kind: 'team-feed' }
  );
  const [threadOpenedAt, setThreadOpenedAt] = useState(() =>
    (initial.conversationSurface ?? 'list') === 'thread' ? Date.now() : 0
  );
  const lastTeamRef = useRef(args.teamName);

  useEffect(() => {
    if (lastTeamRef.current !== args.teamName) {
      lastTeamRef.current = args.teamName;
      const next = getTeamMessagesSidebarUiState(args.teamName);
      const nextSurface = next.conversationSurface ?? 'list';
      const nextScope = next.conversationScope ?? { kind: 'team-feed' };
      const available = nextSurface !== 'thread' || isScopeAvailable(nextScope, args.members);
      setSurface(available ? nextSurface : 'list');
      setScope(available ? nextScope : { kind: 'team-feed' });
      setThreadOpenedAt(available && nextSurface === 'thread' ? Date.now() : 0);
      return;
    }
    if (surface === 'thread' && !isScopeAvailable(scope, args.members)) {
      setSurface('list');
      setScope({ kind: 'team-feed' });
    }
  }, [args.members, args.teamName, scope, surface]);

  const onScopeChangeRef = useRef(args.onScopeChange);
  onScopeChangeRef.current = args.onScopeChange;

  const openChat = useCallback((nextScope: ConversationScope) => {
    setScope(nextScope);
    setSurface('thread');
    setThreadOpenedAt(Date.now());
    onScopeChangeRef.current?.();
  }, []);

  const backToList = useCallback(() => {
    setSurface('list');
    setScope({ kind: 'team-feed' });
  }, []);

  const floatingComposerOnList = args.position === 'floating-composer' && surface === 'list';

  return {
    renderSurface: args.position === 'floating-composer' ? 'thread' : surface,
    navigationSurface: surface,
    scope: floatingComposerOnList ? { kind: 'team-feed' } : scope,
    openChat,
    backToList,
    threadOpenedAt,
  };
}
