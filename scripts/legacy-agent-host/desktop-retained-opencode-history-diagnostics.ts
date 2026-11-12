import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

type Diagnostic = Record<string, unknown>;
export interface RetainedHistoryIdentity {
  teamName: string;
  memberName: string;
  laneId: string;
  publicationRunId: string;
  runtimeRunId: string | null;
  sessionId: string;
  replyUuid: string;
}
const object = (value: unknown): Diagnostic =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Diagnostic : {};
const scalar = (value: unknown): unknown =>
  typeof value === 'string' ? (value.length <= 256 ? value : { type: 'string', length: value.length }) :
    typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? value : null;
const pick = (value: unknown, keys: readonly string[]): Diagnostic =>
  Object.fromEntries(keys.map(key => [key, scalar(object(value)[key])]));
const exact = (value: unknown) => typeof value === 'string' && value.length > 0 &&
  value.length <= 256 && value.trim() === value && !value.includes('\0');
const identityKeys = ['memberName', 'laneId', 'runId', 'sessionId'] as const;
const candidateKeys = ['teamName', 'memberName', 'laneId', 'runId', 'runtimeSessionId'] as const;
const runtimeKeys = ['teamId', 'memberName', 'providerId', 'laneId', 'runId', 'opencodeSessionId',
  'opencodeVersion', 'profileRootKey', 'projectPath', 'stoppedAt', 'staleReason'] as const;

export const finiteHistoryDiagnosticError = (error: unknown) =>
  pick(error, ['name', 'code', 'errno', 'status', 'signal', 'killed']);

async function observe(file: string, select: (value: Diagnostic) => Diagnostic): Promise<Diagnostic> {
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.size > 256 * 1024)
      return { read: 'refused', reason: metadata.isFile() ? 'oversize' : 'nonregular' };
    const bytes = await readFile(file, 'utf8');
    if (Buffer.byteLength(bytes) > 256 * 1024) return { read: 'refused', reason: 'oversize' };
    const value: unknown = JSON.parse(bytes);
    return { read: 'ok', sha256: createHash('sha256').update(bytes).digest('hex'),
      jsonObject: !!value && typeof value === 'object' && !Array.isArray(value), ...select(object(value)) };
  } catch (error) { return { read: 'error', error: finiteHistoryDiagnosticError(error) }; }
}

/** The app publication ID and the native SDK run ID are separate authorities. */
function persistedNativeBinding(
  launchState: Diagnostic, freshness: Diagnostic, expected: RetainedHistoryIdentity
): Diagnostic {
  const member = object(launchState.member), candidate = object(member.candidate);
  const checks = {
    publication: launchState.read === 'ok' && launchState.version === 2 &&
      launchState.teamName === expected.teamName && launchState.publicationRunId === expected.publicationRunId,
    freshness: freshness.read === 'ok' && freshness.version === 1 &&
      freshness.teamName === expected.teamName && freshness.kind === 'launch' &&
      freshness.runId === expected.publicationRunId,
    member: launchState.memberPresent === true && member.name === expected.memberName &&
      member.providerId === 'opencode' && member.laneId === expected.laneId &&
      member.runtimeSessionId === expected.sessionId,
    exactIdentities: [expected.memberName, expected.laneId, member.runtimeRunId, expected.sessionId].every(exact),
    candidateRequired: member.bootstrapEvidenceSource !== 'app_managed_bootstrap' || member.candidatePresent === true,
    candidateConsistent: member.candidatePresent !== true ||
      candidate.teamName === expected.teamName && candidate.memberName === expected.memberName &&
      candidate.laneId === expected.laneId && candidate.runId === member.runtimeRunId &&
      candidate.runtimeSessionId === expected.sessionId,
  };
  const bound = Object.values(checks).every(value => value === true);
  return { kind: bound ? 'bound' : 'native_run_unavailable', checks,
    ...(bound ? { runtimeRunId: member.runtimeRunId } : {}) };
}

/** Diagnostics only: no runtime call, repair, polling, or admission decision. */
export async function captureRetainedHistoryIdentity(
  root: string, expected: RetainedHistoryIdentity, phase: string
): Promise<Diagnostic> {
  const teamDir = join(root, 'claude', 'teams', expected.teamName);
  const [launchState, freshness, runtimeStore] = await Promise.all([
    observe(join(teamDir, 'launch-state.json'), value => {
      const members = object(value.members), member = object(members[expected.memberName]);
      return { ...pick(value, ['version', 'teamName', 'publicationRunId', 'launchPhase']),
        memberCount: Object.keys(members).length, memberPresent: Object.hasOwn(members, expected.memberName),
        member: { ...pick(member, ['name', 'providerId', 'laneId', 'runtimeRunId', 'runtimeSessionId', 'bootstrapEvidenceSource']),
          candidatePresent: member.appManagedBootstrapCandidate != null,
          candidate: pick(member.appManagedBootstrapCandidate, candidateKeys) } };
    }),
    observe(join(teamDir, 'launch-freshness.json'), value => {
      const rows = Array.isArray(value.transcriptBindings) ? value.transcriptBindings.map(object) : [];
      const keys = rows.map(row => JSON.stringify([row.memberName, row.laneId]));
      const matches = rows.filter(row => row.memberName === expected.memberName && row.laneId === expected.laneId);
      const bindingsValid = Array.isArray(value.transcriptBindings) && rows.length <= 128 &&
        rows.every(row => identityKeys.every(key => exact(row[key]))) && new Set(keys).size === keys.length;
      return { ...pick(value, ['version', 'teamName', 'kind', 'runId', 'stopId', 'stoppedRunId']),
        stoppedRunIdValid: exact(value.stoppedRunId), bindingsPresent: Object.hasOwn(value, 'transcriptBindings'),
        bindingsArray: Array.isArray(value.transcriptBindings), bindingCount: rows.length,
        bindingsValid,
        targetBindingMatchesOriginal: bindingsValid && value.version === 1 && value.teamName === expected.teamName &&
          value.kind === 'stop' && exact(value.stopId) &&
          value.stoppedRunId === expected.publicationRunId && exact(expected.runtimeRunId) &&
          matches.length === 1 && matches[0]!.runId === expected.runtimeRunId && matches[0]!.sessionId === expected.sessionId,
        targetMatchCount: matches.length, targetBindings: matches.slice(0, 2).map(row => pick(row, identityKeys)),
        targetBindingsTruncated: matches.length > 2 };
    }),
    observe(join(root, 'legacy-runtime-data', 'opencode', 'session-store.json'), value => {
      const records = object(value.records);
      const key = expected.teamName + '::' + expected.laneId + '::' + expected.memberName;
      const current = object(records[key]);
      return { ...pick(value, ['schemaVersion']), recordCount: Object.keys(records).length,
        recordPresent: Object.hasOwn(records, key),
        record: { ...pick(current, runtimeKeys), profilePurpose: scalar(object(current.profileScope).purpose), profileProviderId: scalar(object(current.profileScope).providerId) } };
    }),
  ]);
  return { phase, expected: pick(expected, ['teamName', 'memberName', 'laneId', 'publicationRunId', 'runtimeRunId', 'sessionId', 'replyUuid']),
    nativeBinding: persistedNativeBinding(launchState, freshness, expected), launchState, freshness, runtimeStore };
}

/** Caller verifies exact source/Bun and confirms original cleanup before this read-only diagnostic. */
export function readRetainedOfflineHistory(input: {
  root: string; helperSource: string; bun: string; expected: RetainedHistoryIdentity; coldStoreSha256?: string;
}): Diagnostic {
  try {
    const output = execFileSync(input.bun, ['--no-env-file', '--no-install', '-e', OFFLINE_PROGRAM], {
      cwd: input.helperSource, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8',
      input: JSON.stringify({ root: input.root, expected: input.expected, coldStoreSha256: input.coldStoreSha256 }),
      timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return object(JSON.parse(output));
  } catch (error) { return { kind: 'diagnostic_process_error', error: finiteHistoryDiagnosticError(error) }; }
}

const OFFLINE_PROGRAM = String.raw`
const out = { kind: 'exception', phase: 'input' };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const scalar = value => typeof value === 'string' ? (value.length <= 256 ? value : { type: 'string', length: value.length }) : typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? value : null;
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, scalar(object(value)[key])]));
async function run() {
  const { root, expected, coldStoreSha256 } = JSON.parse(await Bun.stdin.text());
  out.phase = 'imports';
  const { join, sep } = await import('node:path');
  const { lstat } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { readOpenCodeAuthority, isKnownSessionStore } = await import('./src/services/opencode/OpenCodeAuthorityStoreRead.ts');
  const { OpenCodeOfflineSessionReader } = await import('./src/services/opencode/OpenCodeOfflineSessionReader.ts');
  const { areSameOpenCodeWorkspace } = await import('./src/services/opencode/OpenCodeBridgePath.ts');
  const dataRoot = join(root, 'legacy-runtime-data');
  const file = join(dataRoot, 'opencode', 'session-store.json');
  const statInfo = async path => {
    try { const value = await lstat(path); return { kind: value.isFile() ? 'file' : 'nonregular', size: value.size }; }
    catch (error) { return { kind: 'unreadable', ...pick(error, ['name', 'code']) }; }
  };
  out.phase = 'authority';
  out.storeStat = await statInfo(file);
  if (out.storeStat.kind === 'file' && out.storeStat.size > 1024 * 1024) { out.kind = 'store_oversize'; return; }
  const authority = await readOpenCodeAuthority(file, isKnownSessionStore);
  out.authority = pick(authority, ['kind', 'reason']);
  if (authority.kind !== 'known') { out.kind = 'store_refused'; return; }
  const sha256 = createHash('sha256').update(authority.bytes).digest('hex');
  out.authority.sha256 = sha256;
  out.authority.sameBytesAsFailedColdRead = typeof coldStoreSha256 === 'string' ? sha256 === coldStoreSha256 : null;
  const key = expected.teamName + '::' + expected.laneId + '::' + expected.memberName;
  const record = object(authority.value.records[key]);
  out.recordPresent = Object.hasOwn(authority.value.records, key);
  out.record = {
    ...pick(record, ['teamId', 'memberName', 'providerId', 'laneId', 'runId', 'opencodeSessionId', 'opencodeVersion', 'profileRootKey', 'projectPath', 'stoppedAt', 'staleReason']),
    profilePurpose: scalar(object(record.profileScope).purpose), profileProviderId: scalar(object(record.profileScope).providerId)
  };
  out.nativeRunIdKnown = typeof expected.runtimeRunId === 'string' && expected.runtimeRunId.length > 0 &&
    expected.runtimeRunId.length <= 256 && expected.runtimeRunId.trim() === expected.runtimeRunId && !expected.runtimeRunId.includes('\0');
  out.identityMatches = out.nativeRunIdKnown && record.providerId === 'opencode' && record.teamId === expected.teamName &&
    record.memberName === expected.memberName && (record.laneId ?? 'primary') === expected.laneId &&
    record.runId === expected.runtimeRunId && record.opencodeSessionId === expected.sessionId;
  out.v1DispatchEligible = record.opencodeVersion === undefined ||
    typeof record.opencodeVersion === 'string' && /^1\./.test(record.opencodeVersion);
  out.originalOfflineFirstEligible = typeof record.opencodeVersion === 'string' && record.opencodeVersion.startsWith('1.');
  if (!out.nativeRunIdKnown) { out.kind = 'native_run_unavailable'; return; }
  if (!out.identityMatches || !out.v1DispatchEligible) { out.kind = 'record_refused'; return; }
  out.phase = 'database_stat';
  const reader = new OpenCodeOfflineSessionReader(dataRoot);
  const dbPath = reader.resolveDbPath(record.profileRootKey);
  out.dbPathResolved = dbPath !== null;
  if (dbPath !== null) {
    out.dbUnderTestDataRoot = dbPath.startsWith(dataRoot + sep);
    if (!out.dbUnderTestDataRoot) { out.kind = 'unsafe_database_path'; return; }
    out.database = await statInfo(dbPath);
    out.wal = await statInfo(dbPath + '-wal');
  }
  out.phase = 'offline_read';
  const result = await reader.readSession({
    profileRootKey: record.profileRootKey, projectPath: record.projectPath, opencodeSessionId: record.opencodeSessionId
  });
  if (!result) { out.kind = 'reader_null'; return; }
  const session = object(result.sessionIdentity);
  const directoryPresent = typeof session.directory === 'string' && session.directory.length > 0;
  const directoryMatches = directoryPresent && areSameOpenCodeWorkspace({
    expectedWorkspaceRoot: record.projectPath, recordProjectPath: session.directory
  });
  out.kind = 'reader_result';
  out.historyShape = scalar(result.historyShape);
  out.historyComplete = scalar(result.historyComplete);
  out.counts = { rawMessages: result.rawMessages.length, rawParts: result.rawParts.length, normalizedMessages: result.messages.length };
  out.expectedReplyUuid = {
    raw: result.rawMessages.some(row => row.id === expected.replyUuid),
    normalized: result.messages.some(message => message.info?.id === expected.replyUuid)
  };
  out.sessionIdentity = { ...pick(session, ['sessionId', 'projectId', 'directory', 'snapshotEvidenceSupported']), directoryMatches };
  out.gate = {
    messagesPresent: result.messages.length > 0, shapeSupported: result.historyShape === 'supported',
    complete: result.historyComplete === true, sessionMatches: session.sessionId === record.opencodeSessionId,
    directoryPresent, directoryMatches
  };
  out.gate.all = Object.values(out.gate).every(value => value === true);
  const prefixes = new Set(['unsupported-opencode-history-shape', 'sqlite-busy', 'snapshot-project-identity-missing',
    'snapshot-project-not-git', 'snapshot-session-directory-outside-worktree', 'snapshot-project-worktree-mismatch',
    'snapshot-window-missing', 'snapshot-window-ambiguous', 'snapshot-patch-part-malformed',
    'snapshot-patch-part-paths-unavailable', 'snapshot-patch-part-unsafe-path']);
  const patterns = [
    ['message_cap', /message cap exceeded/], ['part_cap', /part cap exceeded/],
    ['message_json_cap', /message row .* exceeded JSON size cap/], ['part_json_cap', /part row .* exceeded JSON size cap/],
    ['sqlite_read_failed', /^OpenCode SQLite read failed/], ['message_json_invalid', /message row .* contains invalid JSON/],
    ['part_json_invalid', /part row .* contains invalid JSON/], ['tool_name_missing', /toolpart .* missing tool name/],
    ['session_identity_columns_missing', /SQLite session identity columns are unavailable/],
    ['session_identity_row_missing', /SQLite session row is unavailable/],
    ['session_identity_read_failed', /SQLite session identity read failed/],
    ['snapshot_changed', /SQLite file changed while snapshot was read/]
  ];
  const codes = new Set();
  let unclassified = 0;
  for (const diagnostic of result.diagnostics) {
    let classified = false;
    const prefix = /^([a-z][a-z0-9-]{0,80}):/.exec(diagnostic)?.[1];
    if (prefix && prefixes.has(prefix)) { codes.add(prefix); classified = true; }
    const column = /OpenCode SQLite (message|part)\.(id|session_id|message_id|time_created|time_updated|data) missing/.exec(diagnostic);
    if (column) { codes.add('missing_' + column[1] + '_' + column[2]); classified = true; }
    for (const [code, pattern] of patterns) if (pattern.test(diagnostic)) { codes.add(code); classified = true; }
    if (!classified) unclassified++;
  }
  out.diagnostics = { count: result.diagnostics.length, codes: [...codes], unclassified };
  out.phase = 'complete';
}
let output;
try { await run(); output = JSON.stringify(out); }
catch (error) { output = JSON.stringify({ ...out, kind: 'exception', error: pick(error, ['name', 'code', 'errno']) }); }
console.log(output);
`;
