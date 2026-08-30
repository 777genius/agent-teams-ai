import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import {
  createOpenCodeCanonicalProjectPathFingerprint,
  createOpenCodeExecutionProofHash,
  createOpenCodeExpectedBehaviorFingerprint,
  parseOpenCodeExpectedBehaviorEvidence,
  reusableOpenCodeExecutionProof,
  validateOpenCodeExpectedBehaviorEvidence,
} from '../../../../src/main/services/team/opencode/readiness/OpenCodeExpectedBehaviorFingerprint';

import type { OpenCodeExecutionProof } from '../../../../src/main/services/team/opencode/readiness/OpenCodeExecutionProof';
import type { OpenCodeTeamLaunchReadiness } from '../../../../src/main/services/team/opencode/readiness/OpenCodeTeamLaunchReadiness';

interface GoldenCase {
  name: string;
  canonicalProjectPathFingerprint: string;
  modelProviderId: string;
  fullModelId: string;
  projectBehaviorFingerprint: string;
  effectiveConfigFingerprint: string;
  effectiveSelectedAuthFingerprint: string;
  expectedBehaviorFingerprint: string;
}

describe('OpenCodeExpectedBehaviorFingerprint', () => {
  it('produces every committed issue 443 golden digest exactly', () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve('test/fixtures/team/opencode/expected-behavior-fingerprint-v2.json'),
        'utf8'
      )
    ) as { cases: GoldenCase[] };

    for (const golden of fixture.cases) {
      expect(createOpenCodeExpectedBehaviorFingerprint(golden), golden.name).toBe(
        golden.expectedBehaviorFingerprint
      );
    }
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['uppercase', 'A'.repeat(64)],
    ['63 characters', 'a'.repeat(63)],
    ['65 characters', 'a'.repeat(65)],
  ])('rejects a %s fingerprint field', (_name, invalid) => {
    expect(() =>
      parseOpenCodeExpectedBehaviorEvidence({
        ...validEvidence(),
        effectiveConfigFingerprint: invalid,
      })
    ).toThrow('effectiveConfigFingerprint must be lowercase SHA-256');
  });

  it('rejects a wrong recomputed digest and a mismatched proof hash', () => {
    expect(() =>
      parseOpenCodeExpectedBehaviorEvidence({
        ...validEvidence(),
        expectedBehaviorFingerprint: 'f'.repeat(64),
      })
    ).toThrow('digest mismatch');
    expect(() =>
      validateOpenCodeExpectedBehaviorEvidence({
        evidence: validEvidence(),
        executionProof: { ...validProof(), proofHash: '9'.repeat(64) },
        projectPath: '/disposable/project',
        fullModelId: 'deepinfra/deepseek-ai/DeepSeek-V3.2',
      })
    ).toThrow('proof hash mismatch');
  });

  it('rejects a schema v1 digest without compatibility fallback', () => {
    expect(() =>
      parseOpenCodeExpectedBehaviorEvidence({
        ...validEvidence(),
        expectedBehaviorFingerprint:
          'fc23fcd9418b882aefe66d1b1a11e5fbe9ab702174c6b9be92a7832bdd2fc60d',
      })
    ).toThrow('digest mismatch');
  });

  it.each([
    ['project', '/different/project', 'deepinfra/deepseek-ai/DeepSeek-V3.2'],
    ['model', '/disposable/project', 'deepinfra/deepseek-ai/DeepSeek-V3.3'],
  ])('rejects a %s identity mismatch', (_name, projectPath, fullModelId) => {
    expect(() =>
      validateOpenCodeExpectedBehaviorEvidence({
        evidence: validEvidence(),
        executionProof: validProof(),
        projectPath,
        fullModelId,
      })
    ).toThrow(/mismatch/);
  });

  it('rejects a model provider that does not match the qualified selected model', () => {
    const changed = { ...validEvidence(), modelProviderId: 'custom' };
    changed.expectedBehaviorFingerprint = createOpenCodeExpectedBehaviorFingerprint(changed);
    expect(() =>
      validateOpenCodeExpectedBehaviorEvidence({
        evidence: changed,
        executionProof: validProof(changed),
        projectPath: '/disposable/project',
        fullModelId: 'deepinfra/deepseek-ai/DeepSeek-V3.2',
      })
    ).toThrow('model provider mismatch');
  });

  it('rejects independently valid evidence and proof hashes with unequal project behavior fingerprints', () => {
    const changed = { ...validEvidence(), projectBehaviorFingerprint: '8'.repeat(64) };
    changed.expectedBehaviorFingerprint = createOpenCodeExpectedBehaviorFingerprint(changed);
    expect(() =>
      validateOpenCodeExpectedBehaviorEvidence({
        evidence: changed,
        executionProof: validProof(changed),
        projectPath: '/disposable/project',
        fullModelId: 'deepinfra/deepseek-ai/DeepSeek-V3.2',
      })
    ).toThrow('project behavior fingerprint mismatch');
  });

  it('accepts an exact proof-bound project, provider, model and digest', () => {
    expect(
      validateOpenCodeExpectedBehaviorEvidence({
        evidence: validEvidence(),
        executionProof: validProof(),
        projectPath: '/disposable/project',
        fullModelId: 'deepinfra/deepseek-ai/DeepSeek-V3.2',
      }).expectedBehaviorFingerprint
    ).toHaveLength(64);
  });

  it('reuses only a valid cached proof bound to the requested identity', () => {
    const proof = validProof();
    expect(reusableOpenCodeExecutionProof(cachedReadiness(proof), validReuseInput())).toBe(proof);
  });

  it.each([
    ['missing evidence', () => changedProof({ expectedBehaviorEvidence: undefined }), {}],
    ['uppercase evidence', () => changedProof({
      expectedBehaviorEvidence: { ...validEvidence(), effectiveConfigFingerprint: 'A'.repeat(64) },
    }), {}],
    ['malformed evidence', () => changedProof({ expectedBehaviorEvidence: null }), {}],
    ['extra-field evidence', () => changedProof({
      expectedBehaviorEvidence: { ...validEvidence(), unexpected: true },
    }), {}],
    ['digest mismatch', () => changedProof({
      expectedBehaviorEvidence: { ...validEvidence(), expectedBehaviorFingerprint: 'f'.repeat(64) },
    }), {}],
    ['requested project mismatch', () => validProof(), { projectPath: '/different/project' }],
    ['requested full-model mismatch', () => validProof(), { selectedModel: 'deepinfra/other' }],
    ['requested provider mismatch', () => {
      const evidence = { ...validEvidence(), modelProviderId: 'custom' };
      evidence.expectedBehaviorFingerprint = createOpenCodeExpectedBehaviorFingerprint(evidence);
      return changedProof({ expectedBehaviorEvidence: evidence });
    }, {}],
    ['proofHash mismatch', () => ({ ...validProof(), proofHash: '9'.repeat(64) }), {}],
    ['expired proof', () => changedProof({ expiresAt: '2020-01-01T00:00:00.000Z' }), {}],
  ])('rejects cached %s', (_name, buildProof, inputChanges) => {
    const proof = buildProof();
    expect(
      reusableOpenCodeExecutionProof(cachedReadiness(proof), {
        ...validReuseInput(),
        ...inputChanges,
      })
    ).toBeNull();
  });

  it('rejects stale config or auth evidence after either fingerprint changes', () => {
    for (const field of ['effectiveConfigFingerprint', 'effectiveSelectedAuthFingerprint'] as const) {
      expect(() =>
        parseOpenCodeExpectedBehaviorEvidence({ ...validEvidence(), [field]: '0'.repeat(64) })
      ).toThrow('digest mismatch');
    }
  });
});

function validEvidence() {
  const tuple = {
    canonicalProjectPathFingerprint:
      createOpenCodeCanonicalProjectPathFingerprint('/disposable/project'),
    modelProviderId: 'deepinfra',
    fullModelId: 'deepinfra/deepseek-ai/DeepSeek-V3.2',
    projectBehaviorFingerprint: '5'.repeat(64),
    effectiveConfigFingerprint: '6'.repeat(64),
    effectiveSelectedAuthFingerprint: '7'.repeat(64),
  };
  return {
    ...tuple,
    expectedBehaviorFingerprint: createOpenCodeExpectedBehaviorFingerprint(tuple),
  };
}

function validProof(expectedBehaviorEvidence = validEvidence()) {
  const unsigned = {
    schemaVersion: 1 as const,
    providerId: 'opencode' as const,
    modelId: 'deepinfra/deepseek-ai/DeepSeek-V3.2',
    projectPath: '/disposable/project',
    profileRootKey: 'profile-root',
    projectBehaviorFingerprint: '5'.repeat(64),
    managedConfigFingerprint: 'managed-config',
    managedAuthFingerprint: 'managed-auth',
    binaryPath: '/disposable/opencode',
    binaryFingerprint: 'binary',
    opencodeVersion: '1.0.0',
    capabilitySnapshotId: 'snapshot',
    credentialMode: 'api' as const,
    reusable: true,
    verifiedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2099-08-29T00:00:00.000Z',
    expectedBehaviorEvidence,
  };
  return { ...unsigned, proofHash: createOpenCodeExecutionProofHash(unsigned) };
}

function changedProof(
  changes: Partial<Omit<OpenCodeExecutionProof, 'proofHash'>>
): OpenCodeExecutionProof {
  const { proofHash: _proofHash, ...unsigned } = validProof();
  const changed = { ...unsigned, ...changes };
  return { ...changed, proofHash: createOpenCodeExecutionProofHash(changed) };
}

function cachedReadiness(proof: OpenCodeExecutionProof): OpenCodeTeamLaunchReadiness {
  return { executionProof: proof, modelId: proof.modelId } as OpenCodeTeamLaunchReadiness;
}

function validReuseInput() {
  return {
    projectPath: '/disposable/project',
    selectedModel: 'deepinfra/deepseek-ai/DeepSeek-V3.2',
    requireExecutionProbe: true,
  };
}
