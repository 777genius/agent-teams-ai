import { createHash } from 'node:crypto';

import { HOSTED_CHILD_ENVIRONMENT_CONTROLLER_ONLY_DENIAL } from '@features/team-runtime-control/contracts/hostedChildEnvironment';
import {
  parseExecutionUnitId,
  parseLaneId,
  parseSecretClass,
  parseSecretRefId,
  type ProcessExecutionUnit,
  type SecretRefMetadata,
} from '@features/team-runtime-control/contracts/runtimePlan';
import {
  admitHostedChildEnvironmentPolicy,
  createHostedChildEnvironmentPolicy,
  validateHostedChildCredentialExposureSet,
} from '@features/team-runtime-control/core/domain/HostedChildEnvironmentPolicy';
import { parseRunId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import type {
  CreateHostedChildEnvironmentPolicyInput,
  HostedChildEnvironmentIdentity,
  HostedChildEnvironmentPolicy,
  HostedChildEnvironmentProviderDeclaration,
  HostedChildEnvironmentVariable,
} from '@features/team-runtime-control/contracts/hostedChildEnvironment';

const providerSecret = (id: string, secretClass = 'provider-api-key'): SecretRefMetadata => ({
  secretRefId: parseSecretRefId(id),
  secretClass: parseSecretClass(secretClass),
});

const secretA = providerSecret('anthropic-primary');
const secretB = providerSecret('anthropic-secondary', 'provider-oauth');
const pathVariable = {
  name: 'PATH',
  provenance: 'provider_static',
  authority: 'runtime-provider-management',
} as const;
const runVariable = {
  name: 'HOSTED_RUN_ID',
  provenance: 'runtime_metadata',
  authority: 'team-runtime-control',
} as const;
const secretVariableA = {
  name: 'ANTHROPIC_API_KEY',
  provenance: 'secret_ref',
  secretRef: secretA,
} as const;
const secretVariableB = {
  name: 'ANTHROPIC_OAUTH_TOKEN',
  provenance: 'secret_ref',
  secretRef: secretB,
} as const;
const controllerExactCanaryVariable = {
  name: 'CONTROLLER_SECRET_CANARY',
  provenance: 'runtime_metadata',
  authority: 'team-runtime-control',
} as const;
const controllerExactControlVariable = {
  name: 'HOSTED_RUNTIME_INGRESS_BEARER',
  provenance: 'runtime_metadata',
  authority: 'team-runtime-control',
} as const;
const controllerPrefixControlVariable = {
  name: 'AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP',
  provenance: 'runtime_metadata',
  authority: 'team-runtime-control',
} as const;

const identity = (overrides: Partial<HostedChildEnvironmentIdentity> = {}) =>
  ({
    providerId: 'anthropic',
    backend: 'provisioning_cli',
    executionUnitId: parseExecutionUnitId('unit-anthropic-primary'),
    laneId: parseLaneId('lane-anthropic-primary'),
    runId: parseRunId(`run_${'1'.repeat(32)}`),
    ...overrides,
  }) satisfies HostedChildEnvironmentIdentity;

function declaration(
  overrides: Partial<HostedChildEnvironmentProviderDeclaration> = {}
): HostedChildEnvironmentProviderDeclaration {
  return {
    providerId: 'anthropic',
    backend: 'provisioning_cli',
    secretRefs: [secretA, secretB],
    variables: [pathVariable, runVariable, secretVariableA, secretVariableB],
    ...overrides,
  };
}

function input(
  overrides: Partial<CreateHostedChildEnvironmentPolicyInput> = {}
): CreateHostedChildEnvironmentPolicyInput {
  return {
    identity: identity(),
    providerDeclaration: declaration(),
    requestedVariables: [pathVariable, runVariable, secretVariableA, secretVariableB],
    acceptedCredentialExposureSet: { secretRefs: [secretA, secretB] },
    inheritance: 'none',
    ...overrides,
  };
}

function acceptedPolicy(candidate: unknown = input()): HostedChildEnvironmentPolicy {
  const result = createHostedChildEnvironmentPolicy(candidate);
  expect(result.status).toBe('accepted');
  if (result.status === 'rejected') throw new Error(`fixture rejected: ${result.error.code}`);
  return result.policy;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

describe('HostedChildEnvironmentPolicy', () => {
  it('starts from an empty allowlist and returns immutable launch-plan metadata', () => {
    const policy = acceptedPolicy(
      input({
        requestedVariables: [],
        acceptedCredentialExposureSet: { secretRefs: [] },
      })
    );

    expect(policy).toMatchObject({
      policy: 'explicit_allowlist',
      inheritance: 'none',
      variables: [],
      acceptedCredentialExposureSet: { secretRefs: [] },
    });
    expect(policy.keyProvenanceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const canonicalPayload = JSON.stringify({
      contract: 'hosted-child-environment-key-provenance/v1',
      credentialExposure: [],
      identity: {
        backend: policy.identity.backend,
        executionUnitId: policy.identity.executionUnitId,
        laneId: policy.identity.laneId,
        providerId: policy.identity.providerId,
        runId: policy.identity.runId,
      },
      variables: [],
    });
    expect(policy.keyProvenanceHash).toBe(
      `sha256:${createHash('sha256').update(canonicalPayload).digest('hex')}`
    );
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.identity)).toBe(true);
    expect(Object.isFrozen(policy.variables)).toBe(true);
    expect(Object.isFrozen(policy.acceptedCredentialExposureSet.secretRefs)).toBe(true);
  });

  it('accepts only provider-declared SecretRefs and allowlisted non-secret keys', () => {
    const policy = acceptedPolicy();

    expect(policy.variables.map((variable) => variable.name)).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_OAUTH_TOKEN',
      'HOSTED_RUN_ID',
      'PATH',
    ]);
    expect(policy.acceptedCredentialExposureSet.secretRefs).toEqual([secretA, secretB]);
    expect(policy.variables.every(Object.isFrozen)).toBe(true);
    expect(policy.acceptedCredentialExposureSet.secretRefs.every(Object.isFrozen)).toBe(true);

    const executionUnitProjection: Pick<
      ProcessExecutionUnit,
      'credentialExposureSet' | 'environmentPolicy'
    > = {
      environmentPolicy: policy,
      credentialExposureSet: policy.acceptedCredentialExposureSet,
    };
    expect(executionUnitProjection.environmentPolicy).toBe(policy);
  });

  it('produces an order-independent key-provenance hash with no values', () => {
    const forward = acceptedPolicy();
    const reversed = acceptedPolicy(
      input({
        providerDeclaration: declaration({
          secretRefs: [secretB, secretA],
          variables: [secretVariableB, secretVariableA, runVariable, pathVariable],
        }),
        requestedVariables: [secretVariableB, secretVariableA, runVariable, pathVariable],
        acceptedCredentialExposureSet: { secretRefs: [secretB, secretA] },
      })
    );

    expect(reversed.keyProvenanceHash).toBe(forward.keyProvenanceHash);
    expect(JSON.stringify(forward)).not.toContain('resolved-value');
  });

  it('binds the hash to provider, backend, process execution unit, lane and run', () => {
    const variants: Array<{
      identity: HostedChildEnvironmentIdentity;
      providerDeclaration: HostedChildEnvironmentProviderDeclaration;
    }> = [
      { identity: identity(), providerDeclaration: declaration() },
      {
        identity: identity({ providerId: 'codex' }),
        providerDeclaration: declaration({ providerId: 'codex' }),
      },
      {
        identity: identity({ backend: 'opencode' }),
        providerDeclaration: declaration({ backend: 'opencode' }),
      },
      {
        identity: identity({ executionUnitId: parseExecutionUnitId('unit-other') }),
        providerDeclaration: declaration(),
      },
      {
        identity: identity({ laneId: parseLaneId('lane-other') }),
        providerDeclaration: declaration(),
      },
      {
        identity: identity({ runId: parseRunId(`run_${'2'.repeat(32)}`) }),
        providerDeclaration: declaration(),
      },
    ];
    const hashes = variants.map((variant) => acceptedPolicy(input(variant)).keyProvenanceHash);

    expect(new Set(hashes).size).toBe(variants.length);
  });

  it('rejects provider or backend identity mismatches', () => {
    for (const providerDeclaration of [
      declaration({ providerId: 'codex' }),
      declaration({ backend: 'opencode' }),
    ]) {
      expect(createHostedChildEnvironmentPolicy(input({ providerDeclaration }))).toEqual({
        status: 'rejected',
        error: { code: 'identity_mismatch' },
      });
    }
  });

  it('rejects duplicate environment keys and SecretRefs', () => {
    expect(
      createHostedChildEnvironmentPolicy(
        input({ requestedVariables: [pathVariable, { ...pathVariable, name: 'path' }] })
      )
    ).toEqual({ status: 'rejected', error: { code: 'duplicate_key', key: 'path' } });
    expect(
      createHostedChildEnvironmentPolicy(
        input({ providerDeclaration: declaration({ secretRefs: [secretA, secretA] }) })
      )
    ).toEqual({ status: 'rejected', error: { code: 'duplicate_secret_ref' } });
    expect(
      createHostedChildEnvironmentPolicy(
        input({ acceptedCredentialExposureSet: { secretRefs: [secretA, secretA] } })
      )
    ).toEqual({ status: 'rejected', error: { code: 'duplicate_secret_ref' } });
  });

  it('rejects unknown keys', () => {
    const variable = {
      name: 'UNDECLARED_SETTING',
      provenance: 'runtime_metadata',
      authority: 'team-runtime-control',
    } as const;
    expect(createHostedChildEnvironmentPolicy(input({ requestedVariables: [variable] }))).toEqual({
      status: 'rejected',
      error: { code: 'unknown_key', key: variable.name },
    });
  });

  it('immutably denies controller-only exact names and prefixes before declaration matching', () => {
    expect(Object.isFrozen(HOSTED_CHILD_ENVIRONMENT_CONTROLLER_ONLY_DENIAL)).toBe(true);
    expect(Object.isFrozen(HOSTED_CHILD_ENVIRONMENT_CONTROLLER_ONLY_DENIAL.exactNames)).toBe(true);
    expect(Object.isFrozen(HOSTED_CHILD_ENVIRONMENT_CONTROLLER_ONLY_DENIAL.prefixes)).toBe(true);

    for (const variable of [
      controllerExactCanaryVariable,
      controllerExactControlVariable,
      controllerPrefixControlVariable,
    ]) {
      const declaredAndRequested = createHostedChildEnvironmentPolicy(
        input({
          providerDeclaration: declaration({ secretRefs: [], variables: [variable] }),
          requestedVariables: [variable],
          acceptedCredentialExposureSet: { secretRefs: [] },
        })
      );
      expect(declaredAndRequested).toEqual({
        status: 'rejected',
        error: { code: 'forbidden_key', key: variable.name },
      });

      const declaredWithoutRequest = createHostedChildEnvironmentPolicy(
        input({
          providerDeclaration: declaration({ secretRefs: [], variables: [variable] }),
          requestedVariables: [],
          acceptedCredentialExposureSet: { secretRefs: [] },
        })
      );
      expect(declaredWithoutRequest).toEqual({
        status: 'rejected',
        error: { code: 'forbidden_key', key: variable.name },
      });

      const requestedWithoutDeclaration = createHostedChildEnvironmentPolicy(
        input({ requestedVariables: [variable] })
      );
      expect(requestedWithoutDeclaration).toEqual({
        status: 'rejected',
        error: { code: 'forbidden_key', key: variable.name },
      });
    }
  });

  it('keeps loader/runtime injection keys under explicit provider declaration policy', () => {
    const injectionVariables = ['LD_PRELOAD', 'NODE_OPTIONS'].map((name) => ({
      name,
      provenance: 'provider_static' as const,
      authority: 'runtime-provider-management' as const,
    }));
    const result = createHostedChildEnvironmentPolicy(
      input({
        providerDeclaration: declaration({ secretRefs: [], variables: injectionVariables }),
        requestedVariables: injectionVariables,
        acceptedCredentialExposureSet: { secretRefs: [] },
      })
    );

    expect(result.status).toBe('accepted');
    if (result.status === 'rejected') throw new Error(`fixture rejected: ${result.error.code}`);
    expect(result.policy.variables.map((variable) => variable.name)).toEqual([
      'LD_PRELOAD',
      'NODE_OPTIONS',
    ]);
  });

  it('keeps installation and settings provenance under runtime-provider-management authority', () => {
    const wrongAuthority = {
      ...pathVariable,
      authority: 'team-runtime-control',
    } as const;
    expect(
      createHostedChildEnvironmentPolicy(
        input({
          providerDeclaration: declaration({ variables: [wrongAuthority] }),
          requestedVariables: [wrongAuthority],
          acceptedCredentialExposureSet: { secretRefs: [] },
        })
      )
    ).toEqual({ status: 'rejected', error: { code: 'invalid_contract' } });
  });

  it('rejects process and shell environment inheritance fields', () => {
    for (const ambientField of [
      { processEnvironment: { CANARY: 'controller-only' } },
      { shellEnvironment: { CANARY: 'controller-only' } },
      { inheritedEnvironment: { CANARY: 'controller-only' } },
    ]) {
      expect(createHostedChildEnvironmentPolicy({ ...input(), ...ambientField })).toEqual({
        status: 'rejected',
        error: { code: 'environment_inheritance_forbidden' },
      });
    }
  });

  it('rejects contract values without leaking them through typed errors', () => {
    const canary = 'contract-secret-canary-7bc82';
    const variableWithValue = { ...secretVariableA, value: canary };
    const secretRefWithValue = { ...secretA, value: canary };
    const results = [
      createHostedChildEnvironmentPolicy(
        input({
          requestedVariables: [variableWithValue] as readonly HostedChildEnvironmentVariable[],
        })
      ),
      createHostedChildEnvironmentPolicy(
        input({
          providerDeclaration: declaration({ secretRefs: [secretRefWithValue] }),
        })
      ),
    ];

    for (const result of results) {
      expect(result).toMatchObject({
        status: 'rejected',
        error: { code: 'contract_secret_value_forbidden' },
      });
      expect(JSON.stringify(result)).not.toContain(canary);
    }
  });

  it('fails closed with a typed value-free error for hostile contract accessors', () => {
    const canary = 'hostile-accessor-secret-32d4e';
    const hostile = Object.defineProperty({}, 'inheritance', {
      enumerable: true,
      get: () => {
        throw new Error(canary);
      },
    });
    const result = createHostedChildEnvironmentPolicy(hostile);

    expect(result).toEqual({ status: 'rejected', error: { code: 'invalid_contract' } });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('rejects undeclared SecretRefs and widening after accepting an immutable exposure set', () => {
    const undeclared = providerSecret('undeclared-provider-secret');
    expect(
      createHostedChildEnvironmentPolicy(
        input({ acceptedCredentialExposureSet: { secretRefs: [secretA, undeclared] } })
      )
    ).toEqual({ status: 'rejected', error: { code: 'secret_ref_not_declared' } });
    expect(
      createHostedChildEnvironmentPolicy(
        input({
          requestedVariables: [secretVariableB],
          acceptedCredentialExposureSet: { secretRefs: [secretA] },
        })
      )
    ).toEqual({
      status: 'rejected',
      error: { code: 'credential_exposure_widening', key: 'ANTHROPIC_OAUTH_TOKEN' },
    });

    const policy = acceptedPolicy(
      input({
        requestedVariables: [secretVariableA],
        acceptedCredentialExposureSet: { secretRefs: [secretA] },
      })
    );
    expect(
      validateHostedChildCredentialExposureSet(policy, { secretRefs: [secretA, secretB] })
    ).toEqual({ status: 'rejected', error: { code: 'credential_exposure_widening' } });
    expect(validateHostedChildCredentialExposureSet(policy, { secretRefs: [] })).toEqual({
      status: 'rejected',
      error: { code: 'credential_exposure_mismatch' },
    });
  });

  it('admits only immutable policies whose provenance hash still matches', () => {
    const policy = acceptedPolicy();
    const mutableClone = JSON.parse(JSON.stringify(policy)) as HostedChildEnvironmentPolicy;
    expect(admitHostedChildEnvironmentPolicy(mutableClone)).toEqual({
      status: 'rejected',
      error: { code: 'policy_not_immutable' },
    });

    const tampered = JSON.parse(JSON.stringify(policy)) as HostedChildEnvironmentPolicy;
    Object.assign(tampered, { keyProvenanceHash: `sha256:${'0'.repeat(64)}` });
    deepFreeze(tampered);
    expect(admitHostedChildEnvironmentPolicy(tampered)).toEqual({
      status: 'rejected',
      error: { code: 'policy_hash_mismatch' },
    });
    expect(admitHostedChildEnvironmentPolicy(policy)).toEqual({ status: 'accepted', policy });
  });
});
