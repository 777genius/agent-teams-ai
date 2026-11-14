import type { CapturedProcessProfile } from './CapturedProcess.js';
import type { ProviderManagementProfile } from '../../management/profile.js';

const environmentNames = new Set([
  'HOME', 'PATH', 'TMP', 'TEMP', 'TMPDIR', 'SYSTEMROOT', 'WINDIR', 'LOCALAPPDATA', 'APPDATA',
  'LANG', 'LC_ALL', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
]);

/** One shared finite version selection: no credentials, provider config, loader flags or ambient env. */
export function runtimeSourceVersionProfile(
  seed: ProviderManagementProfile,
  executable: { path: string; sha256: string }
): CapturedProcessProfile {
  return {
    provider: seed.provider,
    cwd: seed.cwd,
    executable: { ...executable },
    environment: Object.fromEntries(Object.entries(seed.environment)
      .filter(([key]) => environmentNames.has(key.toUpperCase()))),
    ...(seed.windowsBroker ? { windowsBroker: { ...seed.windowsBroker } } : {}),
  };
}
