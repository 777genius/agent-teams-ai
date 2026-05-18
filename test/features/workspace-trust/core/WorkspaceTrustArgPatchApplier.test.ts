import { describe, expect, it } from 'vitest';

import {
  applyWorkspaceTrustLaunchArgPatches,
  buildCodexWorkspaceTrustSettingsArgs,
  readCodexWorkspaceTrustConfigOverridesFromSettings,
  type WorkspaceTrustLaunchArgPatch,
} from '@features/workspace-trust/core/domain';

function settingsObjects(args: string[]): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--settings' && typeof args[i + 1] === 'string') {
      output.push(JSON.parse(args[i + 1]) as Record<string, unknown>);
    }
  }
  return output;
}

function patch(id: string, overrides: string[]): WorkspaceTrustLaunchArgPatch {
  return {
    id,
    owner: 'workspace-trust',
    targetProvider: 'codex',
    targetSurface: 'primary_provider_args',
    dialect: 'claude-codex-runtime-settings',
    args: buildCodexWorkspaceTrustSettingsArgs(overrides),
    dedupeKey: id,
    sourceWorkspaceIds: ['workspace-1'],
    reason: 'Codex native trust is carried through sibling runtime settings.',
  };
}

describe('WorkspaceTrustArgPatchApplier', () => {
  it('applies Codex workspace trust settings without replacing existing provider settings', () => {
    const override = 'projects."/tmp/project".trust_level="trusted"';
    const result = applyWorkspaceTrustLaunchArgPatches({
      args: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
      patches: [patch('codex-trust', [override])],
      targetProvider: 'codex',
      targetSurface: 'primary_provider_args',
    });

    expect(result.appliedPatchIds).toEqual(['codex-trust']);
    expect(result.addedWorkspaceTrustOverrideCount).toBe(1);
    expect(result.args).not.toContain('-c');
    expect(settingsObjects(result.args)[0]).toEqual({
      codex: {
        forced_login_method: 'chatgpt',
      },
    });
    expect(
      readCodexWorkspaceTrustConfigOverridesFromSettings(settingsObjects(result.args).at(-1))
    ).toEqual([override]);
  });

  it('dedupes exact app-owned override values across repeated applications', () => {
    const override = 'projects."/tmp/project".trust_level="trusted"';
    const first = applyWorkspaceTrustLaunchArgPatches({
      args: [],
      patches: [patch('codex-trust', [override])],
      targetProvider: 'codex',
      targetSurface: 'primary_provider_args',
    });
    const second = applyWorkspaceTrustLaunchArgPatches({
      args: first.args,
      patches: [patch('codex-trust', [override])],
      targetProvider: 'codex',
      targetSurface: 'primary_provider_args',
    });

    expect(first.addedWorkspaceTrustOverrideCount).toBe(1);
    expect(second.addedWorkspaceTrustOverrideCount).toBe(0);
    expect(second.args).toEqual(first.args);
  });

  it('skips wrong providers, wrong surfaces, and direct Codex native dialects', () => {
    const nativePatch: WorkspaceTrustLaunchArgPatch = {
      ...patch('native-codex', ['projects."/tmp/project".trust_level="trusted"']),
      dialect: 'codex-native-config-override',
      args: ['projects."/tmp/project".trust_level="trusted"'],
    };
    const result = applyWorkspaceTrustLaunchArgPatches({
      args: [],
      patches: [
        patch('provider-mismatch', ['projects."/tmp/a".trust_level="trusted"']),
        {
          ...patch('surface-mismatch', ['projects."/tmp/b".trust_level="trusted"']),
          targetSurface: 'provider_facts_probe',
        },
        nativePatch,
      ],
      targetProvider: 'anthropic',
      targetSurface: 'primary_provider_args',
    });

    expect(result.args).toEqual([]);
    expect(result.appliedPatchIds).toEqual([]);
    expect(result.skippedPatches.map((item) => item.reason)).toEqual([
      'provider_mismatch',
      'provider_mismatch',
      'provider_mismatch',
    ]);
  });

  it('reports non-provider skip reasons without mutating args', () => {
    const unsupportedDialectPatch: WorkspaceTrustLaunchArgPatch = {
      ...patch('unsupported-dialect', ['projects."/tmp/project".trust_level="trusted"']),
      dialect: 'codex-direct-cli-config',
      args: ['projects."/tmp/project".trust_level="trusted"'],
    };
    const result = applyWorkspaceTrustLaunchArgPatches({
      args: ['--existing'],
      patches: [
        {
          ...patch('surface-mismatch', ['projects."/tmp/surface".trust_level="trusted"']),
          targetSurface: 'default_model_probe',
        },
        unsupportedDialectPatch,
        { ...patch('empty', []), args: [] },
        { ...patch('malformed', []), args: ['--settings', '{nope'] },
      ],
      targetProvider: 'codex',
      targetSurface: 'primary_provider_args',
    });

    expect(result.args).toEqual(['--existing']);
    expect(result.appliedPatchIds).toEqual([]);
    expect(result.addedWorkspaceTrustOverrideCount).toBe(0);
    expect(result.skippedPatches).toEqual([
      { id: 'surface-mismatch', reason: 'surface_mismatch' },
      { id: 'unsupported-dialect', reason: 'unsupported_dialect' },
      { id: 'empty', reason: 'empty_patch' },
      { id: 'malformed', reason: 'malformed_patch_settings' },
    ]);
  });

  it('merges existing --settings= overrides and dedupes duplicates inside a patch', () => {
    const existing = 'projects."/tmp/already".trust_level="trusted"';
    const next = 'projects."/tmp/next".trust_level="trusted"';
    const [settingsFlag, settingsJson] = buildCodexWorkspaceTrustSettingsArgs([existing]);
    const result = applyWorkspaceTrustLaunchArgPatches({
      args: [`${settingsFlag}=${settingsJson}`],
      patches: [patch('codex-trust', [existing, next, next])],
      targetProvider: 'codex',
      targetSurface: 'primary_provider_args',
    });

    expect(result.appliedPatchIds).toEqual(['codex-trust']);
    expect(result.addedWorkspaceTrustOverrideCount).toBe(1);
    expect(
      readCodexWorkspaceTrustConfigOverridesFromSettings(settingsObjects(result.args).at(-1))
    ).toEqual([existing, next]);
  });
});
