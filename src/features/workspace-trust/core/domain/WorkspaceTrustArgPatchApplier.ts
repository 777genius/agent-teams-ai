import {
  buildCodexWorkspaceTrustSettingsArgs,
  readCodexWorkspaceTrustConfigOverridesFromSettings,
} from './CodexWorkspaceTrustSettings';

import type {
  WorkspaceTrustLaunchArgPatch,
  WorkspaceTrustLaunchArgTargetSurface,
  WorkspaceTrustProvider,
} from './WorkspaceTrustTypes';

export type WorkspaceTrustLaunchArgPatchSkipReason =
  | 'owner_mismatch'
  | 'provider_mismatch'
  | 'surface_mismatch'
  | 'unsupported_dialect'
  | 'empty_patch'
  | 'malformed_patch_settings';

export interface WorkspaceTrustLaunchArgPatchApplication {
  args: string[];
  appliedPatchIds: string[];
  skippedPatches: { id: string; reason: WorkspaceTrustLaunchArgPatchSkipReason }[];
  addedWorkspaceTrustOverrideCount: number;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function collectSettingsObjectsFromArgs(args: string[]): Record<string, unknown>[] {
  const settings: Record<string, unknown>[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--settings') {
      const value = args[i + 1];
      if (typeof value === 'string') {
        const parsed = parseJsonObject(value);
        if (parsed) {
          settings.push(parsed);
        }
      }
      continue;
    }
    const prefix = '--settings=';
    if (arg.startsWith(prefix)) {
      const parsed = parseJsonObject(arg.slice(prefix.length));
      if (parsed) {
        settings.push(parsed);
      }
    }
  }
  return settings;
}

function collectWorkspaceTrustOverridesFromSettingsArgs(args: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const settings of collectSettingsObjectsFromArgs(args)) {
    for (const override of readCodexWorkspaceTrustConfigOverridesFromSettings(settings)) {
      if (seen.has(override)) {
        continue;
      }
      seen.add(override);
      output.push(override);
    }
  }
  return output;
}

function collectWorkspaceTrustOverridesFromPatch(patch: WorkspaceTrustLaunchArgPatch): string[] {
  return collectWorkspaceTrustOverridesFromSettingsArgs(patch.args);
}

export function applyWorkspaceTrustLaunchArgPatches(input: {
  args: string[];
  patches: WorkspaceTrustLaunchArgPatch[];
  targetProvider: WorkspaceTrustProvider;
  targetSurface: WorkspaceTrustLaunchArgTargetSurface;
}): WorkspaceTrustLaunchArgPatchApplication {
  const skippedPatches: WorkspaceTrustLaunchArgPatchApplication['skippedPatches'] = [];
  const appliedPatchIds: string[] = [];
  const existingOverrides = collectWorkspaceTrustOverridesFromSettingsArgs(input.args);
  const outputOverrides = [...existingOverrides];
  const seenOverrides = new Set(existingOverrides);

  for (const patch of input.patches) {
    if (patch.owner !== 'workspace-trust') {
      skippedPatches.push({ id: patch.id, reason: 'owner_mismatch' });
      continue;
    }
    if (patch.targetProvider !== input.targetProvider) {
      skippedPatches.push({ id: patch.id, reason: 'provider_mismatch' });
      continue;
    }
    if (patch.targetSurface !== input.targetSurface) {
      skippedPatches.push({ id: patch.id, reason: 'surface_mismatch' });
      continue;
    }
    if (patch.dialect !== 'claude-codex-runtime-settings') {
      skippedPatches.push({ id: patch.id, reason: 'unsupported_dialect' });
      continue;
    }

    const patchOverrides = collectWorkspaceTrustOverridesFromPatch(patch);
    if (patchOverrides.length === 0) {
      skippedPatches.push({
        id: patch.id,
        reason: patch.args.length === 0 ? 'empty_patch' : 'malformed_patch_settings',
      });
      continue;
    }

    let changed = false;
    for (const override of patchOverrides) {
      if (seenOverrides.has(override)) {
        continue;
      }
      seenOverrides.add(override);
      outputOverrides.push(override);
      changed = true;
    }
    if (changed) {
      appliedPatchIds.push(patch.id);
    }
  }

  if (outputOverrides.length === existingOverrides.length) {
    return {
      args: [...input.args],
      appliedPatchIds,
      skippedPatches,
      addedWorkspaceTrustOverrideCount: 0,
    };
  }

  return {
    args: [...input.args, ...buildCodexWorkspaceTrustSettingsArgs(outputOverrides)],
    appliedPatchIds,
    skippedPatches,
    addedWorkspaceTrustOverrideCount: outputOverrides.length - existingOverrides.length,
  };
}
