import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import {
  createOpenCodeCanonicalProjectPathFingerprint,
  createOpenCodeExecutionProofHash,
  createOpenCodeExpectedBehaviorFingerprint,
  parseOpenCodeExpectedBehaviorEvidence,
  validateOpenCodeExpectedBehaviorEvidence,
} from '../../../../src/main/services/team/opencode/readiness/OpenCodeExpectedBehaviorFingerprint';

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
        resolve('test/fixtures/team/opencode/expected-behavior-fingerprint-v1.json'),
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
