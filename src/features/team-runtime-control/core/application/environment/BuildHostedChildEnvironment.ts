import {
  admitHostedChildEnvironmentPolicy,
  hostedChildEnvironmentIdentitiesEqual,
  validateHostedChildCredentialExposureSet,
} from '../../domain/HostedChildEnvironmentPolicy';

import type {
  HostedChildEnvironmentIdentity,
  HostedChildEnvironmentKeyProvenanceHash,
  HostedChildEnvironmentPolicy,
  HostedChildEnvironmentPolicyError,
} from '../../../contracts/hostedChildEnvironment';
import type { CredentialExposureSet } from '../../../contracts/runtimePlan';
import type {
  HostedChildEnvironmentValueResolution,
  HostedChildEnvironmentValueResolverPort,
} from './ports';

export interface BuildHostedChildEnvironmentRequest {
  readonly policy: HostedChildEnvironmentPolicy;
  readonly identity: HostedChildEnvironmentIdentity;
  readonly credentialExposureSet: CredentialExposureSet;
}

/** Materialized only at the process application boundary and never persisted as policy metadata. */
export interface BuiltHostedChildEnvironment {
  readonly identity: HostedChildEnvironmentIdentity;
  readonly keyProvenanceHash: HostedChildEnvironmentKeyProvenanceHash;
  readonly credentialExposureSet: CredentialExposureSet;
  readonly environment: Readonly<Record<string, string>>;
}

export type BuildHostedChildEnvironmentResult =
  | { readonly status: 'accepted'; readonly output: BuiltHostedChildEnvironment }
  | { readonly status: 'rejected'; readonly error: HostedChildEnvironmentPolicyError };

/**
 * Resolves only policy-declared values at the final process adapter boundary. The resolver has no
 * ambient environment input, and this use case always constructs its output from an empty record.
 */
export async function buildHostedChildEnvironment(
  request: unknown,
  resolver: HostedChildEnvironmentValueResolverPort
): Promise<BuildHostedChildEnvironmentResult> {
  try {
    return await buildHostedChildEnvironmentUnchecked(request, resolver);
  } catch {
    return reject('invalid_contract');
  }
}

async function buildHostedChildEnvironmentUnchecked(
  request: unknown,
  resolver: HostedChildEnvironmentValueResolverPort
): Promise<BuildHostedChildEnvironmentResult> {
  if (!isRecord(request)) return reject('invalid_contract');
  if (
    'processEnvironment' in request ||
    'shellEnvironment' in request ||
    'inheritedEnvironment' in request ||
    'inheritance' in request
  ) {
    return reject('environment_inheritance_forbidden');
  }
  if (!isExactRecord(request, ['credentialExposureSet', 'identity', 'policy'])) {
    return reject('invalid_contract');
  }

  const admitted = admitHostedChildEnvironmentPolicy(request.policy);
  if (admitted.status === 'rejected') return admitted;
  const identity = parseExactIdentity(request.identity, admitted.policy.identity);
  if (identity.status === 'rejected') return identity;
  const exposure = validateHostedChildCredentialExposureSet(
    admitted.policy,
    request.credentialExposureSet
  );
  if (exposure.status === 'rejected') return exposure;

  const environment: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const variable of admitted.policy.variables) {
    let resolution: HostedChildEnvironmentValueResolution;
    try {
      resolution =
        variable.provenance === 'secret_ref'
          ? await resolver.resolveProviderSecret({ identity: identity.value, variable })
          : await resolver.resolveNonSecret({ identity: identity.value, variable });
    } catch {
      return reject('value_resolution_failed', variable.name);
    }
    if (!isValueResolution(resolution)) {
      return reject('value_resolution_failed', variable.name);
    }
    if (resolution.status === 'rejected') {
      return reject('value_resolution_failed', variable.name);
    }
    if (!isSafeEnvironmentValue(resolution.value)) {
      return reject('resolved_value_invalid', variable.name);
    }
    if (Object.hasOwn(environment, variable.name)) {
      return reject('duplicate_key', variable.name);
    }
    environment[variable.name] = resolution.value;
  }

  const output: BuiltHostedChildEnvironment = {
    identity: admitted.policy.identity,
    keyProvenanceHash: admitted.policy.keyProvenanceHash,
    credentialExposureSet: exposure.exposureSet,
    environment: Object.freeze(environment),
  };
  return Object.freeze({ status: 'accepted', output: deepFreeze(output) });
}

function parseExactIdentity(
  candidate: unknown,
  expected: HostedChildEnvironmentIdentity
):
  | { readonly status: 'accepted'; readonly value: HostedChildEnvironmentIdentity }
  | { readonly status: 'rejected'; readonly error: HostedChildEnvironmentPolicyError } {
  if (!isExactRecord(candidate, ['backend', 'executionUnitId', 'laneId', 'providerId', 'runId'])) {
    return reject('invalid_contract');
  }
  const identity = candidate as unknown as HostedChildEnvironmentIdentity;
  if (!hostedChildEnvironmentIdentitiesEqual(identity, expected)) {
    return reject('identity_mismatch');
  }
  return Object.freeze({ status: 'accepted', value: expected });
}

function isValueResolution(value: unknown): value is HostedChildEnvironmentValueResolution {
  if (!isRecord(value)) return false;
  if (value.status === 'resolved') {
    return isExactRecord(value, ['status', 'value']) && typeof value.value === 'string';
  }
  return (
    value.status === 'rejected' &&
    isExactRecord(value, ['reason', 'status']) &&
    (value.reason === 'unavailable' ||
      value.reason === 'not_authorized' ||
      value.reason === 'invalid')
  );
}

function isSafeEnvironmentValue(value: string): boolean {
  return value.length <= 1_048_576 && !value.includes('\u0000');
}

function reject(
  code: HostedChildEnvironmentPolicyError['code'],
  key?: string
): { readonly status: 'rejected'; readonly error: HostedChildEnvironmentPolicyError } {
  return Object.freeze({
    status: 'rejected',
    error: Object.freeze(key === undefined ? { code } : { code, key }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}
