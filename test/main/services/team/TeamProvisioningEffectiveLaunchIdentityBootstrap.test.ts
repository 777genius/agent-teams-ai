import {
  buildDeterministicCreateBootstrapSpec,
  buildDeterministicLaunchBootstrapSpec,
} from '@main/services/team/provisioning/TeamProvisioningBootstrapSpec';
import { buildEffectiveTeamMemberSpec } from '@main/services/team/provisioning/TeamProvisioningMemberSpecs';
import {
  buildAuthoritativeModelChecks,
  materializeConcreteLaunchRoster,
} from '@renderer/components/team/dialogs/authoritativeLaunchIdentity';
import { describe, expect, it } from 'vitest';

import type { TeamCreateRequest, TeamLaunchRequest } from '@shared/types';

const lead = {
  providerId: 'codex' as const,
  providerBackendId: 'adapter' as const,
  model: 'gpt-5',
  effort: 'high' as const,
};

function effectiveMember(
  member: TeamCreateRequest['members'][number],
  defaults: Partial<typeof lead> = lead
) {
  return buildEffectiveTeamMemberSpec(
    {
      ...member,
      runtimeSelectionProvenance: member.runtimeSelectionProvenance ?? {
        version: 1,
        providerBackendId: member.providerBackendId ? 'explicit' : 'inherited',
        model: member.model ? 'explicit' : 'inherited',
        effort: member.effort ? 'explicit' : 'inherited',
      },
    },
    defaults
  );
}

function identityTuple(member: TeamCreateRequest['members'][number]) {
  return {
    providerId: member.providerId,
    providerBackendId: member.providerBackendId,
    model: member.model,
    effort: member.effort,
  };
}

describe('effective native launch identity bootstrap boundary', () => {
  it('serializes the exact inherited same-provider tuple for native create and relaunch', () => {
    const member = effectiveMember({
      name: 'builder',
      providerId: 'codex',
      model: 'gpt-5-mini',
    });
    const createRequest: TeamCreateRequest = {
      teamName: 'identity-create',
      cwd: '/sandbox/project',
      members: [member],
      ...lead,
    };
    const launchRequest: TeamLaunchRequest = {
      teamName: 'identity-relaunch',
      cwd: '/sandbox/project',
      ...lead,
    };

    const expected = {
      name: 'builder',
      provider: 'codex',
      providerBackendId: 'adapter',
      model: 'gpt-5-mini',
      effort: 'high',
    };
    expect(
      buildDeterministicCreateBootstrapSpec('create-run', createRequest, [member]).members[0]
    ).toMatchObject(expected);
    expect(
      buildDeterministicLaunchBootstrapSpec('launch-run', launchRequest, [member]).members[0]
    ).toMatchObject(expected);
  });

  it('keeps explicit effort and isolates every lead runtime field across providers', () => {
    expect(
      identityTuple(
        effectiveMember({
          name: 'explicit',
          providerId: 'codex',
          model: 'gpt-5-mini',
          effort: 'low',
        })
      )
    ).toEqual({
      providerId: 'codex',
      providerBackendId: 'adapter',
      model: 'gpt-5-mini',
      effort: 'low',
    });

    expect(
      identityTuple(
        effectiveMember({
          name: 'cross-provider',
          providerId: 'gemini',
          providerBackendId: 'cli-sdk',
          model: 'gemini-2.5-pro',
        })
      )
    ).toEqual({
      providerId: 'gemini',
      providerBackendId: 'cli-sdk',
      model: 'gemini-2.5-pro',
      effort: undefined,
    });
  });

  it('normalizes older payload defaults and preserves effort omission', () => {
    expect(
      identityTuple(
        effectiveMember(
          { name: 'legacy', model: 'gpt-5-mini' },
          { providerId: 'codex', model: 'gpt-5' }
        )
      )
    ).toEqual({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5-mini',
      effort: undefined,
    });
  });

  it('keeps renderer proof, renderer roster, and main materializer tuples equivalent', () => {
    const draft = {
      name: 'builder',
      providerId: 'codex' as const,
      model: 'gpt-5-mini',
      runtimeSelectionProvenance: {
        version: 1 as const,
        providerBackendId: 'inherited' as const,
        model: 'explicit' as const,
        effort: 'inherited' as const,
      },
    };
    const providerStatusById = new Map([
      [
        'codex' as const,
        {
          providerId: 'codex' as const,
          resolvedBackendId: 'adapter' as const,
          selectedBackendId: 'adapter' as const,
          modelCatalog: null,
          backend: { kind: 'adapter' as const, label: 'Adapter' },
        },
      ],
    ]);
    const [rendererMember] = materializeConcreteLaunchRoster({
      members: [draft],
      leadProviderId: lead.providerId,
      leadBackendId: lead.providerBackendId,
      leadModel: lead.model,
      leadEffort: lead.effort,
      providerStatusById,
    })!;
    const mainMember = effectiveMember(draft);
    const checks = buildAuthoritativeModelChecks({
      leadProviderId: lead.providerId,
      leadBackendId: lead.providerBackendId,
      leadModel: lead.model,
      leadEffort: lead.effort,
      providerStatusById,
      members: [draft],
      resolveMember: (member) => ({ providerId: 'codex', model: member.model }),
    }).get('codex')!;

    expect(identityTuple(rendererMember)).toEqual(identityTuple(mainMember));
    expect(checks).toContainEqual(identityTuple(mainMember));
  });
});
