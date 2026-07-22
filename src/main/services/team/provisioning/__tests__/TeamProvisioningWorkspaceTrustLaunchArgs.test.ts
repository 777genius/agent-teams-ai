import {
  buildCodexWorkspaceTrustSettingsArgs,
  type WorkspaceTrustLaunchArgPatch,
  type WorkspaceTrustLaunchArgTargetSurface,
} from '@features/workspace-trust/main';
import { describe, expect, it } from 'vitest';

import { buildWorkspaceTrustLaunchArgs } from '../TeamProvisioningWorkspaceTrustLaunchArgs';

import type { CrossProviderMemberArgsResult } from '../TeamProvisioningEnvBuilder';

function settingsObjects(args: string[]): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--settings' && typeof args[i + 1] === 'string') {
      output.push(JSON.parse(args[i + 1]) as Record<string, unknown>);
    }
  }
  return output;
}

function workspaceTrustOverrides(args: string[]): string[] {
  return settingsObjects(args).flatMap((settings) => {
    const codex = settings.codex;
    if (typeof codex !== 'object' || codex === null || Array.isArray(codex)) {
      return [];
    }
    const workspaceTrust = (codex as Record<string, unknown>).agent_teams_workspace_trust;
    if (
      typeof workspaceTrust !== 'object' ||
      workspaceTrust === null ||
      Array.isArray(workspaceTrust)
    ) {
      return [];
    }
    const overrides = (workspaceTrust as Record<string, unknown>).config_overrides;
    return Array.isArray(overrides)
      ? overrides.filter((value): value is string => typeof value === 'string')
      : [];
  });
}

function codexPatch(
  targetSurface: WorkspaceTrustLaunchArgTargetSurface,
  override: string
): WorkspaceTrustLaunchArgPatch {
  return {
    id: `workspace-trust:codex:${targetSurface}`,
    owner: 'workspace-trust',
    targetProvider: 'codex',
    targetSurface,
    dialect: 'claude-codex-runtime-settings',
    args: buildCodexWorkspaceTrustSettingsArgs([override]),
    dedupeKey: `workspace-trust:codex:${targetSurface}:${override}`,
    sourceWorkspaceIds: ['workspace-1'],
    reason: 'Carry app-owned Codex workspace trust overrides through sibling runtime settings.',
  };
}

function crossProviderMemberArgs(
  overrides: Partial<CrossProviderMemberArgsResult> = {}
): CrossProviderMemberArgsResult {
  return {
    args: [],
    providerArgsByProvider: new Map(),
    envPatch: {},
    usesAnthropicApiKeyHelper: false,
    ...({ anthropicApiKeyHelper: null } as const),
    ...overrides,
  };
}

describe('TeamProvisioningWorkspaceTrustLaunchArgs', () => {
  it('patches primary provider args for the launch surface', () => {
    const override = 'projects."/tmp/primary".trust_level="trusted"';

    const result = buildWorkspaceTrustLaunchArgs({
      providerArgs: ['--existing'],
      resolvedProviderId: 'codex',
      crossProviderMemberArgs: crossProviderMemberArgs(),
      workspaceTrustPatches: [codexPatch('primary_provider_args', override)],
    });

    expect(result.providerArgsForLaunch[0]).toBe('--existing');
    expect(workspaceTrustOverrides(result.providerArgsForLaunch)).toEqual([override]);
  });

  it('patches aggregate Codex cross-provider member args when Codex is present', () => {
    const override = 'projects."/tmp/cross".trust_level="trusted"';

    const result = buildWorkspaceTrustLaunchArgs({
      providerArgs: ['--primary'],
      resolvedProviderId: 'anthropic',
      crossProviderMemberArgs: crossProviderMemberArgs({
        args: ['--cross-existing'],
        providerArgsByProvider: new Map([['codex', ['--codex-provider']]]),
      }),
      workspaceTrustPatches: [codexPatch('cross_provider_member_args', override)],
    });

    expect(result.crossProviderMemberArgsForLaunch.args[0]).toBe('--cross-existing');
    expect(workspaceTrustOverrides(result.crossProviderMemberArgsForLaunch.args)).toEqual([
      override,
    ]);
  });

  it('builds the provider facts probe map with provider_facts_probe patches', () => {
    const override = 'projects."/tmp/probe".trust_level="trusted"';

    const result = buildWorkspaceTrustLaunchArgs({
      providerArgs: ['--primary'],
      resolvedProviderId: 'anthropic',
      crossProviderMemberArgs: crossProviderMemberArgs({
        providerArgsByProvider: new Map([['codex', ['--codex-provider']]]),
      }),
      workspaceTrustPatches: [codexPatch('provider_facts_probe', override)],
    });

    expect(result.providerArgsByProvider.get('anthropic')).toEqual(['--primary']);
    expect(result.providerArgsByProvider.get('codex')?.[0]).toBe('--codex-provider');
    expect(workspaceTrustOverrides(result.providerArgsByProvider.get('codex') ?? [])).toEqual([
      override,
    ]);
  });

  it('leaves cross-provider member args unchanged when no Codex provider args are present', () => {
    const crossProviderArgs = ['--gemini-provider'];

    const result = buildWorkspaceTrustLaunchArgs({
      providerArgs: ['--primary'],
      resolvedProviderId: 'anthropic',
      crossProviderMemberArgs: crossProviderMemberArgs({
        args: crossProviderArgs,
        providerArgsByProvider: new Map([['gemini', ['--gemini-provider']]]),
      }),
      workspaceTrustPatches: [
        codexPatch('cross_provider_member_args', 'projects."/tmp/no-codex".trust_level="trusted"'),
      ],
    });

    expect(result.crossProviderMemberArgsForLaunch.args).toBe(crossProviderArgs);
  });
});
