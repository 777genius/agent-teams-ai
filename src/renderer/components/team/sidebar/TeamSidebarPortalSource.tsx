import { useId, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

import { useStore } from '@renderer/store';

import { useTeamSidebarHostId } from './TeamSidebarHost';
import {
  getTeamSidebarHostElement,
  removeTeamSidebarSource,
  upsertTeamSidebarSource,
  useTeamSidebarPortalSnapshot,
} from './TeamSidebarPortalManager';

interface TeamSidebarPortalSourceProps {
  teamName: string;
  isActive: boolean;
  isFocused: boolean;
  onNativeOwnershipChange?: (ownsNativeSidebar: boolean) => void;
  children: React.ReactNode;
}

export const TeamSidebarPortalSource = ({
  teamName,
  isActive,
  isFocused,
  onNativeOwnershipChange,
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

  const ownsNativeSidebar =
    messagesPanelMode === 'sidebar' &&
    snapshot.activeSourceIdByTeam[teamName] === sourceId &&
    snapshot.activeHostIdByTeam[teamName] === hostId;

  useLayoutEffect(() => {
    onNativeOwnershipChange?.(ownsNativeSidebar);
    return () => onNativeOwnershipChange?.(false);
  }, [onNativeOwnershipChange, ownsNativeSidebar]);

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
