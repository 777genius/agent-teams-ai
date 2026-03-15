/**
 * SortableTab - A draggable tab item used within SortableContext.
 * Wraps useSortable from @dnd-kit for tab reordering and cross-pane movement.
 */

import { useCallback, useState } from 'react';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { nameColorSet } from '@renderer/utils/projectColor';
import {
  Activity,
  Bell,
  Calendar,
  FileText,
  LayoutDashboard,
  Pin,
  Puzzle,
  Search,
  Settings,
  Users,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { TeamTabSectionNav } from './TeamTabSectionNav';

import type { Tab } from '@renderer/types/tabs';

interface SortableTabProps {
  tab: Tab;
  paneId: string;
  isActive: boolean;
  isSelected: boolean;
  onTabClick: (tabId: string, e: React.MouseEvent) => void;
  onMouseDown: (tabId: string, e: React.MouseEvent) => void;
  onContextMenu: (tabId: string, e: React.MouseEvent) => void;
  onClose: (tabId: string) => void;
  setRef: (tabId: string, el: HTMLDivElement | null) => void;
}

const TAB_ICONS = {
  dashboard: LayoutDashboard,
  notifications: Bell,
  settings: Settings,
  session: FileText,
  teams: Users,
  team: Users,
  report: Activity,
  extensions: Puzzle,
  schedules: Calendar,
} as const;

export const SortableTab = ({
  tab,
  paneId,
  isActive,
  isSelected,
  onTabClick,
  onMouseDown,
  onContextMenu,
  onClose,
  setRef,
}: SortableTabProps): React.JSX.Element => {
  const [isHovered, setIsHovered] = useState(false);
  const { isLight } = useTheme();

  const isPinned = useStore(
    useShallow((s) =>
      tab.type === 'session' && tab.sessionId ? s.pinnedSessionIds.includes(tab.sessionId) : false
    )
  );

  const teamColorSet = useStore((s) => {
    if (tab.type !== 'team' || !tab.teamName) return null;
    const team = s.teamByName[tab.teamName];
    const explicitColor =
      team?.color ??
      (s.selectedTeamName === tab.teamName ? s.selectedTeamData?.config.color : undefined);
    if (explicitColor) return getTeamColorSet(explicitColor);
    // Fallback: deterministic color derived from display name
    const displayName = team?.displayName ?? tab.label;
    return nameColorSet(displayName);
  });
  const activeBorderColor = teamColorSet?.border ?? 'var(--color-accent, #6366f1)';

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
    data: {
      type: 'tab',
      tabId: tab.id,
      paneId,
    },
  });

  const style = {
    WebkitAppRegion: 'no-drag',
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    opacity: isDragging ? 0.3 : 1,
    backgroundColor: isActive
      ? teamColorSet
        ? getThemedBadge(teamColorSet, isLight)
        : 'var(--color-surface-raised)'
      : isHovered
        ? teamColorSet
          ? getThemedBadge(teamColorSet, isLight)
          : 'var(--color-surface-overlay)'
        : teamColorSet
          ? getThemedBadge(teamColorSet, isLight)
          : 'transparent',
    color:
      isActive || isHovered
        ? 'var(--color-text)'
        : teamColorSet
          ? teamColorSet.text
          : 'var(--color-text-muted)',
    outline: isSelected ? '1px solid var(--color-border-emphasis)' : 'none',
    outlineOffset: '-1px',
    borderTop: isActive ? `1px solid ${activeBorderColor}` : '1px solid transparent',
    borderLeft: isActive ? `1px solid ${activeBorderColor}` : '1px solid transparent',
    borderRight: isActive ? `1px solid ${activeBorderColor}` : '1px solid transparent',
    borderBottom: isActive ? '1px solid var(--color-surface-raised)' : '1px solid transparent',
    borderTopLeftRadius: '8px',
    borderTopRightRadius: '8px',
    borderBottomLeftRadius: isActive ? 0 : '8px',
    borderBottomRightRadius: isActive ? 0 : '8px',
    marginBottom: isActive ? '-1px' : 0,
    position: 'relative' as const,
    zIndex: isActive ? 1 : 0,
  };

  const Icon = TAB_ICONS[tab.type];

  const handleRef = useCallback(
    (el: HTMLDivElement | null) => {
      setNodeRef(el);
      setRef(tab.id, el);
    },
    [setNodeRef, setRef, tab.id]
  );

  const isTeamTab = tab.type === 'team' && tab.teamName;

  return (
    <div
      ref={handleRef}
      // eslint-disable-next-line react/jsx-props-no-spreading -- @dnd-kit useSortable requires prop spreading
      {...attributes}
      // eslint-disable-next-line react/jsx-props-no-spreading -- @dnd-kit useSortable requires prop spreading
      {...listeners}
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
      className="group flex shrink-0 cursor-grab items-center gap-2 px-3 py-1.5"
      style={style}
      onClick={(e) => onTabClick(tab.id, e)}
      onMouseDown={(e) => onMouseDown(tab.id, e)}
      onContextMenu={(e) => onContextMenu(tab.id, e)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onTabClick(tab.id, e as unknown as React.MouseEvent);
        }
      }}
    >
      <Icon className="size-4 shrink-0" />
      {tab.fromSearch && (
        <span title="Opened from search">
          <Search className="size-3 shrink-0 text-amber-400" />
        </span>
      )}
      {isPinned && (
        <span title="Pinned session">
          <Pin className="size-3 shrink-0 text-blue-400" />
        </span>
      )}
      <span
        className={`${tab.label.length > 20 ? 'max-w-[200px] truncate' : ''} whitespace-nowrap text-sm`}
      >
        {tab.label}
      </span>
      {isTeamTab && (
        <TeamTabSectionNav
          teamName={tab.teamName!}
          onActivate={() => {
            setIsHovered(false);
            onTabClick(tab.id, {
              metaKey: false,
              ctrlKey: false,
              shiftKey: false,
            } as React.MouseEvent);
          }}
        />
      )}
      <button
        className="flex size-4 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100"
        style={{ backgroundColor: 'transparent' }}
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        title="Close tab"
      >
        <X className="size-3" />
      </button>
    </div>
  );
};

/**
 * DragOverlayTab - Semi-transparent ghost of a tab shown during drag.
 */
export const DragOverlayTab = ({ tab }: { tab: Tab }): React.JSX.Element => {
  const Icon = TAB_ICONS[tab.type];

  return (
    <div
      className="flex shrink-0 items-center gap-2 rounded-md border-2 px-3 py-1.5"
      style={{
        backgroundColor: 'var(--color-surface-raised)',
        borderColor: 'var(--color-accent, #6366f1)',
        color: 'var(--color-text)',
        opacity: 0.9,
        cursor: 'grabbing',
      }}
    >
      <Icon className="size-4 shrink-0" />
      <span
        className={`${tab.label.length > 20 ? 'max-w-[200px] truncate' : ''} whitespace-nowrap text-sm`}
      >
        {tab.label}
      </span>
    </div>
  );
};
