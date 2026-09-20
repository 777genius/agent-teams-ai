import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { type ExpandedChatHost, supportsStatePreservingMove } from './MessagesThreadPlacement';

import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';

interface UseExpandedTeamChatArgs {
  teamName: string;
  messagesPanelMode: TeamMessagesPanelMode;
  isActive: boolean;
  graphOpen: boolean;
  editorOpen: boolean;
  contentRef: RefObject<HTMLDivElement | null>;
}

interface ExpandedTeamChatController {
  expanded: boolean;
  ownsNativeSidebar: boolean;
  host: ExpandedChatHost;
  collapse: () => void;
  setTarget: Dispatch<SetStateAction<HTMLDivElement | null>>;
  onNativeOwnershipChange: (ownsNativeSidebar: boolean) => void;
}

export function useExpandedTeamChat({
  teamName,
  messagesPanelMode,
  isActive,
  graphOpen,
  editorOpen,
  contentRef,
}: UseExpandedTeamChatArgs): ExpandedTeamChatController {
  const [expandedTeamName, setExpandedTeamName] = useState<string | null>(null);
  const [ownsNativeSidebar, setOwnsNativeSidebar] = useState(false);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const pendingSectionNavigationRef = useRef<HTMLElement | null>(null);
  const expanded = expandedTeamName === teamName;
  const collapse = useCallback(() => setExpandedTeamName(null), []);
  const onExpandedChange = useCallback(
    (nextExpanded: boolean): void => {
      pendingSectionNavigationRef.current = null;
      setExpandedTeamName(nextExpanded ? teamName : null);
    },
    [teamName]
  );
  const onNativeOwnershipChange = useCallback((ownsSidebar: boolean): void => {
    setOwnsNativeSidebar(ownsSidebar);
    if (!ownsSidebar) setExpandedTeamName(null);
  }, []);

  useLayoutEffect(() => {
    if (
      (expandedTeamName !== null && expandedTeamName !== teamName) ||
      messagesPanelMode !== 'sidebar' ||
      graphOpen
    ) {
      setExpandedTeamName(null);
    }
  }, [expandedTeamName, graphOpen, messagesPanelMode, teamName]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    if (editorOpen || graphOpen || expanded) {
      content.setAttribute('inert', '');
      content.setAttribute('aria-hidden', 'true');
    } else {
      content.removeAttribute('inert');
      content.removeAttribute('aria-hidden');
    }
  }, [contentRef, editorOpen, expanded, graphOpen]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const captureNavigation = (event: Event): void => {
      if (!expanded) return;
      const eventTarget = event.target;
      if (!(eventTarget instanceof HTMLElement) || !content.contains(eventTarget)) return;
      event.stopPropagation();
      pendingSectionNavigationRef.current = eventTarget;
      setExpandedTeamName(null);
    };
    content.addEventListener('team-section-navigate', captureNavigation, true);
    return () => content.removeEventListener('team-section-navigate', captureNavigation, true);
  }, [contentRef, expanded]);

  useLayoutEffect(() => {
    if (expanded) return;
    const pendingTarget = pendingSectionNavigationRef.current;
    if (!pendingTarget) return;
    pendingSectionNavigationRef.current = null;
    if (contentRef.current?.contains(pendingTarget)) {
      pendingTarget.dispatchEvent(new CustomEvent('team-section-navigate'));
    }
  }, [contentRef, expanded]);

  const host = useMemo<ExpandedChatHost>(
    () => ({
      target,
      available:
        ownsNativeSidebar &&
        isActive &&
        !graphOpen &&
        messagesPanelMode === 'sidebar' &&
        supportsStatePreservingMove(target),
      expanded,
      onExpandedChange,
    }),
    [expanded, graphOpen, isActive, messagesPanelMode, onExpandedChange, ownsNativeSidebar, target]
  );

  return { expanded, ownsNativeSidebar, host, collapse, setTarget, onNativeOwnershipChange };
}
