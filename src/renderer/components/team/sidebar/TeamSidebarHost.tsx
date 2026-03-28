import { createContext, useContext, useId, useLayoutEffect, useState } from 'react';

import { useStore } from '@renderer/store';

import {
  removeTeamSidebarHost,
  upsertTeamSidebarHost,
  useTeamSidebarPortalSnapshot,
} from './TeamSidebarPortalManager';

import type { TeamSidebarSurface } from './TeamSidebarPortalManager';

const TeamSidebarHostContext = createContext<string | null>(null);

interface TeamSidebarHostProps {
  teamName: string;
  surface: TeamSidebarSurface;
  isActive: boolean;
  isFocused: boolean;
  children?: React.ReactNode;
}

export function useTeamSidebarHostId(): string | null {
  return useContext(TeamSidebarHostContext);
}

export const TeamSidebarHost = ({
  teamName,
  surface,
  isActive,
  isFocused,
  children,
}: TeamSidebarHostProps): React.JSX.Element => {
  const hostId = useId();
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const { messagesPanelMode, messagesPanelWidth } = useStore((s) => ({
    messagesPanelMode: s.messagesPanelMode,
    messagesPanelWidth: s.messagesPanelWidth,
  }));
  const snapshot = useTeamSidebarPortalSnapshot();
  const isVisible = messagesPanelMode === 'sidebar';
  const isOwner = isVisible && snapshot.activeHostIdByTeam[teamName] === hostId;

  useLayoutEffect(() => {
    upsertTeamSidebarHost(hostId, {
      teamName,
      surface,
      element,
      isActive,
      isFocused,
    });
    return () => {
      removeTeamSidebarHost(hostId);
    };
  }, [element, hostId, isActive, isFocused, surface, teamName]);

  return (
    <TeamSidebarHostContext.Provider value={hostId}>
      <div
        ref={setElement}
        data-team-sidebar-host={surface}
        data-team-name={teamName}
        className={`relative shrink-0 overflow-hidden ${isOwner ? 'border-r border-[var(--color-border)]' : ''}`}
        style={{
          width: isOwner ? messagesPanelWidth : 0,
          minWidth: isOwner ? messagesPanelWidth : 0,
        }}
      >
        {children}
      </div>
    </TeamSidebarHostContext.Provider>
  );
};
