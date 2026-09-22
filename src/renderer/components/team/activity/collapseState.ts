export interface DefaultActivityCollapseState {
  mode: 'default';
}

export interface ManagedActivityCollapseState {
  mode: 'managed';
  isCollapsed: boolean;
  canToggle: boolean;
  onToggle?: () => void;
}

export type ActivityCollapseState = DefaultActivityCollapseState | ManagedActivityCollapseState;

export interface TimelineItemLike {
  type: 'message' | 'lead-thoughts';
}

interface ResolveTimelineCollapseStateArgs {
  allCollapsed?: boolean;
  itemIndex: number;
  newestMessageIndex: number;
  isPinnedThoughtGroup: boolean;
  isExpandedOverride: boolean;
  onToggleOverride?: () => void;
}

export function isManagedCollapseState(
  collapseState: ActivityCollapseState | undefined
): collapseState is ManagedActivityCollapseState {
  return collapseState?.mode === 'managed';
}

export function findNewestMessageIndex(items: readonly TimelineItemLike[]): number {
  for (let i = 0; i < items.length; i++) {
    if (items[i]?.type === 'message') return i;
  }
  return -1;
}

export function resolveTimelineCollapseState({
  allCollapsed,
  itemIndex,
  newestMessageIndex,
  isPinnedThoughtGroup,
  isExpandedOverride,
  onToggleOverride,
}: ResolveTimelineCollapseStateArgs): ActivityCollapseState {
  if (!allCollapsed) {
    return { mode: 'default' };
  }

  if (isPinnedThoughtGroup || itemIndex === newestMessageIndex) {
    return {
      mode: 'managed',
      isCollapsed: false,
      canToggle: false,
    };
  }

  return {
    mode: 'managed',
    isCollapsed: !isExpandedOverride,
    canToggle: onToggleOverride != null,
    onToggle: onToggleOverride,
  };
}
