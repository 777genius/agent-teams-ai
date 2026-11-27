import { z } from 'zod';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { readSessionActivityPage, readSessionConversationPage, readSessionInputsPage, sessionHistoryCursor } from './sessionHistoryPages.js';
import type { JsonValue } from '../contracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { HostedTeam } from './MemberEntry.js';
import type { RetainedNativeLaunch } from './createRuntimeNativeMemberCreation.js';
import type { RuntimeActivitySource } from './runtimeActivitySources.js';

const opaque = z.string().regex(/^host-session-[a-f0-9]{64}$/u);
export const sessionHistoryQuery = z.union([
  z.object({ scope: z.literal('sessions') }).strict(),
  z.object({
    scope: z.literal('session'),
    sessionId: opaque,
    stream: z.enum(['activity', 'conversation', 'inputs']),
    cursor: z.string().min(1).max(2048).optional(),
  }).strict(),
]);
export type SessionHistoryQuery = z.infer<typeof sessionHistoryQuery>;
export interface TeamSessionHistorySummary {
  kind: 'host_session';
  id: string;
  startedAt: number | null;
  window: { start: number; end: number | null } | null;
  clock: 'qualified' | 'unqualified';
  members: number;
  generations: number;
  isOngoing: boolean | null;
  gaps: string[];
}
export interface SessionHistorySource {
  source: RuntimeActivitySource;
  memberName: string;
  marker: string;
  nativeReady: boolean;
}
export interface TeamSessionHistoryReadOptions {
  team: HostedTeam;
  principalId: string;
  entries: readonly RuntimeActivitySource[];
  launches: ReadonlyMap<string, Pick<RetainedNativeLaunch, 'team' | 'launch'>>;
  runtime: Pick<RuntimeOwner, 'readCapturedSession' | 'readActivitySnapshot' | 'readActivityFeed' | 'readConversation'>;
  /** Volatile composition-owned key, never exposed by the public read port. */
  pageKey: string;
  assertCurrent(): void;
}
interface CapturedSession {
  summary: TeamSessionHistorySummary;
  sources: SessionHistorySource[];
  revision: string;
}
function fail(): never { throw new RuntimeOwnerError('hold'); }
const readAuthority = (options: TeamSessionHistoryReadOptions) => {
  options.assertCurrent();
  return options.team.owner.withLaunchAuthority(options.principalId, 'read', revision => revision);
};
/** Metadata reads inspect durable original launches and Runtime state, never global project sessions. */
function capture(options: TeamSessionHistoryReadOptions): CapturedSession[] {
  readAuthority(options);
  if (options.entries.length > 256) fail();
  const binding = options.team.definition.binding;
  const groups = new Map<string, { sources: SessionHistorySource[]; attached: boolean; unknown: boolean }>();
  const seen = new Set<string>();
  for (const source of options.entries) {
    readAuthority(options);
    if (source.binding.teamId !== binding.teamId || source.binding.backendId !== binding.backendId ||
        runtimeDigest(source.team.definition.binding) !== runtimeDigest(binding)) fail();
    const key = runtimeDigest(source.binding);
    if (seen.has(key)) fail();
    seen.add(key);
    const observed = options.runtime.readCapturedSession(source.binding), record = observed.record;
    if (!record && source.recordRequired) fail();
    if (record && runtimeDigest(record.binding) !== key) fail();
    // Never-opened configuration sentinels are not sessions.
    if (!observed.attached && (!record || record.config === null && record.inputs.length === 0)) continue;
    const member = source.team.definition.members.find(row => row.memberId === source.binding.memberId);
    if (!member) fail();
    const group = groups.get(source.binding.runId) ?? { sources: [], attached: false, unknown: false };
    group.attached ||= observed.attached;
    group.unknown ||= !record || record.custody === 'unknown';
    group.sources.push({
      source,
      memberName: member.name,
      nativeReady: record?.nativeReady === true,
      marker: runtimeDigest({
        binding: source.binding, open: record?.openFingerprint ?? null,
        activity: record?.activitySequence ?? 0, conversation: record?.conversation ?? null,
        phase: record?.phase ?? null, custody: record?.custody ?? null,
        inputs: record?.inputs.map(input => ({ fingerprint: input.fingerprint, phase: input.phase,
          terminal: input.terminal ?? null })) ?? [],
      }),
    });
    groups.set(source.binding.runId, group);
  }
  const sessions = [...groups].map(([launchId, group]): CapturedSession => {
    const retained = options.launches.get(runtimeDigest({ teamId: binding.teamId, launchId }));
    if (retained && runtimeDigest(retained.team.definition.binding) !== runtimeDigest(binding)) fail();
    const launch = retained?.launch.read();
    if (launch && launch.launchId !== launchId) fail();
    const started = launch?.startedAtMs;
    const startedAt = typeof started === 'number' && Number.isSafeInteger(started) && started >= 0 && started <= 8_640_000_000_000_000
      ? started : null;
    const id = 'host-session-' + runtimeDigest({ backendId: binding.backendId, teamId: binding.teamId, launchId });
    group.sources.sort((a, b) => runtimeDigest(a.source.binding).localeCompare(runtimeDigest(b.source.binding)));
    return {
      summary: { kind: 'host_session', id, startedAt, window: null, clock: 'unqualified',
        members: new Set(group.sources.map(row => row.source.binding.memberId)).size,
        generations: group.sources.length, isOngoing: group.attached ? true : group.unknown ? null : false,
        gaps: startedAt === null ? ['The original launch start time is unavailable.'] : [] },
      sources: group.sources,
      revision: runtimeDigest({ id, startedAt, sources: group.sources.map(row => row.marker) }),
    };
  });
  sessions.sort((a, b) => (b.summary.startedAt ?? 0) - (a.summary.startedAt ?? 0) ||
    a.summary.id.localeCompare(b.summary.id));
  // A missing or equal boundary cannot safely assign every task to a launch.
  const starts = sessions.map(row => row.summary.startedAt);
  const qualified = starts.every(value => value !== null) && new Set(starts).size === starts.length;
  for (let i = 0; i < sessions.length; i++) {
    const row = sessions[i]!;
    if (qualified) {
      row.summary.clock = 'qualified';
      row.summary.window = { start: row.summary.startedAt!, end: i === 0 ? null : sessions[i - 1]!.summary.startedAt! };
    } else if (row.summary.gaps.length === 0) {
      row.summary.gaps.push('Launch time boundaries are incomplete; task filtering is unavailable.');
    }
  }
  readAuthority(options);
  return sessions;
}
/** Retained launch history and bounded, original-source pages. No native selectors or new storage. */
export function readTeamSessionHistory(options: TeamSessionHistoryReadOptions, raw: unknown): JsonValue {
  const query = sessionHistoryQuery.parse(raw);
  const grantRevision = readAuthority(options);
  const sessions = capture(options);
  if (readAuthority(options) !== grantRevision) fail();
  const authority = runtimeDigest({ binding: options.team.definition.binding, principalId: options.principalId, grantRevision });
  const revision = runtimeDigest(sessions.map(row => ({ summary: row.summary, revision: row.revision })));
  if (query.scope === 'sessions') {
    const result = { kind: 'team-session-history', revision, sessions: sessions.map(row => row.summary) };
    if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) fail();
    return JSON.parse(JSON.stringify(result)) as JsonValue;
  }
  const selected = sessions.find(row => row.summary.id === query.sessionId);
  if (!selected) throw new RuntimeOwnerError('invalid');
  const pageRevision = runtimeDigest({ revision: selected.revision, window: selected.summary.window });
  const cursors = sessionHistoryCursor(options.pageKey, authority, query.sessionId, query.stream, pageRevision);
  const position = query.cursor === undefined ? { source: 0, offset: 0 } : cursors.read(query.cursor);
  if (position.source >= selected.sources.length) fail();
  const source = selected.sources[position.source]!;
  const page = query.stream === 'activity'
    ? readSessionActivityPage(options, source, position.offset)
    : query.stream === 'inputs' ? readSessionInputsPage(options, source, position.offset)
      : readSessionConversationPage(options, source, position.offset);
  const next = page.nextOffset !== null ? { source: position.source, offset: page.nextOffset }
    : position.source + 1 < selected.sources.length ? { source: position.source + 1, offset: 0 } : null;
  // A writer, capture, revoke, or retained-source change cannot publish a mixed page.
  const current = capture(options).find(row => row.summary.id === query.sessionId);
  if (!current || runtimeDigest({ revision: current.revision, window: current.summary.window }) !== pageRevision) fail();
  const result = {
    kind: 'team-session-page', sessionId: query.sessionId, stream: query.stream, revision: pageRevision,
    ...page.value, nextCursor: next ? cursors.write(next) : null,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) fail();
  if (readAuthority(options) !== grantRevision) fail();
  return JSON.parse(JSON.stringify(result)) as JsonValue;
}
