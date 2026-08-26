import { describe, expect, it } from 'vitest';

import { fingerprintProductionLaunchRequest } from '../authorizeProductionTeamCreateRequest';

describe('roster launch selection fingerprint', () => {
  it('distinguishes default and explicit intent for an identical visible tuple', () => {
    const request = {
      teamName: 'fake-team',
      cwd: '/fake/project',
      providerId: 'codex' as const,
      providerBackendId: 'api' as const,
      model: 'gpt-5',
      effort: 'high' as const,
    };
    const provenance = (kind: 'default' | 'explicit') => ({
      version: 1 as const,
      providerBackendId: kind,
      model: kind,
      effort: kind,
    });
    const fingerprint = (kind: 'default' | 'explicit') =>
      fingerprintProductionLaunchRequest(
        { ...request, leadRuntimeSelectionProvenance: provenance(kind) },
        []
      );

    expect(fingerprint('default')).not.toBe(fingerprint('explicit'));
  });
});
