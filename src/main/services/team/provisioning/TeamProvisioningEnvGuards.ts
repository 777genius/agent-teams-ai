const CLAUDE_TEAM_RUNTIME_SETTINGS_PATH_ENV = 'CLAUDE_TEAM_RUNTIME_SETTINGS_PATH';

/**
 * Throws when deterministic team bootstrap has been disabled, either by the app
 * rollout flag or the runtime kill switch.
 */
export function assertAppDeterministicBootstrapEnabled(): void {
  if (process.env.CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP === '1') {
    throw new Error(
      'Deterministic team bootstrap is disabled by the app rollout flag (CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP=1).'
    );
  }
  if (process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP === '1') {
    throw new Error(
      'Deterministic team bootstrap is disabled by the runtime kill switch (CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP=1).'
    );
  }
}

/**
 * Sets or clears the app-managed runtime settings path on the given env object.
 */
export function applyAppManagedRuntimeSettingsPathEnv(
  env: NodeJS.ProcessEnv,
  settingsPath: string | null
): void {
  if (settingsPath) {
    env[CLAUDE_TEAM_RUNTIME_SETTINGS_PATH_ENV] = settingsPath;
  } else {
    delete env[CLAUDE_TEAM_RUNTIME_SETTINGS_PATH_ENV];
  }
}
