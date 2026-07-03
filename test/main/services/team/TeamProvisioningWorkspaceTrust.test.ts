import {
  applyWorkspaceTrustArgPatches,
  collectWorkspaceTrustProviders,
  createDefaultModelWorkspaceTrustProviderArgsResolver,
  toWorkspaceTrustProvider,
} from '@main/services/team/provisioning/TeamProvisioningWorkspaceTrust';
import { describe, expect, it } from 'vitest';

describe('TeamProvisioningWorkspaceTrust', () => {
  it('normalizes Anthropic to Claude and keeps provider order stable', () => {
    expect(toWorkspaceTrustProvider('anthropic')).toBe('claude');
    expect(
      collectWorkspaceTrustProviders({
        leadProviderId: 'codex',
        memberProviderIds: ['opencode', 'anthropic', 'gemini', 'codex'],
      })
    ).toEqual(['claude', 'codex', 'gemini', 'opencode']);
  });

  it('leaves args unchanged when no workspace trust patches apply', () => {
    const args = ['--model', 'gpt-5.5'];

    expect(
      applyWorkspaceTrustArgPatches({
        args,
        patches: [],
        targetProvider: 'codex',
        targetSurface: 'default_model_probe',
      })
    ).toBe(args);

    const resolver = createDefaultModelWorkspaceTrustProviderArgsResolver({
      launchArgPatches: [],
    });
    expect(
      resolver({
        providerId: 'codex',
        providerArgs: args,
        phase: 'default-model-resolution',
      })
    ).toBe(args);
  });
});
