import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { createHash } from 'crypto';
import { realpathSync } from 'fs';

import { normalizeOpenCodeProjectIdentity } from './OpenCodeProjectIdentity';

import type { OpenCodeExecutionProof } from './OpenCodeExecutionProof';
import type { OpenCodeTeamLaunchReadiness } from './OpenCodeTeamLaunchReadiness';

const EXPECTED_BEHAVIOR_DOMAIN = 'agent-teams.opencode.expected-behavior/v2';
const LOWERCASE_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION = 2 as const;

export interface OpenCodeExpectedBehaviorEvidenceV2 {
  canonicalProjectPathFingerprint: string;
  modelProviderId: string;
  fullModelId: string;
  projectBehaviorFingerprint: string;
  effectiveConfigFingerprint: string;
  effectiveSelectedAuthFingerprint: string;
  expectedBehaviorFingerprint: string;
}

export interface OpenCodeExpectedBehaviorTuple {
  canonicalProjectPathFingerprint: string;
  modelProviderId: string;
  fullModelId: string;
  projectBehaviorFingerprint: string;
  effectiveConfigFingerprint: string;
  effectiveSelectedAuthFingerprint: string;
}

interface OpenCodeReadinessIdentity {
  projectPath: string;
  selectedModel: string | null;
  requireExecutionProbe: boolean;
}

export function openCodeReadinessArtifactKey(input: OpenCodeReadinessIdentity): string {
  return JSON.stringify([
    normalizeOpenCodeProjectIdentity(input.projectPath),
    input.selectedModel?.trim() ?? null,
    input.requireExecutionProbe,
  ]);
}

export function reusableOpenCodeExecutionProof(
  readiness: OpenCodeTeamLaunchReadiness | undefined,
  input: OpenCodeReadinessIdentity
): OpenCodeExecutionProof | null {
  const proof = readiness?.executionProof;
  const fullModelId = input.selectedModel;
  if (
    !proof ||
    !fullModelId ||
    !proof.reusable ||
    (proof.credentialMode !== 'api' && proof.credentialMode !== 'none')
  ) {
    return null;
  }
  const expiresAt = Date.parse(proof.expiresAt);
  if (
    proof.modelId !== readiness?.modelId ||
    normalizeOpenCodeProjectIdentity(proof.projectPath) !==
      normalizeOpenCodeProjectIdentity(input.projectPath) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() + 1_000
  ) {
    return null;
  }
  try {
    validateOpenCodeExpectedBehaviorEvidence({
      evidence: proof.expectedBehaviorEvidence,
      executionProof: proof,
      projectPath: input.projectPath,
      fullModelId,
    });
    return proof;
  } catch {
    return null;
  }
}

export function freshOpenCodeExecutionProof(
  readiness: OpenCodeTeamLaunchReadiness | undefined,
  input: { projectPath: string; fullModelId: string }
): { proof: OpenCodeExecutionProof; expectedBehaviorFingerprint: string } {
  const proof = readiness?.executionProof;
  if (!proof || proof.modelId !== input.fullModelId) {
    throw new Error(
      'OpenCode launch requires fresh expected behavior evidence for the selected model'
    );
  }
  if (
    normalizeOpenCodeProjectIdentity(proof.projectPath) !==
      normalizeOpenCodeProjectIdentity(input.projectPath) ||
    !Number.isFinite(Date.parse(proof.expiresAt)) ||
    Date.parse(proof.expiresAt) <= Date.now()
  ) {
    throw new Error(
      'OpenCode launch expected behavior evidence is stale or belongs to another project'
    );
  }
  const evidence = validateOpenCodeExpectedBehaviorEvidence({
    evidence: proof.expectedBehaviorEvidence,
    executionProof: proof,
    projectPath: input.projectPath,
    fullModelId: input.fullModelId,
  });
  return { proof, expectedBehaviorFingerprint: evidence.expectedBehaviorFingerprint };
}

export function createOpenCodeExpectedBehaviorFingerprint(
  tuple: OpenCodeExpectedBehaviorTuple
): string {
  return sha256(
    JSON.stringify([
      EXPECTED_BEHAVIOR_DOMAIN,
      tuple.canonicalProjectPathFingerprint,
      tuple.modelProviderId,
      tuple.fullModelId,
      tuple.projectBehaviorFingerprint,
      tuple.effectiveConfigFingerprint,
      tuple.effectiveSelectedAuthFingerprint,
    ])
  );
}

export function createOpenCodeCanonicalProjectPathFingerprint(projectPath: string): string {
  let canonicalProjectPath = projectPath;
  try {
    canonicalProjectPath = realpathSync(projectPath);
  } catch {
    // Unit/disposable paths may not exist; proof.projectPath still binds the exact request identity.
  }
  return sha256(normalizeOpenCodeProjectIdentity(canonicalProjectPath));
}

export function createOpenCodeExecutionProofHash(
  proof: Omit<OpenCodeExecutionProof, 'proofHash'>
): string {
  return sha256(stableJson(proof));
}

export function parseOpenCodeExpectedBehaviorEvidence(
  value: unknown
): OpenCodeExpectedBehaviorEvidenceV2 {
  if (!isRecord(value)) {
    throw new Error('OpenCode expected behavior evidence v2 object is required');
  }

  const expectedKeys = [
    'canonicalProjectPathFingerprint',
    'modelProviderId',
    'fullModelId',
    'projectBehaviorFingerprint',
    'effectiveConfigFingerprint',
    'effectiveSelectedAuthFingerprint',
    'expectedBehaviorFingerprint',
  ];
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length || !expectedKeys.every((key) => keys.includes(key))) {
    throw new Error('OpenCode expected behavior evidence v2 fields are invalid');
  }

  const fingerprintFields = [
    'canonicalProjectPathFingerprint',
    'projectBehaviorFingerprint',
    'effectiveConfigFingerprint',
    'effectiveSelectedAuthFingerprint',
    'expectedBehaviorFingerprint',
  ] as const;
  for (const field of fingerprintFields) {
    if (!isLowercaseSha256(value[field])) {
      throw new Error(`OpenCode expected behavior evidence ${field} must be lowercase SHA-256`);
    }
  }

  if (
    typeof value.modelProviderId !== 'string' ||
    !value.modelProviderId ||
    value.modelProviderId !== value.modelProviderId.toLowerCase() ||
    !/^[a-z0-9._-]+$/.test(value.modelProviderId)
  ) {
    throw new Error(
      'OpenCode expected behavior evidence modelProviderId must be canonical lowercase'
    );
  }
  if (typeof value.fullModelId !== 'string' || !value.fullModelId) {
    throw new Error('OpenCode expected behavior evidence fullModelId is required');
  }

  const evidence = value as unknown as OpenCodeExpectedBehaviorEvidenceV2;
  if (
    createOpenCodeExpectedBehaviorFingerprint(evidence) !== evidence.expectedBehaviorFingerprint
  ) {
    throw new Error('OpenCode expected behavior fingerprint digest mismatch');
  }
  return evidence;
}

export function validateOpenCodeExpectedBehaviorEvidence(input: {
  evidence: unknown;
  executionProof: OpenCodeExecutionProof;
  projectPath: string;
  fullModelId: string;
}): OpenCodeExpectedBehaviorEvidenceV2 {
  const evidence = parseOpenCodeExpectedBehaviorEvidence(input.evidence);
  const { proofHash, ...unsignedProof } = input.executionProof;
  if (
    !isLowercaseSha256(proofHash) ||
    createOpenCodeExecutionProofHash(unsignedProof) !== proofHash
  ) {
    throw new Error('OpenCode expected behavior evidence proof hash mismatch');
  }
  if (
    input.executionProof.schemaVersion !== 1 ||
    input.executionProof.providerId !== 'opencode' ||
    input.executionProof.modelId !== input.fullModelId
  ) {
    throw new Error('OpenCode expected behavior evidence execution proof model mismatch');
  }
  if (evidence.projectBehaviorFingerprint !== input.executionProof.projectBehaviorFingerprint) {
    throw new Error('OpenCode expected behavior evidence project behavior fingerprint mismatch');
  }
  if (
    normalizeOpenCodeProjectIdentity(input.executionProof.projectPath) !==
    normalizeOpenCodeProjectIdentity(input.projectPath)
  ) {
    throw new Error('OpenCode expected behavior evidence execution proof project mismatch');
  }

  const parsedModel = parseOpenCodeQualifiedModelRef(input.fullModelId);
  if (!parsedModel || parsedModel.raw !== input.fullModelId) {
    throw new Error('OpenCode launch requires an exact qualified selected model');
  }
  if (evidence.fullModelId !== input.fullModelId) {
    throw new Error('OpenCode expected behavior evidence model mismatch');
  }
  if (evidence.modelProviderId !== parsedModel.sourceId) {
    throw new Error('OpenCode expected behavior evidence model provider mismatch');
  }
  if (
    evidence.canonicalProjectPathFingerprint !==
    createOpenCodeCanonicalProjectPathFingerprint(input.projectPath)
  ) {
    throw new Error('OpenCode expected behavior evidence project mismatch');
  }
  return evidence;
}

export function isLowercaseSha256(value: unknown): value is string {
  return typeof value === 'string' && LOWERCASE_SHA256_PATTERN.test(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
