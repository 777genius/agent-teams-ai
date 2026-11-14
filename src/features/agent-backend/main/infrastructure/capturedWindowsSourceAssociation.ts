import { assertRuntimeSourceScopeAvailable, resolveRuntimeRecipe, runtimeMemberProfileSchema,
  runtimeSourceRecipeIdentity } from '@agent-teams/legacy-agent-host/owned-process';

import type { NativeProcessProfile, ResolvedLaunchSpec, RetainedRuntimeSourceSelection,
  RuntimeSourceProcessContext, RuntimeSourceProcessOrigin } from '@agent-teams/legacy-agent-host/owned-process';

export type WindowsOriginalSourceAssociation =
  | { kind: 'management'; profileId: string; configRevision: string; accountBinding: string }
  | { kind: 'member'; teamId: string; memberId: string; accountBinding: string; recipeIdentity: string }
  | { kind: 'template'; accountBinding: string; recipeIdentity: string };

/** These identities come from the original hash-bound private Host profile, not a custody request. */
export function captureWindowsSourceAssociation(kind: WindowsOriginalSourceAssociation['kind'],
  raw: Record<string, unknown>): WindowsOriginalSourceAssociation | undefined {
  const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
    value.length <= 256 && !value.includes('\0');
  if (!id(raw.accountBinding)) return;
  if (kind === 'management') return id(raw.profileId) && id(raw.configRevision)
    ? { kind, profileId: raw.profileId, configRevision: raw.configRevision, accountBinding: raw.accountBinding } : undefined;
  const parsed = runtimeMemberProfileSchema.safeParse(raw);
  if (!parsed.success) return;
  const profile = parsed.data, recipeIdentity = runtimeSourceRecipeIdentity(profile);
  return kind === 'member'
    ? { kind, teamId: profile.teamId, memberId: profile.memberId, accountBinding: profile.accountBinding, recipeIdentity }
    : { kind, accountBinding: profile.accountBinding, recipeIdentity };
}

/** Main binds the actual credential namespace to an eligible original recipe, not merely its image. */
export function matchesWindowsSourceAssociation(
  context: RuntimeSourceProcessContext,
  selected: RetainedRuntimeSourceSelection,
  original: NativeProcessProfile & { provider: 'claude' | 'codex' | 'opencode';
    association?: WindowsOriginalSourceAssociation },
  spec: ResolvedLaunchSpec,
  captured: RuntimeSourceProcessOrigin
): boolean {
  const association = original.association;
  if (!association) return false;
  const { seed, record } = selected;
  if (captured.sourceId !== record.grant.targetId || captured.revision !== record.revision) return false;
  const origin = captured.origin;
  if (association.kind === 'management') {
    if (origin.kind !== 'management' || origin.profileId !== seed.profileId || origin.configRevision !== seed.configRevision ||
        association.profileId !== seed.profileId || association.configRevision !== seed.configRevision ||
        association.accountBinding !== seed.accountBinding || spec.cwd !== original.cwd) return false;
  } else {
    if (origin.kind !== 'runtime' || origin.teamId !== origin.scope.teamId) return false;
    const capturedTeam = context.teams.filter(team => team.scope.teamId === origin.teamId);
    if (capturedTeam.length > 1 || (capturedTeam[0] &&
      (capturedTeam[0].scope.projectId !== origin.scope.projectId ||
        capturedTeam[0].scope.workspaceId !== origin.scope.workspaceId))) return false;
    try {
      assertRuntimeSourceScopeAvailable(context, record.grant, origin.scope, origin.projectPath);
      const providerId = original.provider === 'claude' ? 'anthropic' : original.provider;
      const recipe = resolveRuntimeRecipe(context.runtime, origin.teamId, origin.memberId, providerId, true);
      const exact = context.runtime?.members.some(member => member.teamId === origin.teamId &&
        member.memberId === origin.memberId && member.provider === original.provider);
      if (association.kind === 'member'
        ? !exact || association.teamId !== origin.teamId || association.memberId !== origin.memberId
        : exact) return false;
      if (association.recipeIdentity !== origin.recipeIdentity ||
          runtimeSourceRecipeIdentity(recipe) !== origin.recipeIdentity) return false;
    } catch { return false; }
  }
  const environment = new Map<string, string>();
  for (const entry of spec.environment) {
    const equals = entry.indexOf('='), key = entry.slice(0, equals).toUpperCase();
    if (equals < 1 || environment.has(key)) return false;
    environment.set(key, entry.slice(equals + 1));
  }
  const originalEnvironment = new Map(Object.entries(original.environment).map(([key, value]) => [key.toUpperCase(), value]));
  const keys = original.provider === 'claude' ? ['HOME', 'CLAUDE_CONFIG_DIR'] :
    original.provider === 'codex' ? ['HOME', 'CODEX_HOME'] :
      ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'];
  return keys.every(key => environment.get(key) === originalEnvironment.get(key));
}
