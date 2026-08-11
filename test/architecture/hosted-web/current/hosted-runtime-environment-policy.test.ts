import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- The executable current-HEAD policy gate is intentionally authored as MJS.
import * as policyVerifier from '../../../../scripts/ci/verify-hosted-runtime-environment-policy.mjs';

const { discoverHostedLifecycleEnvironmentAccesses, verifyHostedRuntimeEnvironmentPolicy } =
  policyVerifier;

interface PolicyEntry {
  name: string;
  role: string;
  secretClass: string;
  redactionRule: string;
  providerChildExposure: string;
  sourceAuthority: string[];
}

interface Policy {
  format: string;
  schemaVersion: number;
  authority: string;
  environmentKeyPrefix: string;
  entries: PolicyEntry[];
}

const policyPath = 'scripts/ci/hosted-runtime-environment-policy.json';
const rawTrustAnchor = 'HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR';

function policy(): Policy {
  return JSON.parse(readFileSync(policyPath, 'utf8')) as Policy;
}

function clonedPolicy(): Policy {
  return structuredClone(policy());
}

function entry(document: Policy, name: string): PolicyEntry {
  const match = document.entries.find((candidate) => candidate.name === name);
  if (match === undefined) throw new Error(`missing policy entry ${name}`);
  return match;
}

describe('current hosted lifecycle runtime environment policy', () => {
  it('covers every current source access with exact source authority and no secret values', () => {
    const document = policy();
    const discovered = discoverHostedLifecycleEnvironmentAccesses();

    expect([...discovered.keys()]).toEqual(document.entries.map((candidate) => candidate.name));
    expect(verifyHostedRuntimeEnvironmentPolicy({ policy: document })).toEqual({
      format: 'agent-teams.hosted-runtime-environment-policy-verifier-result/v1',
      status: 'passed',
      summary: { discoveredKeys: 12, policyEntries: 12, violations: 0 },
      violations: [],
    });
    expect(
      document.entries.every(
        (candidate) =>
          Object.keys(candidate).sort().join(',') ===
          'name,providerChildExposure,redactionRule,role,secretClass,sourceAuthority'
      )
    ).toBe(true);
  });

  it('classifies the HMAC material, reference path, and non-secret test gate exactly', () => {
    const document = policy();

    expect(entry(document, rawTrustAnchor)).toMatchObject({
      role: 'authentication_material',
      secretClass: 'hmac_authentication_key',
      redactionRule: 'name_only',
      providerChildExposure: 'forbidden',
    });
    expect(entry(document, `${rawTrustAnchor}_FILE`)).toMatchObject({
      role: 'authentication_secret_reference',
      secretClass: 'secret_reference_path',
      redactionRule: 'name_only',
      providerChildExposure: 'forbidden',
    });
    expect(
      entry(document, 'HOSTED_LIFECYCLE_ORCHESTRATOR_TEST_ONLY_INLINE_TRUST_ANCHOR')
    ).toMatchObject({
      role: 'test_gate',
      secretClass: 'none',
      redactionRule: 'not_applicable',
      providerChildExposure: 'forbidden',
    });
  });

  it('rejects a secret classification downgrade', () => {
    const document = clonedPolicy();
    entry(document, rawTrustAnchor).secretClass = 'none';

    expect(verifyHostedRuntimeEnvironmentPolicy({ policy: document }).violations).toContain(
      `policy_entry:${rawTrustAnchor}:secretClass_semantic_downgrade`
    );
  });

  it('rejects an omitted policy entry', () => {
    const document = clonedPolicy();
    document.entries = document.entries.filter((candidate) => candidate.name !== rawTrustAnchor);

    expect(verifyHostedRuntimeEnvironmentPolicy({ policy: document }).violations).toContain(
      `coverage:missing_policy_entry:${rawTrustAnchor}`
    );
  });

  it('rejects a duplicate policy entry', () => {
    const document = clonedPolicy();
    document.entries.push(structuredClone(entry(document, rawTrustAnchor)));

    expect(verifyHostedRuntimeEnvironmentPolicy({ policy: document }).violations).toContain(
      `policy_entry:${rawTrustAnchor}:duplicate`
    );
  });

  it('rejects stale source authority', () => {
    const document = clonedPolicy();
    entry(document, rawTrustAnchor).sourceAuthority = ['src/main/index.ts'];

    expect(verifyHostedRuntimeEnvironmentPolicy({ policy: document }).violations).toContain(
      `policy_entry:${rawTrustAnchor}:source_authority_stale`
    );
  });

  it('rejects provider-child exposure', () => {
    const document = clonedPolicy();
    entry(document, rawTrustAnchor).providerChildExposure = 'allowed';

    expect(verifyHostedRuntimeEnvironmentPolicy({ policy: document }).violations).toContain(
      `policy_entry:${rawTrustAnchor}:provider_child_exposure_forbidden`
    );
  });
});
