import {
  authorizeProductionTeamCreateRequest,
  authorizeProductionTeamLaunchRequest,
} from '@main/ipc/teams/authorizeProductionTeamCreateRequest';
import {
  captureAuthoritativeProofEpoch,
  claimAuthoritativeModelExecutionProofInvocation,
  invalidateAuthoritativeModelExecutionProofs,
  issueAuthoritativeModelExecutionProof as issueAuthoritativeModelExecutionProofRaw,
  verifyAuthoritativeModelExecutionProof,
  verifyAuthoritativeModelExecutionProofForRequest,
} from '@main/services/team/TeamLaunchExecutionProofAuthority';
import {
  buildAuthoritativeModelChecks,
  materializeConcreteLaunchRoster,
} from '@renderer/components/team/dialogs/authoritativeLaunchIdentity';
import { buildEffectiveRuntimeRosterRevision } from '@shared/utils/effectiveMemberRuntimeIdentity';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  EffortLevel,
  TeamLaunchRequest,
  TeamMember,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

function consumeExecutionProof(
  proof: Parameters<typeof claimAuthoritativeModelExecutionProofInvocation>[0]
): boolean {
  const lease = claimAuthoritativeModelExecutionProofInvocation(proof);
  return lease?.beginInvocation(() => undefined).started === true;
}

const PROJECT_PATH = process.cwd();

function issueAuthoritativeModelExecutionProof(
  input: Omit<Parameters<typeof issueAuthoritativeModelExecutionProofRaw>[0], 'authorityEpoch'>
) {
  return issueAuthoritativeModelExecutionProofRaw({
    ...input,
    authorityEpoch: captureAuthoritativeProofEpoch(input.cwd),
  });
}

describe('TeamLaunchExecutionProofAuthority integration reconciliation', () => {
  afterEach(() => invalidateAuthoritativeModelExecutionProofs());

  type RendererInput = {
    leadProviderId: TeamProviderId;
    leadBackendId: TeamProviderBackendId | null;
    leadModel: string;
    leadEffort?: EffortLevel;
    members: readonly TeamMember[];
  };
  const rendererPreparation = (input: RendererInput) => {
    const result = buildAuthoritativeModelChecks({
      ...input,
      providerStatusById: new Map(),
      resolveMember: (member) => ({
        providerId: normalizeOptionalTeamProviderId(member.providerId) ?? input.leadProviderId,
        model: member.model,
      }),
    });
    return {
      checks: Array.from(result.values()).flat(),
      runtimeRosterRevision: result.runtimeRosterRevision!,
    };
  };

  const leadRequest = {
    teamName: 'team',
    cwd: PROJECT_PATH,
    providerId: 'codex' as const,
    providerBackendId: 'codex-native' as const,
    model: 'gpt-5',
    effort: 'high' as const,
    leadRuntimeSelectionProvenance: {
      version: 1 as const,
      providerBackendId: 'explicit' as const,
      model: 'explicit' as const,
      effort: 'explicit' as const,
    },
  };

  it.each([
    ['anthropic', null, 'claude-sonnet-4-5'],
    ['codex', 'codex-native', 'gpt-5'],
    ['gemini', 'cli-sdk', 'gemini-2.5-pro'],
    ['opencode', 'opencode-cli', 'openai/gpt-5'],
  ] as const)(
    'binds and consumes an exact fresh %s backend candidate once',
    (
      providerId: TeamProviderId,
      providerBackendId: TeamProviderBackendId | null,
      model: string
    ) => {
      const executionProof = issueAuthoritativeModelExecutionProof({
        cwd: PROJECT_PATH,
        checks: [{ providerId, providerBackendId, model }],
        runtimeRosterRevision: buildEffectiveRuntimeRosterRevision({
          lead: { providerId, providerBackendId, model },
          leadRuntimeSelectionProvenance: {
            version: 1,
            providerBackendId: providerBackendId ? 'explicit' : 'default',
            model: 'explicit',
            effort: 'default',
          },
          members: [],
          missingProvenance: 'reject',
        }),
      });
      const request: TeamLaunchRequest = {
        teamName: 'team',
        cwd: PROJECT_PATH,
        providerId,
        ...(providerBackendId ? { providerBackendId } : {}),
        model,
        leadRuntimeSelectionProvenance: {
          version: 1,
          providerBackendId: providerBackendId ? 'explicit' : 'default',
          model: 'explicit',
          effort: 'default',
        },
        executionProof,
      };

      expect(verifyAuthoritativeModelExecutionProofForRequest(executionProof, request, [])).toBe(
        true
      );
      const bound = authorizeProductionTeamLaunchRequest(request, [], true).executionProof!;
      expect(verifyAuthoritativeModelExecutionProof(executionProof)).toBe(false);
      expect(consumeExecutionProof(bound)).toBe(true);
      expect(consumeExecutionProof(bound)).toBe(false);
    }
  );

  it('rejects a stale Default proof for an explicit selection of the same concrete model', () => {
    const defaultProvenance = {
      version: 1 as const,
      providerBackendId: 'default' as const,
      model: 'default' as const,
      effort: 'default' as const,
    };
    const runtimeRosterRevision = buildEffectiveRuntimeRosterRevision({
      lead: leadRequest,
      leadRuntimeSelectionProvenance: defaultProvenance,
      members: [],
      missingProvenance: 'reject',
    })!;
    const checks = [
      {
        providerId: 'codex' as const,
        providerBackendId: 'codex-native' as const,
        model: 'gpt-5',
        effort: 'high' as const,
      },
    ];
    const executionProof = issueAuthoritativeModelExecutionProof({
      cwd: leadRequest.cwd,
      checks,
      runtimeRosterRevision,
    });
    const defaultRequest: TeamLaunchRequest = {
      ...leadRequest,
      leadRuntimeSelectionProvenance: defaultProvenance,
      executionProof,
    };

    expect(
      verifyAuthoritativeModelExecutionProofForRequest(executionProof, defaultRequest, [])
    ).toBe(true);
    expect(
      verifyAuthoritativeModelExecutionProofForRequest(
        executionProof,
        {
          ...defaultRequest,
          leadRuntimeSelectionProvenance: leadRequest.leadRuntimeSelectionProvenance,
        },
        []
      )
    ).toBe(false);
    expect(
      verifyAuthoritativeModelExecutionProofForRequest(
        executionProof,
        { ...defaultRequest, model: 'gpt-6' },
        []
      )
    ).toBe(false);
  });

  it('accepts a create proof when an explicit same-provider member model inherits lead effort', () => {
    const members = materializeConcreteLaunchRoster({
      members: [
        {
          name: 'builder',
          providerId: 'codex',
          model: 'gpt-5-mini',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'explicit',
            effort: 'inherited',
          },
        },
      ],
      leadProviderId: 'codex',
      leadBackendId: 'codex-native',
      leadModel: 'gpt-5',
      leadEffort: 'high',
      providerStatusById: new Map(),
    })!;
    const { checks, runtimeRosterRevision } = rendererPreparation({
      leadProviderId: 'codex',
      leadBackendId: 'codex-native',
      leadModel: 'gpt-5',
      leadEffort: 'high',
      members,
    });
    expect(checks).toContainEqual({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5-mini',
      effort: 'high',
    });
    const executionProof = issueAuthoritativeModelExecutionProof({
      cwd: leadRequest.cwd,
      checks,
      runtimeRosterRevision,
    });

    const authorized = authorizeProductionTeamCreateRequest(
      { ...leadRequest, displayName: 'Team', members, executionProof },
      true
    );
    expect(authorized.executionProof?.authorityId).not.toBe(executionProof.authorityId);
  });

  it('accepts a relaunch proof when an explicit same-provider member model inherits lead effort', () => {
    const roster = materializeConcreteLaunchRoster({
      members: [
        {
          name: 'builder',
          providerId: 'codex',
          model: 'gpt-5-mini',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'explicit',
            effort: 'inherited',
          },
        },
      ],
      leadProviderId: 'codex',
      leadBackendId: 'codex-native',
      leadModel: 'gpt-5',
      leadEffort: 'high',
      providerStatusById: new Map(),
    })!;
    const { checks, runtimeRosterRevision } = rendererPreparation({
      leadProviderId: 'codex',
      leadBackendId: 'codex-native',
      leadModel: 'gpt-5',
      leadEffort: 'high',
      members: roster,
    });
    const executionProof = issueAuthoritativeModelExecutionProof({
      cwd: leadRequest.cwd,
      checks,
      runtimeRosterRevision,
    });

    const authorized = authorizeProductionTeamLaunchRequest(
      { ...leadRequest, executionProof },
      roster,
      true
    );
    expect(authorized.executionProof?.authorityId).not.toBe(executionProof.authorityId);
  });

  it('keeps explicit same-provider member effort authoritative across the boundary', () => {
    const roster = materializeConcreteLaunchRoster({
      members: [
        {
          name: 'builder',
          providerId: 'codex',
          model: 'gpt-5-mini',
          effort: 'low',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'explicit',
            effort: 'explicit',
          },
        },
      ],
      leadProviderId: 'codex',
      leadBackendId: 'codex-native',
      leadModel: 'gpt-5',
      leadEffort: 'high',
      providerStatusById: new Map(),
    })!;
    const { checks, runtimeRosterRevision } = rendererPreparation({
      leadProviderId: 'codex',
      leadBackendId: 'codex-native',
      leadModel: 'gpt-5',
      leadEffort: 'high',
      members: roster,
    });
    expect(checks).toContainEqual({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5-mini',
      effort: 'low',
    });
    const executionProof = issueAuthoritativeModelExecutionProof({
      cwd: leadRequest.cwd,
      checks,
      runtimeRosterRevision,
    });

    expect(
      verifyAuthoritativeModelExecutionProofForRequest(
        executionProof,
        { ...leadRequest, executionProof },
        roster
      )
    ).toBe(true);
  });

  it('does not inherit lead effort across providers', () => {
    const roster = materializeConcreteLaunchRoster({
      members: [
        {
          name: 'reviewer',
          providerId: 'gemini',
          providerBackendId: 'cli-sdk',
          model: 'gemini-2.5-pro',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'explicit',
            model: 'explicit',
            effort: 'inherited',
          },
        },
      ],
      leadProviderId: 'codex',
      leadBackendId: 'codex-native',
      leadModel: 'gpt-5',
      leadEffort: 'high',
      providerStatusById: new Map(),
    })!;
    const { checks, runtimeRosterRevision } = rendererPreparation({
      leadProviderId: 'codex',
      leadBackendId: 'codex-native',
      leadModel: 'gpt-5',
      leadEffort: 'high',
      members: roster,
    });
    expect(checks).toContainEqual({
      providerId: 'gemini',
      providerBackendId: 'cli-sdk',
      model: 'gemini-2.5-pro',
    });
    const executionProof = issueAuthoritativeModelExecutionProof({
      cwd: leadRequest.cwd,
      checks,
      runtimeRosterRevision,
    });

    expect(
      verifyAuthoritativeModelExecutionProofForRequest(
        executionProof,
        { ...leadRequest, executionProof },
        roster
      )
    ).toBe(true);
  });

  it('keeps proof and launch materialization equivalent after inherited lead route changes', () => {
    const oldRoster = materializeConcreteLaunchRoster({
      members: [
        {
          name: 'builder',
          providerId: 'codex',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'inherited',
            effort: 'inherited',
          },
        },
      ],
      leadProviderId: 'codex',
      leadBackendId: 'codex-native',
      leadModel: 'gpt-5',
      leadEffort: 'high',
      providerStatusById: new Map(),
    })!;
    const { checks, runtimeRosterRevision } = rendererPreparation({
      leadProviderId: 'codex',
      leadBackendId: 'adapter',
      leadModel: 'gpt-6',
      leadEffort: 'xhigh',
      members: oldRoster,
    });
    expect(checks).toEqual([
      {
        providerId: 'codex',
        providerBackendId: 'adapter',
        model: 'gpt-6',
        effort: 'xhigh',
      },
    ]);
    const currentRoster = materializeConcreteLaunchRoster({
      members: oldRoster,
      leadProviderId: 'codex',
      leadBackendId: 'adapter',
      leadModel: 'gpt-6',
      leadEffort: 'xhigh',
      providerStatusById: new Map(),
    })!;
    const executionProof = issueAuthoritativeModelExecutionProof({
      cwd: leadRequest.cwd,
      checks,
      runtimeRosterRevision,
    });

    expect(
      verifyAuthoritativeModelExecutionProofForRequest(
        executionProof,
        {
          ...leadRequest,
          providerBackendId: 'adapter',
          model: 'gpt-6',
          effort: 'xhigh',
          executionProof,
        },
        currentRoster
      )
    ).toBe(true);
  });

});
