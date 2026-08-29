import {
  markNativeModelTargetedLiveness,
  markOpenCodeStrictLaunchDelegation,
} from '@main/services/team/provisioning/TeamProvisioningLaunchPreparationEvidence';
import {
  captureAuthoritativeProofEpoch,
  claimAuthoritativeModelExecutionProofInvocation,
  invalidateAuthoritativeModelExecutionProofs,
} from '@main/services/team/TeamLaunchExecutionProofAuthority';
import { buildEffectiveRuntimeRosterRevision } from '@shared/utils/effectiveMemberRuntimeIdentity';
import { describe, expect, it } from 'vitest';

import { attachExecutionProofToPrepareResult } from '../attachExecutionProofToPrepareResult';
import { authorizeProductionTeamCreateRequest } from '../authorizeProductionTeamCreateRequest';

import type { TeamProvisioningModelCheckRequest } from '@shared/types';

const CHECK: TeamProvisioningModelCheckRequest = {
  providerId: 'codex',
  providerBackendId: 'codex-native',
  model: 'gpt-5.6-sol',
  effort: 'high',
};

function consumeExecutionProof(
  proof: Parameters<typeof claimAuthoritativeModelExecutionProofInvocation>[0]
): boolean {
  const lease = claimAuthoritativeModelExecutionProofInvocation(proof);
  return lease?.beginInvocation(() => undefined).started === true;
}
const OPENCODE_CHECK: TeamProvisioningModelCheckRequest = {
  providerId: 'opencode',
  providerBackendId: 'opencode-cli',
  model: 'openrouter/verified',
  effort: 'high',
};
const EMPTY_CODEX_ROSTER_REVISION = buildEffectiveRuntimeRosterRevision({
  lead: {
    providerId: 'codex',
    providerBackendId: 'codex-native',
    model: CHECK.model,
    effort: CHECK.effort,
  },
  leadRuntimeSelectionProvenance: {
    version: 1,
    providerBackendId: 'explicit',
    model: 'explicit',
    effort: 'explicit',
  },
  members: [],
  missingProvenance: 'reject',
})!;
const PROJECT_PATH = process.cwd();

function attach(
  input: Omit<Parameters<typeof attachExecutionProofToPrepareResult>[0], 'authorityEpoch'>
) {
  return attachExecutionProofToPrepareResult({
    ...input,
    authorityEpoch: captureAuthoritativeProofEpoch(input.cwd ?? PROJECT_PATH),
  });
}

describe('attachExecutionProofToPrepareResult', () => {
  it('rejects a malformed effective-roster revision before minting proof', () => {
    const result = attach({
      result: markNativeModelTargetedLiveness(
        { ready: true, message: 'live', processedModelChecks: [CHECK] },
        [CHECK]
      ),
      cwd: PROJECT_PATH,
      mode: 'deep',
      checks: [CHECK],
      runtimeRosterRevision: '',
    });

    expect(result).toMatchObject({
      ready: false,
      executionProof: undefined,
      message: 'runtimeRosterRevision must be a non-empty bounded string',
    });
  });

  it('mints no proof from catalog/processed evidence without native liveness evidence', () => {
    const result = attach({
      result: {
        ready: true,
        message: 'catalog compatible',
        processedModelChecks: [CHECK],
      },
      cwd: PROJECT_PATH,
      mode: 'deep',
      checks: [CHECK],
      runtimeRosterRevision: EMPTY_CODEX_ROSTER_REVISION,
    });

    expect(result).toMatchObject({
      ready: false,
      message:
        'Authoritative preparation did not complete every native model-targeted liveness check',
    });
    expect(result.executionProof).toBeUndefined();
  });

  it('mints a native authorization from complete model-targeted liveness evidence', () => {
    const result = attach({
      result: markNativeModelTargetedLiveness(
        {
          ready: true,
          message: 'live',
          processedModelChecks: [CHECK],
        },
        [CHECK]
      ),
      cwd: PROJECT_PATH,
      mode: 'deep',
      checks: [CHECK],
      runtimeRosterRevision: EMPTY_CODEX_ROSTER_REVISION,
    });

    expect(result.ready).toBe(true);
    expect(result.executionProof).toBeDefined();

    const authorized = authorizeProductionTeamCreateRequest(
      {
        teamName: 'native-team',
        cwd: PROJECT_PATH,
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: CHECK.model,
        effort: CHECK.effort,
        leadRuntimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'explicit',
          model: 'explicit',
          effort: 'explicit',
        },
        members: [],
        executionProof: result.executionProof,
      },
      true
    );
    expect(consumeExecutionProof(authorized.executionProof!)).toBe(true);
    expect(consumeExecutionProof(authorized.executionProof!)).toBe(false);
  });

  it('does not accept OpenCode readiness or processed checks without strict delegation', () => {
    const result = attach({
      result: {
        ready: true,
        message: 'ready',
        processedModelChecks: [OPENCODE_CHECK],
      },
      cwd: PROJECT_PATH,
      mode: 'deep',
      checks: [OPENCODE_CHECK],
    });

    expect(result.ready).toBe(false);
    expect(result.executionProof).toBeUndefined();
    expect(result.message).toContain('strict OpenCode');
  });

  it('mints dispatch authorization from internal OpenCode v1 delegation only', () => {
    const prepared = markOpenCodeStrictLaunchDelegation(
      { ready: true, message: 'prepared', processedModelChecks: [OPENCODE_CHECK] },
      { contractVersion: 1, checks: [OPENCODE_CHECK] }
    );
    expect(prepared).not.toHaveProperty('openCodeStrictLaunchDelegation');

    const result = attach({
      result: prepared,
      cwd: PROJECT_PATH,
      mode: 'deep',
      checks: [OPENCODE_CHECK],
    });
    expect(result).toMatchObject({ ready: true, executionProof: expect.any(Object) });

    const serializedClone = structuredClone(prepared);
    expect(
      attach({
        result: serializedClone,
        cwd: PROJECT_PATH,
        mode: 'deep',
        checks: [OPENCODE_CHECK],
      })
    ).toMatchObject({ ready: false, executionProof: undefined });
  });

  it('mints mixed authorization only from partitioned native and OpenCode evidence', () => {
    const result = attach({
      result: markNativeModelTargetedLiveness(
        markOpenCodeStrictLaunchDelegation(
          { ready: true, message: 'ready', processedModelChecks: [CHECK, OPENCODE_CHECK] },
          { contractVersion: 1, checks: [OPENCODE_CHECK] }
        ),
        [CHECK]
      ),
      cwd: PROJECT_PATH,
      mode: 'deep',
      checks: [CHECK, OPENCODE_CHECK],
    });

    expect(result.ready).toBe(true);
    expect(result.executionProof).toBeDefined();
  });

  it('does not mint from a late preparation completion after authority abort', () => {
    const authorityEpoch = captureAuthoritativeProofEpoch(PROJECT_PATH);
    invalidateAuthoritativeModelExecutionProofs();

    const result = attachExecutionProofToPrepareResult({
      authorityEpoch,
      result: markNativeModelTargetedLiveness(
        { ready: true, message: 'completed after abort', processedModelChecks: [CHECK] },
        [CHECK]
      ),
      cwd: PROJECT_PATH,
      mode: 'deep',
      checks: [CHECK],
      runtimeRosterRevision: EMPTY_CODEX_ROSTER_REVISION,
    });

    expect(result).toMatchObject({
      ready: false,
      executionProof: undefined,
      message: 'Launch authorization epoch changed during preparation',
    });
  });
});
