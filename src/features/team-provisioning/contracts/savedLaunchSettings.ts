/** Saved launch authority, excluding presentation and timestamps. Browser-safe. */
export function fingerprintSavedLaunchSettings(value: object | null): string {
  const source = value as Record<string, unknown> | null;
  const keys = [
    'cwd',
    'prompt',
    'providerId',
    'providerBackendId',
    'model',
    'effort',
    'fastMode',
    'syncModelsWithLead',
    'skipPermissions',
    'worktree',
    'extraCliArgs',
    'limitContext',
    'launchIdentity',
  ];
  const stable = (value: unknown): unknown => {
    if (value == null) return null;
    if (Array.isArray(value)) return value.map(stable);
    if (typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)])
    );
  };
  return JSON.stringify(source ? keys.map((key) => [key, stable(source[key])]) : null);
}
