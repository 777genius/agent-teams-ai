import { useId, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

import { useStore } from '@renderer/store';

import {
  getTeamSidebarHostElement,
  removeTeamSidebarSource,
  upsertTeamSidebarSource,
  useTeamSidebarPortalSnapshot,
} from './TeamSidebarPortalManager';
import { useTeamSidebarHostId } from './TeamSidebarHost';

interface TeamSidebarPortalSourceProps {
  teamName: string;
  isActive: boolean;
  isFocused: boolean;
  children: React.ReactNode;
}

export const TeamSidebarPortalSource = ({
  teamName,
  isActive,
  isFocused,
  children,
}: TeamSidebarPortalSourceProps): React.JSX.Element | null => {
  const sourceId = useId();
  const hostId = useTeamSidebarHostId();
  const messagesPanelMode = useStore((s) => s.messagesPanelMode);
  const snapshot = useTeamSidebarPortalSnapshot();

  useLayoutEffect(() => {
    upsertTeamSidebarSource(sourceId, {
      teamName,
      isActive,
      isFocused,
    });
    return () => {
      removeTeamSidebarSource(sourceId);
    };
  }, [isActive, isFocused, sourceId, teamName]);

  if (!hostId || messagesPanelMode !== 'sidebar') {
    return null;
  }

  if (snapshot.activeSourceIdByTeam[teamName] !== sourceId) {
    return null;
  }

  const activeHostId = snapshot.activeHostIdByTeam[teamName];
  if (!activeHostId) {
    return null;
  }

  if (activeHostId === hostId) {
    return <>{children}</>;
  }

  const target = getTeamSidebarHostElement(activeHostId);
  if (!target) {
    return null;
  }

  return createPortal(children, target);
};
