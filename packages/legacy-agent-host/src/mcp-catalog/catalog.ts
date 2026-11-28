import type { TeamMemberMcpPolicy, TeamMemberMcpScope } from './memberPolicy.js';
import { resolveTeamMemberMcpScopes } from './memberPolicy.js';

export interface ConfiguredMcpServer {
  name: string;
  scope: TeamMemberMcpScope;
  config: Record<string, unknown>;
}

/** Exact existing Desktop object-entry parser; metadata projection remains in Desktop. */
export function readConfiguredMcpServers(
  value: unknown,
  scope: TeamMemberMcpScope
): ConfiguredMcpServer[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value)
    .filter((entry): entry is [string, Record<string, unknown>] => {
      const [, config] = entry;
      return Boolean(config && typeof config === 'object' && !Array.isArray(config));
    })
    .map(([name, config]) => ({ name, scope, config: { ...config } }));
}

/** Exact scope precedence and case-insensitive allowlist; original server keys stay intact. */
export function selectMcpCatalog(
  entries: readonly ConfiguredMcpServer[],
  policy: TeamMemberMcpPolicy | undefined,
  reservedNames: readonly string[] = ['agent-teams']
): Record<string, Record<string, unknown>> {
  const selected: Record<string, Record<string, unknown>> = Object.create(null);
  if (policy?.mode === 'appOnly') return selected;
  const allowlist =
    policy?.mode === 'strictAllowlist'
      ? new Set((policy.serverNames ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean))
      : undefined;
  const reserved = new Set(reservedNames.map((name) => name.toLowerCase()));
  const scopes = resolveTeamMemberMcpScopes(policy);
  for (const scope of ['user', 'project', 'local'] as const) {
    if (!scopes[scope]) continue;
    for (const entry of entries) {
      if (entry.scope !== scope || reserved.has(entry.name.toLowerCase())) continue;
      if (!allowlist || allowlist.has(entry.name.toLowerCase()))
        selected[entry.name] = { ...entry.config };
    }
  }
  return selected;
}
