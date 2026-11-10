import { RuntimeOwnerError } from '../runtime/contracts.js';
import type { JsonValue } from '../contracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';

/** Existing Lead views consume canonical captured observations; no transcript or native-JSON guesses. */
export function readLeadObservation(
  options: {
    team: HostedTeam | undefined;
    principalId: string;
    entries: readonly MemberEntry[];
    runtime: Pick<RuntimeOwner, 'readCapturedSession' | 'readActivitySnapshot'>;
    launch: { launchId: string; rosterRevision: string } | undefined;
    isCurrent(entry: MemberEntry): boolean;
    assertCurrent(): void;
  },
  kind: 'activity' | 'context'
): JsonValue {
  options.assertCurrent();
  const team = options.team;
  if (!team) throw new RuntimeOwnerError('invalid');
  const authorityRevision = team.owner.withLaunchAuthority(
    options.principalId,
    'read',
    (revision) => revision
  );
  const finish = (value: JsonValue, entry?: MemberEntry): JsonValue => {
    options.assertCurrent();
    if (entry && !options.isCurrent(entry)) throw new RuntimeOwnerError('hold');
    return team.owner.withLaunchAuthority(options.principalId, 'read', (revision) => {
      if (revision !== authorityRevision) throw new RuntimeOwnerError('forbidden');
      return value;
    });
  };
  const lead = team.connection.readRoster().members.find((member) => member.role === 'lead');
  const offline = (entry?: MemberEntry): JsonValue =>
    finish(
      kind === 'activity'
        ? { kind: 'team-lead-activity', state: 'offline', launch: null }
        : { kind: 'team-lead-context', usage: null, launch: null },
      entry
    );
  if (!lead) return offline();
  const candidates = options.entries.filter(
    (entry) =>
      entry.binding.teamId === team.definition.binding.teamId &&
      entry.binding.memberId === lead.memberId
  );
  const current = candidates.filter((entry) => options.isCurrent(entry));
  if (current.length > 1 || (!current.length && candidates.length))
    throw new RuntimeOwnerError('hold');
  const entry = current[0];
  if (!entry) return offline();
  if (!team.owner.authorizeRuntimeAccess(options.principalId, entry.binding, 'read'))
    throw new RuntimeOwnerError('forbidden');
  const captured = options.runtime.readCapturedSession(entry.binding),
    record = captured.record;
  if (!record || (record.custody === 'released' && ['unopened', 'closed'].includes(record.phase)))
    return offline(entry);
  if (
    !captured.attached ||
    record.sealed ||
    record.phase !== 'allocated' ||
    record.custody !== 'owned' ||
    !record.nativeReady ||
    record.inputs.some((input) => input.phase === 'unknown') ||
    !options.launch ||
    (entry.team.launchId !== undefined && entry.team.launchId !== options.launch.launchId)
  )
    throw new RuntimeOwnerError('hold');
  const launch = {
    launchId: options.launch.launchId,
    rosterRevision: options.launch.rosterRevision,
  };
  if (kind === 'activity')
    return finish(
      {
        kind: 'team-lead-activity',
        launch,
        state:
          record.control ||
          record.inputs.some((input) => ['claimed', 'consumed'].includes(input.phase))
            ? 'active'
            : 'idle',
      },
      entry
    );
  const snapshot = options.runtime.readActivitySnapshot(entry.binding);
  const last = [...snapshot.latest.usage].sort((a, b) => a.sequence - b.sequence).at(-1);
  if (
    snapshot.gap ||
    !last?.observedAt ||
    last.sequence <= (snapshot.latest.compaction?.sequence ?? 0)
  )
    return finish({ kind: 'team-lead-context', launch, usage: null }, entry);
  const output = last.data.outputTokens;
  if (
    output !== undefined &&
    (typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0)
  )
    throw new RuntimeOwnerError('hold');
  return finish(
    {
      kind: 'team-lead-context',
      launch,
      usage: {
        // SPI inputTokens has no cache/occupancy/source contract. Never pretend that
        // an uncached input count is the complete occupied prompt/context window.
        promptInputTokens: null,
        outputTokens: output ?? null,
        contextUsedTokens: null,
        contextWindowTokens: null,
        contextUsedPercent: null,
        promptInputSource: 'unavailable',
        updatedAt: last.observedAt,
      },
    },
    entry
  );
}
