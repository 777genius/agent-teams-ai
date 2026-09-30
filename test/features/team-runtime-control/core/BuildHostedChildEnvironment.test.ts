import {
  type CredentialExposureSet,
  parseExecutionUnitId,
  parseLaneId,
  parseSecretClass,
  parseSecretRefId,
  type SecretRefMetadata,
} from '@features/team-runtime-control/contracts/runtimePlan';
import {
  buildHostedChildEnvironment,
  type BuildHostedChildEnvironmentResult,
} from '@features/team-runtime-control/core/application/environment/BuildHostedChildEnvironment';
import { createHostedChildEnvironmentPolicy } from '@features/team-runtime-control/core/domain/HostedChildEnvironmentPolicy';
import { parseRunId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import type {
  CreateHostedChildEnvironmentPolicyInput,
  HostedChildEnvironmentIdentity,
  HostedChildEnvironmentPolicy,
  HostedChildEnvironmentVariable,
} from '@features/team-runtime-control/contracts/hostedChildEnvironment';
import type {
  HostedChildEnvironmentValueResolution,
  HostedChildEnvironmentValueResolverPort,
  ResolveHostedChildNonSecretValueRequest,
  ResolveHostedChildProviderSecretRequest,
} from '@features/team-runtime-control/core/application/environment/ports';

const secretRef: SecretRefMetadata = {
  secretRefId: parseSecretRefId('anthropic-primary'),
  secretClass: parseSecretClass('provider-api-key'),
};
const anotherSecretRef: SecretRefMetadata = {
  secretRefId: parseSecretRefId('anthropic-secondary'),
  secretClass: parseSecretClass('provider-oauth'),
};
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
const secretVariable = {
  name: 'ANTHROPIC_API_KEY',
  provenance: 'secret_ref',
  secretRef,
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

const runtimeIdentity = {
  providerId: 'anthropic',
  backend: 'provisioning_cli',
  executionUnitId: parseExecutionUnitId('unit-anthropic-primary'),
  laneId: parseLaneId('lane-anthropic-primary'),
  runId: parseRunId(`run_${'a'.repeat(32)}`),
} satisfies HostedChildEnvironmentIdentity;

function policyInput(
  overrides: Partial<CreateHostedChildEnvironmentPolicyInput> = {}
): CreateHostedChildEnvironmentPolicyInput {
  return {
    identity: runtimeIdentity,
    providerDeclaration: {
      providerId: 'anthropic',
      backend: 'provisioning_cli',
      secretRefs: [secretRef],
      variables: [pathVariable, runVariable, secretVariable],
    },
    requestedVariables: [pathVariable, runVariable, secretVariable],
    acceptedCredentialExposureSet: { secretRefs: [secretRef] },
    inheritance: 'none',
    ...overrides,
  };
}

function policy(overrides: Partial<CreateHostedChildEnvironmentPolicyInput> = {}) {
  const result = createHostedChildEnvironmentPolicy(policyInput(overrides));
  expect(result.status).toBe('accepted');
  if (result.status === 'rejected') throw new Error(`fixture rejected: ${result.error.code}`);
  return result.policy;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function forgedPolicyWithVariable(
  variable: HostedChildEnvironmentVariable
): HostedChildEnvironmentPolicy {
  const emptyPolicy = policy({
    requestedVariables: [],
    acceptedCredentialExposureSet: { secretRefs: [] },
  });
  return deepFreeze({
    ...emptyPolicy,
    variables: [variable],
  });
}

class RecordingResolver implements HostedChildEnvironmentValueResolverPort {
  readonly requestedKeys: string[] = [];
  readonly ambientEnvironment = Object.freeze({
    CONTROLLER_SECRET_CANARY: 'controller-secret-must-not-flow',
  });

  constructor(
    private readonly values: Readonly<Record<string, string>>,
    private readonly rejection?: HostedChildEnvironmentValueResolution
  ) {}

  resolveNonSecret(
    request: ResolveHostedChildNonSecretValueRequest
  ): Promise<HostedChildEnvironmentValueResolution> {
    return this.resolve(request.identity, request.variable.name);
  }

  resolveProviderSecret(
    request: ResolveHostedChildProviderSecretRequest
  ): Promise<HostedChildEnvironmentValueResolution> {
    return this.resolve(request.identity, request.variable.name);
  }

  private resolve(
    identity: HostedChildEnvironmentIdentity,
    key: string
  ): Promise<HostedChildEnvironmentValueResolution> {
    expect(identity).toEqual(runtimeIdentity);
    this.requestedKeys.push(key);
    if (this.rejection) return Promise.resolve(this.rejection);
    const value = this.values[key];
    return Promise.resolve(
      value === undefined
        ? { status: 'rejected', reason: 'unavailable' }
        : { status: 'resolved', value }
    );
  }
}

function request(
  environmentPolicy: HostedChildEnvironmentPolicy,
  overrides: Partial<{
    readonly identity: HostedChildEnvironmentIdentity;
    readonly credentialExposureSet: CredentialExposureSet;
  }> = {}
) {
  return {
    policy: environmentPolicy,
    identity: runtimeIdentity,
    credentialExposureSet: { secretRefs: [secretRef] },
    ...overrides,
  };
}

function acceptedOutput(result: BuildHostedChildEnvironmentResult) {
  expect(result.status).toBe('accepted');
  if (result.status === 'rejected') throw new Error(`build rejected: ${result.error.code}`);
  return result.output;
}

describe('BuildHostedChildEnvironment', () => {
  it('resolves declared values only at the final boundary and excludes ambient canaries', async () => {
    const environmentPolicy = policy();
    const resolver = new RecordingResolver({
      PATH: '/provider/bin',
      HOSTED_RUN_ID: runtimeIdentity.runId,
      ANTHROPIC_API_KEY: 'provider-secret-value',
    });

    const output = acceptedOutput(
      await buildHostedChildEnvironment(request(environmentPolicy), resolver)
    );

    expect(Object.fromEntries(Object.entries(output.environment))).toEqual({
      ANTHROPIC_API_KEY: 'provider-secret-value',
      HOSTED_RUN_ID: runtimeIdentity.runId,
      PATH: '/provider/bin',
    });
    expect(resolver.requestedKeys).toEqual(['ANTHROPIC_API_KEY', 'HOSTED_RUN_ID', 'PATH']);
    expect(output.environment).not.toHaveProperty('CONTROLLER_SECRET_CANARY');
    expect(output.keyProvenanceHash).toBe(environmentPolicy.keyProvenanceHash);
    expect(output.credentialExposureSet).toEqual(environmentPolicy.acceptedCredentialExposureSet);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.environment)).toBe(true);
    expect(Object.getPrototypeOf(output.environment)).toBeNull();
  });

  it('keeps an empty policy empty without consulting a resolver', async () => {
    const environmentPolicy = policy({
      requestedVariables: [],
      acceptedCredentialExposureSet: { secretRefs: [] },
    });
    const resolver = new RecordingResolver({});
    const output = acceptedOutput(
      await buildHostedChildEnvironment(
        request(environmentPolicy, { credentialExposureSet: { secretRefs: [] } }),
        resolver
      )
    );

    expect(Object.keys(output.environment)).toEqual([]);
    expect(resolver.requestedKeys).toEqual([]);
  });

  it('rejects controller-only exact and prefix keys without consulting a resolver', async () => {
    for (const variable of [
      controllerExactCanaryVariable,
      controllerExactControlVariable,
      controllerPrefixControlVariable,
    ]) {
      const resolver = new RecordingResolver({
        [variable.name]: 'controller-value-must-not-resolve',
      });
      const result = await buildHostedChildEnvironment(
        request(forgedPolicyWithVariable(variable), {
          credentialExposureSet: { secretRefs: [] },
        }),
        resolver
      );

      expect(result).toEqual({
        status: 'rejected',
        error: { code: 'forbidden_key', key: variable.name },
      });
      expect(resolver.requestedKeys).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('controller-value-must-not-resolve');
    }
  });

  it('rejects identity mismatch before resolving any value', async () => {
    const environmentPolicy = policy();
    const resolver = new RecordingResolver({});
    const result = await buildHostedChildEnvironment(
      request(environmentPolicy, {
        identity: {
          ...runtimeIdentity,
          laneId: parseLaneId('lane-not-accepted'),
        },
      }),
      resolver
    );

    expect(result).toEqual({ status: 'rejected', error: { code: 'identity_mismatch' } });
    expect(resolver.requestedKeys).toEqual([]);
  });

  it('rejects exposure-set widening and mismatch before resolving values', async () => {
    const environmentPolicy = policy();
    for (const [credentialExposureSet, code] of [
      [{ secretRefs: [secretRef, anotherSecretRef] }, 'credential_exposure_widening'],
      [{ secretRefs: [] }, 'credential_exposure_mismatch'],
    ] as const) {
      const resolver = new RecordingResolver({});
      expect(
        await buildHostedChildEnvironment(
          request(environmentPolicy, { credentialExposureSet }),
          resolver
        )
      ).toEqual({ status: 'rejected', error: { code } });
      expect(resolver.requestedKeys).toEqual([]);
    }
  });

  it('rejects attempted process or shell environment inheritance', async () => {
    const environmentPolicy = policy();
    const resolver = new RecordingResolver({});
    for (const ambientField of [
      { processEnvironment: { CONTROLLER_SECRET_CANARY: 'must-not-flow' } },
      { shellEnvironment: { CONTROLLER_SECRET_CANARY: 'must-not-flow' } },
      { inheritedEnvironment: { CONTROLLER_SECRET_CANARY: 'must-not-flow' } },
    ]) {
      expect(
        await buildHostedChildEnvironment(
          { ...request(environmentPolicy), ...ambientField },
          resolver
        )
      ).toEqual({
        status: 'rejected',
        error: { code: 'environment_inheritance_forbidden' },
      });
    }
    expect(resolver.requestedKeys).toEqual([]);
  });

  it('returns value-free fail-closed errors for resolver rejection and failure', async () => {
    const environmentPolicy = policy();
    const canary = 'resolver-secret-canary-f19e3';
    const rejected = await buildHostedChildEnvironment(
      request(environmentPolicy),
      new RecordingResolver({}, { status: 'rejected', reason: 'not_authorized' })
    );
    const throwingResolver: HostedChildEnvironmentValueResolverPort = {
      resolveNonSecret: () => {
        throw new Error(canary);
      },
      resolveProviderSecret: () => {
        throw new Error(canary);
      },
    };
    const failed = await buildHostedChildEnvironment(request(environmentPolicy), throwingResolver);

    expect(rejected).toEqual({
      status: 'rejected',
      error: { code: 'value_resolution_failed', key: 'ANTHROPIC_API_KEY' },
    });
    expect(failed).toEqual(rejected);
    expect(JSON.stringify([rejected, failed])).not.toContain(canary);
  });

  it('rejects NUL-bearing values without including the value in its error', async () => {
    const environmentPolicy = policy();
    const canary = 'secret\u0000value';
    const result = await buildHostedChildEnvironment(
      request(environmentPolicy),
      new RecordingResolver({ ANTHROPIC_API_KEY: canary })
    );

    expect(result).toEqual({
      status: 'rejected',
      error: { code: 'resolved_value_invalid', key: 'ANTHROPIC_API_KEY' },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('keeps the value-free hash stable when boundary-resolved values change', async () => {
    const environmentPolicy = policy();
    const first = acceptedOutput(
      await buildHostedChildEnvironment(
        request(environmentPolicy),
        new RecordingResolver({
          ANTHROPIC_API_KEY: 'first-provider-secret',
          HOSTED_RUN_ID: 'first-runtime-value',
          PATH: '/first/bin',
        })
      )
    );
    const second = acceptedOutput(
      await buildHostedChildEnvironment(
        request(environmentPolicy),
        new RecordingResolver({
          ANTHROPIC_API_KEY: 'second-provider-secret',
          HOSTED_RUN_ID: 'second-runtime-value',
          PATH: '/second/bin',
        })
      )
    );

    expect(first.environment).not.toEqual(second.environment);
    expect(first.keyProvenanceHash).toBe(second.keyProvenanceHash);
    expect(environmentPolicy.keyProvenanceHash).not.toContain('provider-secret');
  });
});
