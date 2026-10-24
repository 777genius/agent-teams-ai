import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { readImportBytes } from '@agent-teams/legacy-agent-host/stopped-team-import';

import {
  isLegacyNativeIdentityKey,
  isLegacySavedTeamProductRecords,
} from '../LegacySavedTeamNativeIdentity';
const nativeName =
  /^(launch-|bootstrap-|stop-|runtime-|opencode-|\.opencode-runtime|\.member-work-sync|\.bootstrap)/;
const publicationFiles = new Set([
  'launch-state.json',
  'launch-summary.json',
  'launch-stopped.json',
  'launch-freshness.json',
]);
type Row = Record<string, unknown>;
const configKeys = new Set([
  'name',
  'description',
  'createdAt',
  'leadAgentId',
  'leadSessionId',
  'projectPath',
  'members',
]);
const memberKeys = new Set([
  'name',
  'agentId',
  'agentType',
  'role',
  'workflow',
  'isolation',
  'providerId',
  'provider',
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'color',
  'cwd',
  'joinedAt',
  'mcpPolicy',
  'isActive',
  'backendType',
]);
export interface LegacyNativeTarget {
  teamName: string;
  runId: string;
  leadName: string;
  sessionId: string;
  rootPid: number;
}
export interface LegacyNativeCensus {
  directory: { dev: number; ino: number; birthtimeMs: number };
  nativeDigest: string;
}

export function nativeReleaseDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function nativeRecord(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid native custody record');
  return value as Row;
}
export function readNativeRecord(path: string, maxBytes = 1024 * 1024): Row {
  return nativeRecord(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readImportBytes(path, maxBytes)))
  );
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}
function validateNativeValue(key: string, value: unknown, target: LegacyNativeTarget): void {
  if (!present(value)) return;
  if (/^runId$/i.test(key) && value === target.runId) return;
  if (
    /^sessionHistory$/i.test(key) &&
    Array.isArray(value) &&
    value.every((session) => session === target.sessionId)
  )
    return;
  if (/^(pid|runtimePid|backendPid|processId)$/i.test(key) && value === target.rootPid) return;
  if (
    /^(sessionId|leadSessionId|runtimeSessionId|nativeSessionId)$/i.test(key) &&
    value === target.sessionId
  )
    return;
  if (/^(agentId|leadAgentId)$/i.test(key) && value === `${target.leadName}@${target.teamName}`)
    return;
  throw new Error('Native inventory is not covered by the owned solo CLI');
}
function nativeProjection(value: unknown, target: LegacyNativeTarget, depth = 0): unknown {
  if (depth > 48) throw new Error('Native custody nesting exceeds bound');
  if (Array.isArray(value)) return value.map((item) => nativeProjection(item, target, depth + 1));
  if (!value || typeof value !== 'object') return null;
  const result: Row = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Row)[key];
    if (isLegacyNativeIdentityKey(key)) {
      validateNativeValue(key, item, target);
      if (present(item)) result[key] = item;
    } else if (key === 'bootstrapRunId' || key === 'publicationRunId') {
      if (present(item) && item !== target.runId) throw new Error('Native run identity changed');
      if (present(item)) result[key] = item;
    } else if (item && typeof item === 'object') {
      result[key] = nativeProjection(item, target, depth + 1);
    }
  }
  return result;
}

/** Bounded private native files are evidence only; none is repaired or executed. */
function assertQualifiedArtifacts(teamDir: string): void {
  const names = readdirSync(teamDir).sort();
  if (names.length > 1024) throw new Error('Native Team census exceeds bound');
  for (const name of names) {
    if (nativeName.test(name) && !publicationFiles.has(name))
      throw new Error('Unqualified native artifact inventory');
  }
}

const launchSelectionKeys = new Set([
  'providerId',
  'providerBackendId',
  'billingMode',
  'selectedModel',
  'selectedModelKind',
  'resolvedLaunchModel',
  'catalogId',
  'catalogSource',
  'catalogFetchedAt',
  'selectedEffort',
  'resolvedEffort',
  'selectedFastMode',
  'resolvedFastMode',
  'fastResolutionReason',
]);
function productMetadata(teamName: string, meta: Row): boolean {
  const { launchIdentity, ...saved } = meta;
  if (launchIdentity !== undefined) {
    const selection = nativeRecord(launchIdentity);
    if (
      selection.providerId !== 'anthropic' ||
      !['default', 'explicit'].includes(String(selection.selectedModelKind)) ||
      !Object.entries(selection).every(
        ([key, value]) =>
          launchSelectionKeys.has(key) &&
          (value === null || typeof value === 'boolean' || typeof value === 'string')
      )
    )
      return false;
  }
  return isLegacySavedTeamProductRecords(teamName, {
    config: null,
    meta: saved,
    roster: { version: 1, members: [] },
  });
}

export function readLegacyNativeCensus(
  teamDir: string,
  target: LegacyNativeTarget
): LegacyNativeCensus {
  const directory = lstatSync(teamDir);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error('Native Team directory changed');
  const config = readNativeRecord(join(teamDir, 'config.json'), 10 * 1024 * 1024);
  const roster = readNativeRecord(join(teamDir, 'members.meta.json'), 20 * 1024 * 1024);
  const meta = readNativeRecord(join(teamDir, 'team.meta.json'));
  if (
    config.name !== target.teamName ||
    Object.keys(config).some((key) => !configKeys.has(key)) ||
    !Array.isArray(config.members) ||
    config.members.length !== 1 ||
    meta.version !== 1 ||
    !productMetadata(target.teamName, meta) ||
    !Array.isArray(roster.members) ||
    roster.version !== 1
  )
    throw new Error('Incomplete solo native inventory');
  const lead = nativeRecord(config.members[0]);
  if (
    lead.name !== target.leadName ||
    lead.agentType !== 'team-lead' ||
    (present(lead.providerId) && lead.providerId !== 'anthropic') ||
    (present(lead.provider) && lead.provider !== 'anthropic') ||
    Object.keys(lead).some((key) => !memberKeys.has(key) && !isLegacyNativeIdentityKey(key)) ||
    (present(lead.backendType) &&
      !['lead', 'in-process', 'process'].includes(String(lead.backendType)))
  )
    throw new Error('Unsupported native lead');
  for (const value of roster.members) {
    const member = nativeRecord(value);
    if (
      member.name !== target.leadName ||
      member.removedAt ||
      (present(member.providerId) && member.providerId !== 'anthropic')
    )
      throw new Error('Uncovered native member');
  }
  const identities = [
    nativeProjection(config, target),
    nativeProjection(roster, target),
    nativeProjection(meta, target),
  ];
  assertQualifiedArtifacts(teamDir);
  const after = lstatSync(teamDir);
  if (after.dev !== directory.dev || after.ino !== directory.ino)
    throw new Error('Native Team directory replaced');
  return {
    directory: { dev: directory.dev, ino: directory.ino, birthtimeMs: directory.birthtimeMs },
    nativeDigest: nativeReleaseDigest(identities),
  };
}
