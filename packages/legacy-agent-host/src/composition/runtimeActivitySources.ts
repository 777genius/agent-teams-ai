import { RuntimeOwnerError } from '../runtime/contracts.js';
import { normalizeBinding, runtimeDigest } from '../runtime/identity.js';
import type { RuntimeBinding } from '../runtime/contracts.js';
import type { MemberEntry } from './MemberEntry.js';
import type { RetainedNativeLaunch } from './createRuntimeNativeMemberCreation.js';

export interface RuntimeActivitySource extends Pick<MemberEntry, 'binding' | 'team'> {
  /** Read-local native-session grouping. It is never persisted or returned in an activity DTO. */
  costScope?: string;
  /** Private original launch witness only; never persisted or used to grant access. */
  recordRequired?: boolean;
}
type Launches = ReadonlyMap<string, RetainedNativeLaunch>;
function fail(): never { throw new RuntimeOwnerError('hold'); }

/** Project only selections already validated by the original launch owner; no runnable entries. */
export function readEntryActivitySources(
  entry: MemberEntry,
  launches: Launches,
  currentSessionOnly = false
): RuntimeActivitySource[] {
  const currentKey = runtimeDigest(entry.binding);
  const retained = launches.get(runtimeDigest({
    teamId: entry.binding.teamId, launchId: entry.binding.runId,
  }));
  if (!retained) return [{ binding: entry.binding, team: entry.team, costScope: currentKey }];
  if (retained.team.definition.binding.backendId !== entry.binding.backendId ||
      retained.team.definition.binding.teamId !== entry.binding.teamId) fail();
  const selected = retained.launch.readActivityLineage(entry.binding.memberId);
  const liveSelections = selected.liveSelections;
  const member = runtimeDigest(selected.member.binding) === currentKey ? selected.member
    : liveSelections.find(row => runtimeDigest(row.source.binding) === currentKey)?.source;
  if (!member || !retained.entries.includes(entry) &&
      !liveSelections.some(row => runtimeDigest(row.source.binding) === currentKey)) fail();
  if (selected.launchId !== entry.binding.runId ||
      runtimeDigest(member.binding) !== currentKey ||
      member.configurationDigest !== runtimeDigest(entry.profile) ||
      member.baseConfigurationDigest !== runtimeDigest(entry.baseProfile) ||
      member.runtimeGeneration !== entry.profile.generation ||
      member.configRevision !== entry.config.configRevision) fail();
  if (selected.restorations.length > 64 || selected.actions.length > 64 || liveSelections.length > 64) fail();
  const required = new Set<string>(selected.recordRequired && selected.member.binding
    ? [runtimeDigest(selected.member.binding)] : []);
  const predecessors = new Map<string, { source: RuntimeBinding; resume: boolean }>();
  const add = (source: RuntimeBinding, target: RuntimeBinding, resume: boolean) => {
    source = normalizeBinding(source); target = normalizeBinding(target);
    if ((['backendId', 'teamId', 'runId', 'memberId'] as const).some(key =>
      source[key] !== entry.binding[key] || target[key] !== entry.binding[key])) fail();
    const key = runtimeDigest(target);
    if (key === runtimeDigest(source) || predecessors.has(key)) fail();
    predecessors.set(key, { source, resume });
  };
  for (const row of selected.restorations) {
    if (row.member.memberId !== entry.binding.memberId) continue;
    if (!row.member.binding || !row.member.restore) fail();
    add(row.member.restore.sourceBinding, row.member.binding, true);
    required.add(runtimeDigest(row.member.restore.sourceBinding));
  }
  for (const row of selected.actions) {
    if (row.phase === 'selected' && !row.noAllocation) {
      if (!row.source.binding) fail();
      required.add(runtimeDigest(row.source.binding));
    }
    if (row.phase !== 'selected' || row.input.action !== 'restart') continue;
    if (!row.source.binding || !row.selected.binding) fail();
    add(row.source.binding, row.selected.binding, false);
  }
  for (const row of liveSelections) {
    if (!row.member.binding) fail();
    if (!row.source.binding) continue; // Original unconfigured Skip has no historical Runtime.
    add(row.source.binding, row.member.binding, false);
    if (row.sourceRecordRequired) required.add(runtimeDigest(row.source.binding));
  }
  const reverse = [{ binding: entry.binding, resumed: false }];
  const seen = new Set<string>([currentKey]);
  while (predecessors.has(runtimeDigest(reverse.at(-1)!.binding))) {
    const next = reverse.at(-1)!, edge = predecessors.get(runtimeDigest(next.binding))!;
    if (currentSessionOnly && !edge.resume) break;
    const key = runtimeDigest(edge.source);
    if (seen.has(key) || reverse.length > 128) fail();
    seen.add(key); next.resumed = edge.resume;
    reverse.push({ binding: edge.source, resumed: false });
  }
  let scope = '';
  return reverse.reverse().map(({ binding, resumed }) => {
    if (!resumed) scope = runtimeDigest(binding);
    return { binding: structuredClone(binding), team: entry.team, costScope: scope,
      ...(required.has(runtimeDigest(binding)) ? { recordRequired: true } : {}) };
  });
}

/** Aggregate reads retain separate captures and fresh Restart segments without a second registry. */
export function readRuntimeActivitySources(
  entries: readonly MemberEntry[], launches: Launches, teamId: string
): RuntimeActivitySource[] {
  entries = entries.filter(entry => entry.binding.teamId === teamId);
  if (entries.length > 256) fail();
  const sources = new Map<string, RuntimeActivitySource>();
  for (const entry of entries) for (const source of readEntryActivitySources(entry, launches)) {
    const key = runtimeDigest(source.binding), prior = sources.get(key);
    if (prior && prior.costScope !== source.costScope) fail();
    sources.set(key, prior?.recordRequired ? { ...source, recordRequired: true } : source);
    if (sources.size > 256) fail();
  }
  return [...sources.values()];
}

/** Historical authorization is exact membership plus the caller's existing current Team read grant. */
export function isRetainedActivityBinding(
  binding: RuntimeBinding, entry: MemberEntry, launches: Launches
): boolean {
  const key = runtimeDigest(binding);
  return runtimeDigest(entry.binding) === key ||
    readEntryActivitySources(entry, launches).some(source => runtimeDigest(source.binding) === key);
}
