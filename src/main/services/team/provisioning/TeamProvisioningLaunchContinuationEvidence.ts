import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type {
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
  TeamLaunchRequest,
} from '@shared/types';

export type LaunchContinuationRetryOutcome = 'failed' | 'missing';

export interface LaunchContinuationPreservedMember {
  name: string;
  runtimeRunId: string;
  bootstrapConfirmedAt: string;
}

export interface LaunchContinuationRetryMember {
  name: string;
  outcome: LaunchContinuationRetryOutcome;
  cleanupRunId: string;
  cleanupConfirmedAt: string;
}

export interface DeterministicLaunchContinuation {
  version: 1;
  sourceRunId: string;
  evidenceId: string;
  evidenceUpdatedAt: string;
  rosterFingerprint: `sha256:${string}`;
  preservedMembers: LaunchContinuationPreservedMember[];
  retryMembers: LaunchContinuationRetryMember[];
}

export type DeterministicLaunchContinuationDecision =
  | { kind: 'fresh'; rosterFingerprint: `sha256:${string}` }
  | {
      kind: 'continue';
      rosterFingerprint: `sha256:${string}`;
      continuation: DeterministicLaunchContinuation;
    }
  | {
      kind: 'complete';
      rosterFingerprint: `sha256:${string}`;
      sourceRunId: string;
    };

export interface DurableLaunchContinuationMemberEvidence {
  name: string;
  outcome: 'bootstrap_confirmed' | LaunchContinuationRetryOutcome;
  runtimeRunId?: string;
  observedAt: string;
  cleanup?: {
    status: 'confirmed';
    runId: string;
    observedAt: string;
  };
}

export interface DurableLaunchContinuationEvidence {
  version: 1;
  sourceRunId: string;
  teamName: string;
  evidenceId: string;
  updatedAt: string;
  rosterFingerprint: `sha256:${string}`;
  terminalStatus: 'partial_success' | 'completed';
  members: DurableLaunchContinuationMemberEvidence[];
}

export type DurableLaunchContinuationEvidenceRead =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'evidence'; evidence: DurableLaunchContinuationEvidence };

const VOLATILE_EVIDENCE_PATHS = new Set([
  'request.executionProof',
  'request.rosterTransactionId',
  'request.rosterLaunchBinding.transactionId',
  'request.rosterLaunchBinding.launchCommandId',
  'request.rosterLaunchBinding.launchRequestFingerprint',
  'launchIdentity.catalogFetchedAt',
]);

const SENSITIVE_KEY_PATTERN =
  /(?:apikey|authtoken|authorization|bearer|credential|password|privatekey|refreshtoken|secret|token)/i;
const MAX_SNAPSHOT_FILE_BYTES = 10 * 1024 * 1024;

function canonicalize(value: unknown, schemaPath = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalize(entry, `${schemaPath}[${index}]`));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => {
        const entryPath = schemaPath ? `${schemaPath}.${key}` : key;
        return entry !== undefined && !VOLATILE_EVIDENCE_PATHS.has(entryPath);
      })
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => {
        const entryPath = schemaPath ? `${schemaPath}.${key}` : key;
        if ((key === 'cwd' || key === 'projectPath') && typeof entry === 'string') {
          return [key, path.resolve(entry)];
        }
        return [key, canonicalize(entry, entryPath)];
      })
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_KEY_PATTERN.test(normalized);
}

function redactSensitiveString(value: string): string {
  return value
    .replace(
      /(--[^\s=]*(?:api[-_]?key|auth[-_]?token|credential|password|secret|token)[^\s=]*(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi,
      '$1[REDACTED]'
    )
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]')
    .replace(
      /((?:"|')?(?:api[-_]?key|auth[-_]?token|authorization|credential|password|private[-_]?key|refresh[-_]?token|secret|token)(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^,}\s]+)/gi,
      '$1"[REDACTED]"'
    )
    .replace(/([?&](?:token|key|secret|password)=)[^&]+/gi, '$1[REDACTED]');
}

function redactSensitiveMaterial(value: unknown, key = ''): unknown {
  if (isSensitiveKey(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactSensitiveString(value);
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      const previous = index > 0 ? value[index - 1] : null;
      return typeof previous === 'string' && isSensitiveKey(previous.replace(/^-+/, ''))
        ? '[REDACTED]'
        : redactSensitiveMaterial(entry);
    });
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
      entryKey,
      redactSensitiveMaterial(entry, entryKey),
    ])
  );
}

export function buildRedactedLaunchMaterialDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(redactSensitiveMaterial(value))))
    .digest('hex')}`;
}

export interface LaunchContinuationSourceSnapshotEntry {
  path: string;
  state: 'absent' | 'file';
  revisionDigest?: `sha256:${string}`;
  redactedContentDigest?: `sha256:${string}`;
}

export interface LaunchContinuationSourceSnapshot {
  version: 1;
  digest: `sha256:${string}`;
  entries: LaunchContinuationSourceSnapshotEntry[];
}

async function readStableRedactedJsonFile(
  filePath: string
): Promise<LaunchContinuationSourceSnapshotEntry> {
  const resolvedPath = path.resolve(filePath);
  let before: fs.BigIntStats;
  try {
    before = await fs.promises.stat(resolvedPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await fs.promises.stat(resolvedPath);
      throw new Error(`Launch material source appeared while snapshotting: ${resolvedPath}`);
    } catch (secondError) {
      if ((secondError as NodeJS.ErrnoException).code === 'ENOENT') {
        return { path: resolvedPath, state: 'absent' };
      }
      throw secondError;
    }
  }
  if (!before.isFile() || before.size > BigInt(MAX_SNAPSHOT_FILE_BYTES)) {
    throw new Error(`Launch material source is not a bounded regular file: ${resolvedPath}`);
  }
  const first = await fs.promises.readFile(resolvedPath, 'utf8');
  const after = await fs.promises.stat(resolvedPath, { bigint: true });
  const second = await fs.promises.readFile(resolvedPath, 'utf8');
  const final = await fs.promises.stat(resolvedPath, { bigint: true });
  if (
    first !== second ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    after.dev !== final.dev ||
    after.ino !== final.ino ||
    after.size !== final.size ||
    after.mtimeNs !== final.mtimeNs ||
    after.ctimeNs !== final.ctimeNs
  ) {
    throw new Error(`Launch material source changed while snapshotting: ${resolvedPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(first) as unknown;
  } catch {
    throw new Error(`Launch material source is not valid JSON: ${resolvedPath}`);
  }
  return {
    path: resolvedPath,
    state: 'file',
    revisionDigest: buildRedactedLaunchMaterialDigest({
      device: final.dev.toString(),
      inode: final.ino.toString(),
      size: final.size.toString(),
      modifiedAtNanoseconds: final.mtimeNs.toString(),
      changedAtNanoseconds: final.ctimeNs.toString(),
    }),
    redactedContentDigest: buildRedactedLaunchMaterialDigest(parsed),
  };
}

export async function snapshotLaunchContinuationSources(
  sourcePaths: readonly string[]
): Promise<LaunchContinuationSourceSnapshot> {
  const paths = [...new Set(sourcePaths.map((sourcePath) => path.resolve(sourcePath)))].sort(
    (left, right) => left.localeCompare(right)
  );
  const first = await Promise.all(paths.map(readStableRedactedJsonFile));
  const entries = await Promise.all(paths.map(readStableRedactedJsonFile));
  const firstDigest = buildRedactedLaunchMaterialDigest(first);
  const digest = buildRedactedLaunchMaterialDigest(entries);
  if (firstDigest !== digest) {
    throw new Error('Launch material sources changed while snapshotting the complete source set');
  }
  return { version: 1, digest, entries };
}

export async function verifyLaunchContinuationSources(
  expected: LaunchContinuationSourceSnapshot
): Promise<void> {
  const observed = await snapshotLaunchContinuationSources(
    expected.entries.map((entry) => entry.path)
  );
  if (observed.digest !== expected.digest) {
    throw new Error('Launch material sources changed after deterministic continuation snapshot');
  }
}

function collectSettingsPathArgs(args: readonly string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = arg === '--settings' ? args[index + 1] : arg.slice('--settings='.length);
    if (arg !== '--settings' && !arg.startsWith('--settings=')) continue;
    if (arg === '--settings') index += 1;
    if (value && !value.trim().startsWith('{')) paths.push(value);
  }
  return paths;
}

export function collectLaunchContinuationSourcePaths(input: {
  cwd: string;
  memberCwds: readonly (string | undefined)[];
  claudeConfigDir: string;
  homeDir: string;
  launchArgs: readonly string[];
}): string[] {
  const workspaces = [input.cwd, ...input.memberCwds.filter((value): value is string => !!value)];
  return [
    path.join(input.claudeConfigDir, 'settings.json'),
    path.join(input.claudeConfigDir, 'settings.local.json'),
    path.join(input.claudeConfigDir, 'plugins', 'installed_plugins.json'),
    path.join(input.claudeConfigDir, 'plugins', 'known_marketplaces.json'),
    path.join(input.homeDir, '.claude.json'),
    ...workspaces.flatMap((workspace) => [
      path.join(workspace, '.claude', 'settings.json'),
      path.join(workspace, '.claude', 'settings.local.json'),
      path.join(workspace, '.mcp.json'),
    ]),
    ...collectSettingsPathArgs(input.launchArgs).map((sourcePath) =>
      path.resolve(input.cwd, sourcePath)
    ),
  ];
}

export interface LaunchContinuationCanonicalEvidenceInput {
  request: TeamLaunchRequest;
  materializedMemberSpecs: TeamCreateRequest['members'];
  launchIdentity: ProviderModelLaunchIdentity;
  runtimeLanePlan: TeamRuntimeLanePlan;
  finalizedLaunchMaterial: unknown;
}

export function buildLaunchContinuationRosterFingerprint(
  input: LaunchContinuationCanonicalEvidenceInput
): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(serializeLaunchContinuationCanonicalEvidence(input))
    .digest('hex')}`;
}

function serializeLaunchContinuationCanonicalEvidence(
  input: LaunchContinuationCanonicalEvidenceInput
): string {
  const materializedMemberSpecs = [...input.materializedMemberSpecs].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  return JSON.stringify(
    canonicalize(
      redactSensitiveMaterial({
        schemaVersion: 3,
        request: {
          ...input.request,
          fastMode: input.request.fastMode ?? 'inherit',
          limitContext: input.request.limitContext ?? false,
          clearContext: input.request.clearContext ?? false,
          skipPermissions: input.request.skipPermissions ?? true,
        },
        materializedMemberSpecs,
        launchIdentity: input.launchIdentity,
        runtimeLanePlan: input.runtimeLanePlan,
        finalizedLaunchMaterial: input.finalizedLaunchMaterial,
      })
    )
  );
}

function normalizedNames(names: readonly string[]): string[] {
  return names.map((name) => name.trim()).sort((left, right) => left.localeCompare(right));
}

function hasExactUniqueRoster(
  evidence: DurableLaunchContinuationEvidence,
  expectedMemberNames: readonly string[]
): boolean {
  const expected = normalizedNames(expectedMemberNames);
  const observed = normalizedNames(evidence.members.map((member) => member.name));
  return (
    expected.length === new Set(expected).size &&
    observed.length === new Set(observed).size &&
    expected.length === observed.length &&
    expected.every((name, index) => name === observed[index])
  );
}

export function resolveDeterministicLaunchContinuation(input: {
  teamName: string;
  expectedMemberNames: readonly string[];
  rosterFingerprint: `sha256:${string}`;
  evidenceRead: DurableLaunchContinuationEvidenceRead;
}): DeterministicLaunchContinuationDecision {
  if (input.evidenceRead.kind === 'absent') {
    return { kind: 'fresh', rosterFingerprint: input.rosterFingerprint };
  }
  if (input.evidenceRead.kind === 'invalid') {
    throw new Error(
      `Deterministic partial-launch continuation is unavailable: ${input.evidenceRead.reason}. ` +
        'Stop/reset the team before launching the full roster again.'
    );
  }

  const evidence = input.evidenceRead.evidence;
  if (evidence.teamName !== input.teamName) {
    throw new Error('Deterministic partial-launch continuation evidence belongs to another team');
  }
  if (evidence.rosterFingerprint !== input.rosterFingerprint) {
    throw new Error(
      'Deterministic partial-launch continuation evidence does not match the current launch ' +
        `configuration (${evidence.rosterFingerprint} != ${input.rosterFingerprint})`
    );
  }
  if (!hasExactUniqueRoster(evidence, input.expectedMemberNames)) {
    throw new Error(
      'Deterministic partial-launch continuation evidence does not contain the exact configured roster'
    );
  }

  const preservedMembers: LaunchContinuationPreservedMember[] = [];
  const retryMembers: LaunchContinuationRetryMember[] = [];
  for (const member of evidence.members) {
    if (member.outcome === 'bootstrap_confirmed') {
      if (!member.runtimeRunId) {
        throw new Error(
          `Deterministic partial-launch continuation lacks run-bound success evidence for ${member.name}`
        );
      }
      preservedMembers.push({
        name: member.name,
        runtimeRunId: member.runtimeRunId,
        bootstrapConfirmedAt: member.observedAt,
      });
      continue;
    }
    if (member.cleanup?.status !== 'confirmed' || member.cleanup.runId !== evidence.sourceRunId) {
      throw new Error(
        `Deterministic partial-launch continuation lacks cleanup proof for ${member.name}`
      );
    }
    retryMembers.push({
      name: member.name,
      outcome: member.outcome,
      cleanupRunId: member.cleanup.runId,
      cleanupConfirmedAt: member.cleanup.observedAt,
    });
  }

  if (evidence.terminalStatus === 'completed') {
    if (retryMembers.length > 0 || preservedMembers.length !== evidence.members.length) {
      throw new Error('Completed deterministic launch evidence contains an unresolved member');
    }
    return {
      kind: 'complete',
      rosterFingerprint: input.rosterFingerprint,
      sourceRunId: evidence.sourceRunId,
    };
  }
  if (preservedMembers.length === 0 || retryMembers.length === 0) {
    throw new Error('Partial deterministic launch evidence is not an exact partial outcome');
  }
  return {
    kind: 'continue',
    rosterFingerprint: input.rosterFingerprint,
    continuation: {
      version: 1,
      sourceRunId: evidence.sourceRunId,
      evidenceId: evidence.evidenceId,
      evidenceUpdatedAt: evidence.updatedAt,
      rosterFingerprint: evidence.rosterFingerprint,
      preservedMembers,
      retryMembers,
    },
  };
}
