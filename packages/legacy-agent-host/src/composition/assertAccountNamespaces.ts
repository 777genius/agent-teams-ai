import { OpenCodeManagementError } from '../adapters/providers/OpenCodeManagementHost.js';

/** One captured provider account cannot silently select different credential roots. */
export function assertAccountNamespaces(
  profiles: readonly {
    provider: string;
    accountBinding: string;
    environment: Record<string, string>;
  }[]
): void {
  const namespaces = new Map<string, string>();
  for (const profile of profiles) {
    if (!['opencode', 'codex', 'claude'].includes(profile.provider)) continue;
    const namespace = JSON.stringify(
      (profile.provider === 'claude'
        ? ['HOME', 'CLAUDE_CONFIG_DIR']
        : profile.provider === 'codex'
        ? ['HOME', 'CODEX_HOME']
        : ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
      ).map((key) => profile.environment[key])
    );
    const previous = namespaces.get(profile.provider + ':' + profile.accountBinding);
    if (previous !== undefined && previous !== namespace)
      throw new OpenCodeManagementError('invalid-profile');
    namespaces.set(profile.provider + ':' + profile.accountBinding, namespace);
  }
}
