import { stableJsonStringify } from '@features/application-command-ledger';
import { normalizeEffectiveLaunchIdentity } from '@shared/utils/effectiveLaunchIdentity';
import {
  buildEffectiveRuntimeRosterRevision,
  resolveEffectiveMemberRuntimeIdentity,
} from '@shared/utils/effectiveMemberRuntimeIdentity';
import {
  isResolvedLeadRuntimeSelectionProvenance,
  resolveLeadRuntimeSelectionProvenance,
} from '@shared/utils/teamMemberRuntimeSelectionProvenance';
import { createHash, randomUUID } from 'crypto';
import * as path from 'path';

import {
  canonicalProjectPathComparisonKey,
  captureProjectRootIdentityLease,
} from './ProjectRootIdentityLease';
import * as providerAuthority from './TeamLaunchProviderAuthorityGeneration';

import type { ProjectRootIdentity, ProjectRootIdentityLease } from './ProjectRootIdentityLease';
import type {
  AuthoritativeModelExecutionProof,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamLeadRuntimeSelectionProvenance,
  TeamMember,
  TeamProvisioningModelCheckRequest,
} from '@shared/types';
import type { ProviderModelLaunchIdentity } from '@shared/types';

export interface OpaqueLeadRuntimeRestartProof {
  readonly opaque: string;
}

export interface LeadRuntimeRestartProofBinding {
  teamName: string;
  cwd: string;
  runId: string;
  providerId: ProviderModelLaunchIdentity['providerId'];
  providerBackendId: ProviderModelLaunchIdentity['providerBackendId'];
  selectedModel: ProviderModelLaunchIdentity['selectedModel'];
  selectedModelKind: ProviderModelLaunchIdentity['selectedModelKind'];
  resolvedLaunchModel: ProviderModelLaunchIdentity['resolvedLaunchModel'];
  selectedEffort: ProviderModelLaunchIdentity['selectedEffort'];
  resolvedEffort: ProviderModelLaunchIdentity['resolvedEffort'];
  leadTargetFingerprint: string;
  leadRuntimeSelectionProvenance: TeamLeadRuntimeSelectionProvenance;
  launchIdentity: ProviderModelLaunchIdentity;
}

const PROOF_TTL_MS = 60_000;
const authorityEpochBrand: unique symbol = Symbol('authoritative-proof-epoch');

/** Opaque process-local attempt owning the root lease captured before asynchronous preparation. */
export interface AuthoritativeProofEpoch {
  readonly [authorityEpochBrand]: true;
}

interface AuthoritativeAttemptRecord {
  authorityEpoch: object;
  expiresAtMs: number;
  projectLease: ProjectRootIdentityLease;
  providerAuthorityGenerations: ReadonlyMap<ProviderModelLaunchIdentity['providerId'], number>;
}

interface AuthoritativeExecutionRecord {
  proof: AuthoritativeModelExecutionProof;
  expiresAtMs: number;
  projectLease: ProjectRootIdentityLease;
  checks: ReturnType<typeof normalizeChecks>;
  runtimeRosterRevision: string | null;
  authorityEpoch: object;
}

interface ClaimedExecutionRecord {
  expiresAtMs: number;
  projectLease: ProjectRootIdentityLease;
  authorityEpoch: object;
  stale: boolean;
  invocationActive: boolean;
  closed: boolean;
  providerIds: ReadonlySet<ProviderModelLaunchIdentity['providerId']>;
}

export interface AuthoritativeModelExecutionInvocationLease {
  isCurrent(nowMs?: number): boolean;
  beginInvocation<T>(invocation: () => T): { started: false } | { started: true; value: T };
  close(): void;
}

interface LeadRestartExecutionRecord {
  binding: ReturnType<typeof normalizeLeadRestartBinding>;
  bindingDigest: string;
  teamRunKey: string;
  expiresAtMs: number;
  projectLease: ProjectRootIdentityLease;
  authorityEpoch: object;
}

interface ClaimedLeadRestartRecord extends LeadRestartExecutionRecord {
  stale: boolean;
  closed: boolean;
}

export interface LeadRuntimeRestartInvocationLease {
  readonly launchIdentity: ProviderModelLaunchIdentity;
  readonly leadRuntimeSelectionProvenance: TeamLeadRuntimeSelectionProvenance;
  isCurrent(nowMs?: number): boolean;
  close(): void;
}

const attempts = new Map<AuthoritativeProofEpoch, AuthoritativeAttemptRecord>();
const proofs = new Map<string, AuthoritativeExecutionRecord>();
const claimedExecutionLeases = new Set<ClaimedExecutionRecord>();
const leadRestartProofs = new Map<string, LeadRestartExecutionRecord>();
const claimedLeadRestartLeases = new Set<ClaimedLeadRestartRecord>();
let generation = 0;
let currentAuthorityEpoch: object = {};
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let rootAuthorityOpen = true;

function createAuthorityAttempt(): AuthoritativeProofEpoch {
  return Object.freeze({ [authorityEpochBrand]: true }) as AuthoritativeProofEpoch;
}

export function captureAuthoritativeProofEpoch(
  cwd: string,
  nowMs = Date.now()
): AuthoritativeProofEpoch {
  if (!rootAuthorityOpen) {
    throw new Error('Launch authorization is unavailable during Claude root handoff');
  }
  const attempt = createAuthorityAttempt();
  const record = {
    authorityEpoch: currentAuthorityEpoch,
    expiresAtMs: nowMs + PROOF_TTL_MS,
    projectLease: captureProjectRootIdentityLease(cwd),
    providerAuthorityGenerations: providerAuthority.captureGenerations(),
  };
  attempts.set(attempt, record);
  scheduleExpiryCleanup();
  return attempt;
}

export function releaseAuthoritativeProofEpoch(attempt: AuthoritativeProofEpoch): void {
  const record = attempts.get(attempt);
  if (!record) return;
  attempts.delete(attempt);
  record.projectLease.close();
  scheduleExpiryCleanup();
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value)).digest('hex');
}

function normalizeChecks(checks: readonly TeamProvisioningModelCheckRequest[]) {
  const normalized = checks.map((check) => ({
    providerId: check.providerId,
    providerBackendId: check.providerBackendId ?? null,
    model: check.model.trim(),
    effort: check.effort ?? null,
  }));
  return Array.from(
    new Map(normalized.map((check) => [stableJsonStringify(check), check])).values()
  ).sort((left, right) => stableJsonStringify(left).localeCompare(stableJsonStringify(right)));
}

function normalizeProjectPath(cwd: string): string {
  return canonicalProjectPathComparisonKey(path.resolve(cwd.trim()));
}

export { canonicalProjectPathComparisonKey };

function deleteExecutionProof(
  authorityId: string,
  record: AuthoritativeExecutionRecord,
  reschedule = true
): void {
  if (proofs.get(authorityId) !== record) return;
  proofs.delete(authorityId);
  record.projectLease.close();
  if (reschedule) scheduleExpiryCleanup();
}

function closeClaimedExecutionRecord(record: ClaimedExecutionRecord): void {
  if (record.closed || record.invocationActive) return;
  record.closed = true;
  claimedExecutionLeases.delete(record);
  record.projectLease.close();
}

function invalidateClaimedExecutionRecord(record: ClaimedExecutionRecord): void {
  record.stale = true;
  closeClaimedExecutionRecord(record);
}

function claimedExecutionRecordIsCurrent(
  record: ClaimedExecutionRecord,
  nowMs = Date.now()
): boolean {
  if (
    record.closed ||
    record.stale ||
    record.authorityEpoch !== currentAuthorityEpoch ||
    record.expiresAtMs <= nowMs
  ) {
    invalidateClaimedExecutionRecord(record);
    return false;
  }
  if (!record.projectLease.isCurrent()) {
    invalidateClaimedExecutionRecord(record);
    return false;
  }
  return true;
}

function deleteLeadRestartProof(
  opaque: string,
  record: LeadRestartExecutionRecord,
  reschedule = true
): void {
  if (leadRestartProofs.get(opaque) !== record) return;
  leadRestartProofs.delete(opaque);
  record.projectLease.close();
  if (reschedule) scheduleExpiryCleanup();
}

function closeClaimedLeadRestartRecord(record: ClaimedLeadRestartRecord): void {
  if (record.closed) return;
  record.closed = true;
  claimedLeadRestartLeases.delete(record);
  record.projectLease.close();
}

function claimedLeadRestartRecordIsCurrent(
  record: ClaimedLeadRestartRecord,
  nowMs = Date.now()
): boolean {
  if (
    record.closed ||
    record.stale ||
    record.authorityEpoch !== currentAuthorityEpoch ||
    record.expiresAtMs <= nowMs ||
    !record.projectLease.isCurrent()
  ) {
    record.stale = true;
    return false;
  }
  return true;
}

function nextExpiryMs(): number | null {
  let next: number | null = null;
  for (const record of attempts.values()) next = Math.min(next ?? Infinity, record.expiresAtMs);
  for (const record of proofs.values()) next = Math.min(next ?? Infinity, record.expiresAtMs);
  for (const record of claimedExecutionLeases) {
    next = Math.min(next ?? Infinity, record.expiresAtMs);
  }
  for (const record of leadRestartProofs.values()) {
    next = Math.min(next ?? Infinity, record.expiresAtMs);
  }
  return next;
}

function sweepExpiredAuthority(nowMs: number): void {
  for (const [attempt, record] of attempts) {
    if (record.expiresAtMs <= nowMs) {
      attempts.delete(attempt);
      record.projectLease.close();
    }
  }
  for (const [authorityId, record] of proofs) {
    if (record.expiresAtMs <= nowMs) deleteExecutionProof(authorityId, record, false);
  }
  for (const record of claimedExecutionLeases) {
    if (record.expiresAtMs <= nowMs) invalidateClaimedExecutionRecord(record);
  }
  for (const [opaque, record] of leadRestartProofs) {
    if (record.expiresAtMs <= nowMs) deleteLeadRestartProof(opaque, record, false);
  }
  for (const record of claimedLeadRestartLeases) {
    if (record.expiresAtMs <= nowMs) record.stale = true;
  }
}

function scheduleExpiryCleanup(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  const next = nextExpiryMs();
  if (next === null) return;
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null;
      sweepExpiredAuthority(Date.now());
      scheduleExpiryCleanup();
    },
    Math.max(0, next - Date.now())
  );
  expiryTimer.unref?.();
}

function claimAttemptLease(
  attempt: AuthoritativeProofEpoch,
  cwd: string,
  nowMs: number,
  purpose: 'Launch authorization' | 'Lead restart authorization',
  providerIds: ReadonlySet<ProviderModelLaunchIdentity['providerId']>
): { authorityEpoch: object; projectLease: ProjectRootIdentityLease } {
  const record = attempts.get(attempt);
  if (!record || record.authorityEpoch !== currentAuthorityEpoch) {
    throw new Error(`${purpose} epoch changed during preparation`);
  }
  if (record.expiresAtMs <= nowMs || !record.projectLease.isCurrent(cwd)) {
    attempts.delete(attempt);
    record.projectLease.close();
    scheduleExpiryCleanup();
    throw new Error(`${purpose} project root changed during preparation`);
  }
  if (!providerAuthority.generationsAreCurrent(record.providerAuthorityGenerations, providerIds)) {
    attempts.delete(attempt);
    record.projectLease.close();
    scheduleExpiryCleanup();
    throw new Error(`${purpose} provider authority changed during preparation`);
  }
  attempts.delete(attempt);
  scheduleExpiryCleanup();
  return { authorityEpoch: record.authorityEpoch, projectLease: record.projectLease };
}

export function executionProofRequestDigest(input: {
  cwd: string;
  checks: readonly TeamProvisioningModelCheckRequest[];
  allowExperimentalLocalModels?: boolean;
  runtimeRosterRevision?: string | null;
}): string {
  const projectLease = captureProjectRootIdentityLease(input.cwd);
  try {
    return executionProofRequestDigestForIdentity(input, projectLease.identity);
  } finally {
    projectLease.close();
  }
}

function executionProofRequestDigestForIdentity(
  input: {
    checks: readonly TeamProvisioningModelCheckRequest[];
    allowExperimentalLocalModels?: boolean;
    runtimeRosterRevision?: string | null;
  },
  projectIdentity: ProjectRootIdentity
): string {
  return digest({
    projectIdentity,
    checks: normalizeChecks(input.checks),
    allowExperimentalLocalModels: input.allowExperimentalLocalModels === true,
    runtimeRosterRevision: input.runtimeRosterRevision ?? null,
  });
}

export function issueAuthoritativeModelExecutionProof(input: {
  authorityEpoch: AuthoritativeProofEpoch;
  cwd: string;
  checks: readonly TeamProvisioningModelCheckRequest[];
  allowExperimentalLocalModels?: boolean;
  runtimeRosterRevision?: string | null;
  completedAtMs?: number;
}): AuthoritativeModelExecutionProof {
  if (!rootAuthorityOpen) {
    throw new Error('Launch authorization is unavailable during Claude root handoff');
  }
  const completedAtMs = input.completedAtMs ?? Date.now();
  const checks = normalizeChecks(input.checks);
  const claimed = claimAttemptLease(
    input.authorityEpoch,
    input.cwd,
    Date.now(),
    'Launch authorization',
    new Set(checks.map((check) => check.providerId))
  );
  try {
    const proof: AuthoritativeModelExecutionProof = {
      authorityId: randomUUID(),
      generation: ++generation,
      completedAt: new Date(completedAtMs).toISOString(),
      expiresAt: new Date(completedAtMs + PROOF_TTL_MS).toISOString(),
      requestDigest: executionProofRequestDigestForIdentity(input, claimed.projectLease.identity),
    };
    for (const [authorityId, existing] of proofs) {
      if (existing.proof.requestDigest === proof.requestDigest) {
        deleteExecutionProof(authorityId, existing, false);
      }
    }
    proofs.set(proof.authorityId, {
      proof,
      expiresAtMs: completedAtMs + PROOF_TTL_MS,
      projectLease: claimed.projectLease,
      checks,
      runtimeRosterRevision: input.runtimeRosterRevision ?? null,
      authorityEpoch: claimed.authorityEpoch,
    });
    scheduleExpiryCleanup();
    return proof;
  } catch (error) {
    claimed.projectLease.close();
    throw error;
  }
}

export function invalidateAuthoritativeModelExecutionProofs(): void {
  generation += 1;
  currentAuthorityEpoch = {};
  providerAuthority.invalidateAll();
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  for (const record of attempts.values()) record.projectLease.close();
  for (const record of proofs.values()) record.projectLease.close();
  for (const record of claimedExecutionLeases) invalidateClaimedExecutionRecord(record);
  for (const record of leadRestartProofs.values()) record.projectLease.close();
  for (const record of claimedLeadRestartLeases) record.stale = true;
  attempts.clear();
  proofs.clear();
  claimedExecutionLeases.clear();
  leadRestartProofs.clear();
}

/** Invalidates only execution authority that depends on one provider. */
export function invalidateAuthoritativeModelExecutionProofsForProvider(
  providerId: ProviderModelLaunchIdentity['providerId']
): void {
  providerAuthority.invalidateProvider(providerId);
  for (const [authorityId, record] of proofs) {
    if (record.checks.some((check) => check.providerId === providerId)) {
      deleteExecutionProof(authorityId, record, false);
    }
  }
  for (const record of claimedExecutionLeases) {
    if (record.providerIds.has(providerId)) invalidateClaimedExecutionRecord(record);
  }
  for (const [opaque, record] of leadRestartProofs) {
    if (record.binding.providerId === providerId) deleteLeadRestartProof(opaque, record, false);
  }
  for (const record of claimedLeadRestartLeases) {
    if (record.binding.providerId === providerId) record.stale = true;
  }
  scheduleExpiryCleanup();
}

/** Closes proof capture and issuance until the root coordinator commits a generation. */
export function fenceAuthoritativeModelExecutionProofs(): void {
  rootAuthorityOpen = false;
  invalidateAuthoritativeModelExecutionProofs();
}

export function activateAuthoritativeModelExecutionProofs(): void {
  rootAuthorityOpen = true;
}

/** Read-only seam used by member restart authorization until proof epochs share one owner. */
export { getProviderAuthorityGeneration } from './TeamLaunchProviderAuthorityGeneration';

function normalizeLeadRestartBinding(input: LeadRuntimeRestartProofBinding) {
  return {
    purpose: 'lead_restart',
    teamName: input.teamName.trim(),
    cwd: normalizeProjectPath(input.cwd),
    runId: input.runId,
    providerId: input.providerId,
    providerBackendId: input.providerBackendId ?? null,
    selectedModel: input.selectedModel ?? null,
    selectedModelKind: input.selectedModelKind,
    resolvedLaunchModel: input.resolvedLaunchModel ?? null,
    selectedEffort: input.selectedEffort ?? null,
    resolvedEffort: input.resolvedEffort ?? null,
    leadTargetFingerprint: input.leadTargetFingerprint,
    leadRuntimeSelectionProvenance: input.leadRuntimeSelectionProvenance,
    launchIdentity: input.launchIdentity,
  };
}

export function issueLeadRuntimeRestartProof(
  input: LeadRuntimeRestartProofBinding,
  authorityEpoch: AuthoritativeProofEpoch,
  nowMs = Date.now()
): OpaqueLeadRuntimeRestartProof {
  if (!rootAuthorityOpen) {
    throw new Error('Lead restart authorization is unavailable during Claude root handoff');
  }
  const claimed = claimAttemptLease(
    authorityEpoch,
    input.cwd,
    Date.now(),
    'Lead restart authorization',
    new Set([input.providerId])
  );
  const opaque = randomUUID();
  const teamRunKey = `${input.teamName.trim()}\u0000${input.runId}`;
  for (const [key, record] of leadRestartProofs) {
    if (record.teamRunKey === teamRunKey) {
      deleteLeadRestartProof(key, record, false);
    }
  }
  const binding = normalizeLeadRestartBinding(input);
  try {
    leadRestartProofs.set(opaque, {
      binding,
      bindingDigest: digest(binding),
      teamRunKey,
      expiresAtMs: nowMs + PROOF_TTL_MS,
      projectLease: claimed.projectLease,
      authorityEpoch: claimed.authorityEpoch,
    });
    scheduleExpiryCleanup();
    return { opaque };
  } catch (error) {
    claimed.projectLease.close();
    throw error;
  }
}

export function consumeLeadRuntimeRestartProofForCurrentOwner(
  proof: OpaqueLeadRuntimeRestartProof,
  input: Omit<
    LeadRuntimeRestartProofBinding,
    | 'launchIdentity'
    | 'providerBackendId'
    | 'resolvedLaunchModel'
    | 'resolvedEffort'
    | 'leadRuntimeSelectionProvenance'
  >,
  nowMs = Date.now()
): LeadRuntimeRestartInvocationLease | null {
  if (!proof || typeof proof.opaque !== 'string' || !proof.opaque.trim()) return null;
  const record = leadRestartProofs.get(proof.opaque);
  if (record && (record.expiresAtMs <= nowMs || !record.projectLease.isCurrent())) {
    deleteLeadRestartProof(proof.opaque, record);
    return null;
  }
  if (!record || record.authorityEpoch !== currentAuthorityEpoch || record.expiresAtMs <= nowMs)
    return null;
  const expected = normalizeLeadRestartBinding({
    ...input,
    providerBackendId: record.binding.providerBackendId,
    resolvedLaunchModel: record.binding.resolvedLaunchModel,
    resolvedEffort: record.binding.resolvedEffort,
    leadRuntimeSelectionProvenance: record.binding.leadRuntimeSelectionProvenance,
    launchIdentity: record.binding.launchIdentity,
  });
  if (record.bindingDigest !== digest(expected)) return null;
  leadRestartProofs.delete(proof.opaque);
  const claimed: ClaimedLeadRestartRecord = { ...record, stale: false, closed: false };
  claimedLeadRestartLeases.add(claimed);
  scheduleExpiryCleanup();
  return {
    launchIdentity: structuredClone(record.binding.launchIdentity),
    leadRuntimeSelectionProvenance: structuredClone(record.binding.leadRuntimeSelectionProvenance),
    isCurrent: (currentNowMs = Date.now()) =>
      claimedLeadRestartRecordIsCurrent(claimed, currentNowMs),
    close: () => {
      claimed.stale = true;
      closeClaimedLeadRestartRecord(claimed);
      scheduleExpiryCleanup();
    },
  };
}

/** Consumes one lead-restart authorization immediately before process detachment. */
export function consumeLeadRuntimeRestartProof(
  proof: OpaqueLeadRuntimeRestartProof,
  binding: LeadRuntimeRestartProofBinding,
  nowMs = Date.now()
): boolean {
  if (!proof || typeof proof.opaque !== 'string' || !proof.opaque.trim()) return false;
  const record = leadRestartProofs.get(proof.opaque);
  if (record && (record.expiresAtMs <= nowMs || !record.projectLease.isCurrent())) {
    deleteLeadRestartProof(proof.opaque, record);
    return false;
  }
  if (
    !record ||
    record.authorityEpoch !== currentAuthorityEpoch ||
    record.expiresAtMs <= nowMs ||
    record.bindingDigest !== digest(normalizeLeadRestartBinding(binding))
  ) {
    return false;
  }
  deleteLeadRestartProof(proof.opaque, record);
  return true;
}

function effectiveChecks(
  request: TeamCreateRequest | TeamLaunchRequest,
  roster: readonly Pick<
    TeamMember,
    | 'name'
    | 'providerId'
    | 'providerBackendId'
    | 'model'
    | 'effort'
    | 'runtimeSelectionProvenance'
    | 'removedAt'
  >[]
): { checks: TeamProvisioningModelCheckRequest[]; runtimeRosterRevision: string } | null {
  const defaultProvider = request.providerId ?? 'anthropic';
  const defaultBackend = request.providerBackendId ?? null;
  const defaultModel = request.model?.trim();
  if (
    !defaultModel ||
    (defaultProvider !== 'anthropic' && (!defaultBackend || defaultBackend === 'auto'))
  )
    return null;
  const leadRuntimeSelectionProvenance = resolveLeadRuntimeSelectionProvenance({
    ...request,
    providerId: defaultProvider,
  });
  if (!isResolvedLeadRuntimeSelectionProvenance(leadRuntimeSelectionProvenance)) return null;
  const leadIdentity = normalizeEffectiveLaunchIdentity({
    lead: {
      providerId: defaultProvider,
      providerBackendId: defaultBackend,
      model: defaultModel,
      effort: request.effort,
    },
  });
  const checks: TeamProvisioningModelCheckRequest[] = [];
  checks.push({
    providerId: leadIdentity.providerId,
    providerBackendId: leadIdentity.providerBackendId,
    model: leadIdentity.model!,
    ...(leadIdentity.effort ? { effort: leadIdentity.effort } : {}),
  });
  for (const member of roster) {
    if (member.removedAt != null) continue;
    const identity = resolveEffectiveMemberRuntimeIdentity({
      lead: leadIdentity,
      member,
      missingProvenance: 'reject',
    });
    if (!identity) return null;
    const { providerId, providerBackendId, model, effort } = identity;
    if (!model || (providerId !== 'anthropic' && !providerBackendId)) return null;
    checks.push({
      providerId,
      providerBackendId,
      model,
      ...(effort ? { effort } : {}),
    });
  }
  const runtimeRosterRevision = buildEffectiveRuntimeRosterRevision({
    lead: leadIdentity,
    leadRuntimeSelectionProvenance,
    members: roster,
    missingProvenance: 'reject',
  });
  return runtimeRosterRevision
    ? {
        checks: normalizeChecks(checks) as TeamProvisioningModelCheckRequest[],
        runtimeRosterRevision,
      }
    : null;
}

export function verifyAuthoritativeModelExecutionProofForRequest(
  proof: AuthoritativeModelExecutionProof,
  request: TeamCreateRequest | TeamLaunchRequest,
  roster: readonly Pick<
    TeamMember,
    | 'name'
    | 'providerId'
    | 'providerBackendId'
    | 'model'
    | 'effort'
    | 'runtimeSelectionProvenance'
    | 'removedAt'
  >[],
  nowMs = Date.now()
): boolean {
  const effective = effectiveChecks(request, roster);
  if (!effective || !verifyAuthoritativeModelExecutionProof(proof, nowMs)) return false;
  const record = proofs.get(proof.authorityId);
  if (
    record?.authorityEpoch !== currentAuthorityEpoch ||
    record.runtimeRosterRevision !== effective.runtimeRosterRevision ||
    !record.projectLease.isCurrent(request.cwd)
  )
    return false;
  let requestDigest: string;
  try {
    requestDigest = executionProofRequestDigestForIdentity(
      {
        checks: effective.checks,
        allowExperimentalLocalModels: request.allowExperimentalLocalModels === true,
        runtimeRosterRevision: effective.runtimeRosterRevision,
      },
      record.projectLease.identity
    );
  } catch {
    return false;
  }
  return proof.requestDigest === requestDigest;
}

export function verifyAuthoritativeModelExecutionProof(
  proof: AuthoritativeModelExecutionProof,
  nowMs = Date.now()
): boolean {
  const record = proofs.get(proof.authorityId);
  if (!record) return false;
  const authoritative = record.proof;
  if (Date.parse(authoritative.expiresAt) <= nowMs || !record.projectLease.isCurrent()) {
    deleteExecutionProof(proof.authorityId, record);
    return false;
  }
  return (
    authoritative !== undefined &&
    record.authorityEpoch === currentAuthorityEpoch &&
    authoritative.authorityId === proof.authorityId &&
    authoritative.generation === proof.generation &&
    authoritative.completedAt === proof.completedAt &&
    authoritative.expiresAt === proof.expiresAt &&
    authoritative.requestDigest === proof.requestDigest &&
    Date.parse(authoritative.completedAt) <= nowMs &&
    Date.parse(authoritative.expiresAt) > nowMs
  );
}

/**
 * Removes a bound proof from every reusable authority map and transfers its
 * project descriptor to one exact invocation lease.
 */
export function claimAuthoritativeModelExecutionProofInvocation(
  proof: AuthoritativeModelExecutionProof,
  nowMs = Date.now()
): AuthoritativeModelExecutionInvocationLease | null {
  if (!verifyAuthoritativeModelExecutionProof(proof, nowMs)) return null;
  const record = proofs.get(proof.authorityId);
  if (!record) return null;
  proofs.delete(proof.authorityId);
  const claimed: ClaimedExecutionRecord = {
    expiresAtMs: record.expiresAtMs,
    projectLease: record.projectLease,
    authorityEpoch: record.authorityEpoch,
    stale: false,
    invocationActive: false,
    closed: false,
    providerIds: new Set(record.checks.map((check) => check.providerId)),
  };
  claimedExecutionLeases.add(claimed);
  scheduleExpiryCleanup();
  return {
    isCurrent: (currentNowMs = Date.now()) =>
      claimedExecutionRecordIsCurrent(claimed, currentNowMs),
    beginInvocation<T>(invocation: () => T) {
      if (!claimedExecutionRecordIsCurrent(claimed)) return { started: false };
      claimed.invocationActive = true;
      try {
        return { started: true, value: invocation() };
      } finally {
        claimed.invocationActive = false;
        claimed.stale = true;
        closeClaimedExecutionRecord(claimed);
        scheduleExpiryCleanup();
      }
    },
    close(): void {
      invalidateClaimedExecutionRecord(claimed);
      scheduleExpiryCleanup();
    },
  };
}

/** Derive a single-use submitted-request binding from fresh preparation evidence. */
export function bindAuthoritativeModelExecutionProof(
  proof: AuthoritativeModelExecutionProof,
  launchRequestFingerprint: string,
  rosterRevision?: string,
  nowMs = Date.now()
): AuthoritativeModelExecutionProof {
  if (!verifyAuthoritativeModelExecutionProof(proof, nowMs)) {
    throw new Error('Launch authorization is stale or no longer authoritative');
  }
  const bound: AuthoritativeModelExecutionProof = {
    ...proof,
    authorityId: randomUUID(),
    generation: ++generation,
    requestDigest: digest({
      executionProofAuthorityId: proof.authorityId,
      executionProofRequestDigest: proof.requestDigest,
      launchRequestFingerprint,
      rosterRevision: rosterRevision ?? null,
    }),
  };
  const source = proofs.get(proof.authorityId);
  if (!source) throw new Error('Launch authorization is no longer authoritative');
  proofs.delete(proof.authorityId);
  proofs.set(bound.authorityId, { ...source, proof: bound });
  return bound;
}
