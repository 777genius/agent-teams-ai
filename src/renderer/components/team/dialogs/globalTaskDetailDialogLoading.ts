interface GlobalTaskDialogLoadingParams {
  teamName: string;
  taskId: string;
  selectedTeamName: string | null;
  selectedTeamDataPresent: boolean;
  selectedTeamLoading: boolean;
  selectedTeamError: string | null;
  hasTaskInMap: boolean;
}

export function hasSelectedTargetTeamData(
  targetTeamName: string,
  selectedTeamName: string | null,
  selectedDataTeamName: string | null | undefined
): boolean {
  return selectedTeamName === targetTeamName && selectedDataTeamName === targetTeamName;
}

export function shouldKeepGlobalTaskDialogLoading({
  teamName,
  taskId,
  selectedTeamName,
  selectedTeamDataPresent,
  selectedTeamLoading,
  selectedTeamError,
  hasTaskInMap,
}: GlobalTaskDialogLoadingParams): boolean {
  if (!teamName || !taskId) return false;
  if (selectedTeamName !== teamName) return true;
  if (selectedTeamLoading && !selectedTeamDataPresent) return true;
  if (selectedTeamDataPresent) return false;
  if (selectedTeamError) return false;
  return !hasTaskInMap;
}
