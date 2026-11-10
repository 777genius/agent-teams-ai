/**
 * One-time localStorage migration for the launch dialog: the legacy unscoped
 * team model key moves to the anthropic-scoped key, and schedule-namespace
 * keys move to the team namespace.
 */
export function migrateLegacyLaunchDialogStorage(): void {
  const legacyTeamModel = localStorage.getItem('team:lastSelectedModel');
  if (legacyTeamModel != null && localStorage.getItem('team:lastSelectedModel:anthropic') == null) {
    localStorage.setItem('team:lastSelectedModel:anthropic', legacyTeamModel);
  }
  localStorage.removeItem('team:lastSelectedModel');

  for (const suffix of ['lastSelectedModel', 'lastSelectedEffort']) {
    const schedKey = `schedule:${suffix}`;
    const teamKey =
      suffix === 'lastSelectedModel' ? 'team:lastSelectedModel:anthropic' : `team:${suffix}`;
    const schedVal = localStorage.getItem(schedKey);
    if (schedVal != null && localStorage.getItem(teamKey) == null) {
      localStorage.setItem(teamKey, schedVal);
    }
    localStorage.removeItem(schedKey);
  }
}
