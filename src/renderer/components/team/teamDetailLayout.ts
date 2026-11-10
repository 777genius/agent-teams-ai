const PINNED_ACTION_CONTAINER_GAP_PX = 12;
const PINNED_ACTION_HEADER_GAP_PX = 8;

export function resolvePinnedTeamActionTop(input: {
  containerTop: number;
  headerActionsBottom?: number;
}): number {
  const defaultTop = Math.round(input.containerTop + PINNED_ACTION_CONTAINER_GAP_PX);
  if (input.headerActionsBottom === undefined || input.headerActionsBottom <= defaultTop) {
    return defaultTop;
  }

  return Math.round(input.headerActionsBottom + PINNED_ACTION_HEADER_GAP_PX);
}
