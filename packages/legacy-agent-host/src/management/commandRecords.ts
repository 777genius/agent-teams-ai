import { z } from 'zod';
import { storedSkillCommandSchema } from '../skills/skillRecords.js';
import { managementCommandIdentityShape as common } from './commandIdentity.js';
import { storedExtensionCommandSchema } from '../extensions/extensionRecords.js';
import { modelProbeLimitsSchema } from './modelLimits.js';
import { runtimeSourceRefusalSchema } from './runtimeSourceVerification.js';
import { openCodeV2CredentialProgressSchema } from './openCodeV2CredentialRecord.js';

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const storedCredentialCommandSchema = z
  .object({
    ...common,
    kind: z.enum(['credential.set', 'credential.forget', 'credential.refresh']),
    phase: z.enum(['claimed', 'completed', 'held']),
    finishedAtMs: z.number().int().positive().safe().optional(),
    refreshCompletedAtMs: z.number().int().positive().safe().optional(),
    openCodeV2: openCodeV2CredentialProgressSchema.optional(),
    terminalRejection: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.phase === 'claimed'
        ? value.resourceHeld && value.finishedAtMs === undefined
        : value.phase !== 'completed' || !value.resourceHeld) &&
      (value.openCodeV2 === undefined || value.kind === 'credential.set' &&
        (value.phase !== 'completed' || value.openCodeV2.phase === 'probe-completed' &&
          value.openCodeV2.verification?.ok === true)) &&
      (value.terminalRejection === undefined || value.kind === 'credential.set' &&
        value.phase === 'held' && !value.resourceHeld && value.finishedAtMs !== undefined) &&
      (value.refreshCompletedAtMs === undefined ||
        (value.kind === 'credential.refresh' &&
          value.phase === 'completed' &&
          value.finishedAtMs !== undefined &&
          value.refreshCompletedAtMs <= value.finishedAtMs))
  );
export type StoredCredentialCommand = z.infer<typeof storedCredentialCommandSchema>;

export const storedOAuthCommandSchema = z
  .object({
    ...common,
    kind: z.literal('oauth'),
    methodIndex: z.number().int().min(0).max(10000),
    phase: z.enum([
      'authorizing',
      'waiting-for-code',
      'waiting-for-browser',
      'completing',
      'cancelling',
      'completed',
      'cancelled',
      'failed',
      'held',
    ]),
    completionMethod: z.enum(['auto', 'code']).nullable(),
    completionCommandId: id.optional(),
    completionFingerprint: hash.optional(),
    sequence: z.number().int().min(1),
    expiresAt: z.number().int().positive(),
    reason: z.enum(['cancelled', 'expired', 'native-rejected', 'native-outcome-unknown', 'owner-changed']).optional(),
  })
  .strict()
  .refine((value) => {
    if (['completed', 'cancelled', 'failed'].includes(value.phase) && value.resourceHeld) return false;
    if (!['completed', 'cancelled', 'failed', 'held'].includes(value.phase) && !value.resourceHeld)
      return false;
    if (value.phase === 'failed' && value.reason !== 'native-rejected') return false;
    if (value.reason === 'native-rejected' && !['cancelling', 'failed', 'held'].includes(value.phase))
      return false;
    if ((value.completionCommandId === undefined) !== (value.completionFingerprint === undefined))
      return false;
    if (
      ['completing', 'completed'].includes(value.phase) &&
      (!value.completionCommandId || !value.completionMethod)
    )
      return false;
    return true;
  });
export type StoredOAuthCommand = z.infer<typeof storedOAuthCommandSchema>;


const originPath = z.string().min(1).max(8192).refine(value => !/[\0\r\n]/u.test(value));
export const readinessSourceReferenceSchema = z.object({
  root: originPath, path: originPath, present: z.boolean(), digest: hash,
}).strict();
const readinessProviderPolicySchema = z.object({
  providerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  baseUrl: z.string().min(1).max(2048),
  preset: z.enum(['ollama', 'lm-studio', 'atomic-chat', 'llama.cpp', 'custom']),
  hasConfiguredApiKey: z.boolean(),
}).strict();
const readinessPolicyScopeFields = {
  sources: z.array(readinessSourceReferenceSchema).min(2).max(4),
  providers: z.array(readinessProviderPolicySchema).max(256),
};
const readinessPolicyScopeSchema = z.union([
  z.object({ ...readinessPolicyScopeFields, selectedPath: originPath, invalid: z.boolean() }).strict(),
  z.object({ ...readinessPolicyScopeFields, selectedPath: z.null(), invalid: z.literal(true),
    selectorFailure: z.enum(['config-conflict', 'config-invalid', 'project-required']),
    providers: z.array(readinessProviderPolicySchema).max(0),
  }).strict(),
]).refine(value => new Set(value.sources.map(row => row.path)).size === value.sources.length &&
  new Set(value.providers.map(row => row.providerId)).size === value.providers.length &&
  (!value.invalid || value.providers.length === 0));
export const localModelReadinessOriginSchema = z.object({
  schemaVersion: z.literal(1), kind: z.enum(['create', 'team']),
  ownerDigest: hash, contextId: id, commandId: id, selectionDigest: hash,
  workspaces: z.array(z.object({
    path: originPath, project: readinessPolicyScopeSchema, global: readinessPolicyScopeSchema,
  }).strict()).min(1).max(256),
  approval: z.object({
    source: readinessSourceReferenceSchema,
    approved: z.array(z.object({
      configPath: originPath, providerId: id, baseUrl: z.string().min(1).max(2048),
    }).strict()).max(256),
  }).strict(),
}).strict().refine(value => new Set(value.workspaces.map(row => row.path)).size === value.workspaces.length &&
  value.workspaces.every(row => row.project.sources.length === 4 && row.global.sources.length === 2) &&
  value.workspaces.reduce((count, row) => count + row.project.providers.length + row.global.providers.length, 0) <= 256 &&
  Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024);
export type LocalModelReadinessOrigin = z.infer<typeof localModelReadinessOriginSchema>;
export type ReadinessSourceReference = z.infer<typeof readinessSourceReferenceSchema>;
export const localModelReadinessPreparationSchema = z.object({
  origin: localModelReadinessOriginSchema,
  remainingMs: z.number().int().min(1).max(100000),
}).strict();
export type LocalModelReadinessPreparation = z.infer<typeof localModelReadinessPreparationSchema>;

const readinessPreparationAnchorSchema = z.object({
  originDigest: hash, ownerDigest: hash, contextId: id, commandId: id, selectionDigest: hash,
  anchorCommandId: id, expiresAt: z.number().int().positive().safe(),
}).strict();
export type ReadinessPreparationAnchor = z.infer<typeof readinessPreparationAnchorSchema>;

export const nativeLocalReadinessEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  ordinary: z.enum(['confirmed', 'unconfirmed']),
  coordination: z.enum(['compatible', 'incompatible', 'unavailable', 'not-applicable']),
  decision: z.enum(['allow', 'block']),
  reasons: z.array(z.enum([
    'ordinary-unconfirmed', 'model-missing', 'tools-unsupported', 'context-too-small',
    'request-rejected', 'coordination-failed', 'coordination-unavailable',
    'managed-configuration', 'metadata-unavailable', 'context-unknown',
    'capabilities-unknown', 'not-applicable', 'provider-unavailable',
    'small-model', 'context-below-recommended',
  ])).max(8),
  routeDigest: hash,
  configurationDigest: hash,
  accountDigest: hash,
  metadata: z.object({
    provider: z.enum(['ollama', 'lmstudio', 'llamacpp', 'custom']),
    tools: z.boolean().nullable(),
    modelListed: z.boolean().nullable(),
    contextTokens: z.number().int().positive().safe().nullable(),
    parameterCount: z.number().int().positive().safe().nullable(),
    configuredContextTokens: z.number().int().positive().safe().nullable(),
    trainedContextTokens: z.number().int().positive().safe().nullable(),
    contextSource: z.enum(['ollama-loaded', 'local-metadata', 'unknown']),
  }).strict(),
}).strict().refine(value =>
  new Set(value.reasons).size === value.reasons.length &&
  (value.metadata.contextSource === 'unknown') === (value.metadata.contextTokens === null) &&
  (value.decision !== 'allow' || value.ordinary === 'confirmed' &&
    value.coordination !== 'incompatible' && value.metadata.tools !== false &&
    value.metadata.modelListed !== false && !value.reasons.includes('provider-unavailable') &&
    !value.reasons.includes('model-missing') &&
    (value.metadata.contextTokens === null || value.metadata.contextTokens >= 16384)));
export type NativeLocalReadinessEvidence = z.infer<typeof nativeLocalReadinessEvidenceSchema>;
const storedLocalReadinessSchema = z.object({
  context: hash, selectionDigest: hash, evidence: nativeLocalReadinessEvidenceSchema,
}).strict();

export const storedModelProbeSchema = z
  .object({
    ...common,
    kind: z.literal('model.probe'),
    purpose: z.enum(['native-local-coordination-v1', 'native-local-readiness-v1']).optional(),
    readiness: storedLocalReadinessSchema.optional(),
    localModelReadinessOrigin: localModelReadinessOriginSchema.optional(),
    localModelReadinessPreparation: readinessPreparationAnchorSchema.optional(),
    modelId: id,
    effort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      .optional(),
    modelContext: z.enum(['model-default', 'one-million']).optional(),
    context: hash.optional(),
    limits: modelProbeLimitsSchema.optional(),
    phase: z.enum(['running', 'completed', 'cancelled', 'held']),
    expiresAt: z.number().int().positive(),
    ok: z.boolean(),
  })
  .strict()
  .refine((value) => value.purpose === undefined || value.context !== undefined)
  .refine(value => value.localModelReadinessOrigin === undefined ||
    value.purpose === 'native-local-readiness-v1' && value.localModelReadinessPreparation !== undefined &&
    value.localModelReadinessOrigin.ownerDigest === value.localModelReadinessPreparation.ownerDigest &&
    value.localModelReadinessOrigin.contextId === value.localModelReadinessPreparation.contextId &&
    value.localModelReadinessOrigin.commandId === value.localModelReadinessPreparation.commandId &&
    value.localModelReadinessOrigin.selectionDigest === value.localModelReadinessPreparation.selectionDigest &&
    Buffer.byteLength(JSON.stringify(value.localModelReadinessOrigin)) <= 64 * 1024)
  .refine(value => value.readiness === undefined || value.purpose === 'native-local-readiness-v1' &&
    value.phase === 'completed' && !value.resourceHeld && value.readiness.context === value.context &&
    value.readiness.selectionDigest === value.selectionDigest &&
    value.ok === (value.readiness.evidence.decision === 'allow'))
  .refine(value => value.purpose !== 'native-local-readiness-v1' || value.phase !== 'completed' ||
    value.readiness !== undefined)
  .refine((value) =>
    value.phase === 'running'
      ? value.resourceHeld && !value.ok
      : value.phase === 'completed'
        ? !value.resourceHeld
        : !value.ok && (value.phase !== 'cancelled' || !value.resourceHeld)
  );
export type StoredModelProbe = z.infer<typeof storedModelProbeSchema>;

/** Publication owns only its finite source verification; native auth fences remain separate. */
export const storedRuntimeSourceCommandSchema = z.object({
  ...common,
  kind: z.literal('runtime.source'),
  phase: z.enum(['prepared', 'verifying', 'verified', 'held', 'published']),
  sourceId: hash,
  revision: hash,
  expectedRevision: hash,
  resourceHeld: z.boolean(),
  nativeVersion: id.optional(),
  seedNativeVersion: id.optional(),
  // Exact private source input for recovery; credentials/environment are not part of this contract.
  publicationJson: z.string().max(2 * 1024 * 1024)
    .refine(value => Buffer.byteLength(value) <= 2 * 1024 * 1024).optional(),
  reason: runtimeSourceRefusalSchema.optional(),
}).strict().refine(value =>
  (value.phase === 'verifying' ? value.resourceHeld : value.phase === 'held' || !value.resourceHeld) &&
  (value.phase !== 'verified' || value.nativeVersion !== undefined) &&
  (value.reason === undefined || value.phase === 'held'));
export type StoredRuntimeSourceCommand = z.infer<typeof storedRuntimeSourceCommandSchema>;

export const storedManagementCommandSchema = z.union([
  storedSkillCommandSchema,
  storedCredentialCommandSchema,
  storedOAuthCommandSchema,
  storedModelProbeSchema,
  storedExtensionCommandSchema,
  storedRuntimeSourceCommandSchema,
]);
export type StoredManagementCommand = z.infer<typeof storedManagementCommandSchema>;
export interface ManagementCommandStore {
  read(commandId: string): StoredManagementCommand | undefined;
  write(record: StoredManagementCommand): void;
  list(): Iterable<StoredManagementCommand>;
}
export interface ManagementTarget {
  profileId: string;
  configRevision: string;
  selectionDigest: string;
  resourceId: string;
}
export class ManagementCommandError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'busy' | 'held') {
    super(`Provider management command ${code}`);
  }
}
export function assertManagementTarget(saved: ManagementTarget, selected: ManagementTarget): void {
  if (
    saved.profileId !== selected.profileId ||
    saved.configRevision !== selected.configRevision ||
    saved.selectionDigest !== selected.selectionDigest ||
    saved.resourceId !== selected.resourceId
  )
    throw new ManagementCommandError('conflict');
}
