import {
  buildCodexTrustedProjectConfigOverrides,
  buildCodexWorkspaceTrustSettingsArgs,
} from './CodexWorkspaceTrustSettings';

import type {
  WorkspaceTrustFeatureFlags,
  WorkspaceTrustLaunchArgPatch,
  WorkspaceTrustLaunchArgTargetSurface,
  WorkspaceTrustProvider,
  WorkspaceTrustWorkspace,
} from './WorkspaceTrustTypes';

const DEFAULT_CODEX_TARGET_SURFACES: WorkspaceTrustLaunchArgTargetSurface[] = [
  'primary_provider_args',
  'cross_provider_member_args',
  'provider_facts_probe',
  'default_model_probe',
];

export function buildCodexTrustPatches(input: {
  providers: WorkspaceTrustProvider[];
  workspaces: WorkspaceTrustWorkspace[];
  targetSurfaces?: WorkspaceTrustLaunchArgTargetSurface[];
  featureFlags: WorkspaceTrustFeatureFlags;
}): WorkspaceTrustLaunchArgPatch[] {
  if (
    !input.featureFlags.enabled ||
    !input.featureFlags.codexArgs ||
    !input.providers.includes('codex')
  )
    return [];
  const configKeys = input.workspaces.flatMap((workspace) => [
    workspace.configKeyCwd,
    workspace.realCwd,
    ...(workspace.gitRootConfigKey ? [workspace.gitRootConfigKey] : []),
  ]);
  const overrides = buildCodexTrustedProjectConfigOverrides(configKeys);
  const args = buildCodexWorkspaceTrustSettingsArgs(overrides);
  if (args.length === 0) return [];
  return (input.targetSurfaces ?? DEFAULT_CODEX_TARGET_SURFACES).map((surface) => ({
    id: `workspace-trust:codex:${surface}`,
    owner: 'workspace-trust',
    targetProvider: 'codex',
    targetSurface: surface,
    dialect: 'claude-codex-runtime-settings',
    args,
    dedupeKey: `workspace-trust:codex:${surface}:${overrides.join('|')}`,
    sourceWorkspaceIds: input.workspaces.map((workspace) => workspace.id),
    reason: 'Carry app-owned Codex workspace trust overrides through sibling runtime settings.',
  }));
}
