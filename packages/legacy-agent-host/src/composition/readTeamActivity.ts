import { z } from 'zod';
import { deliveryFingerprint, runtimeDigest } from '../runtime/identity.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { projectRuntimeActivity } from './runtimeActivityProjection.js';
import type { JsonValue } from '../contracts.js';
import type { MemberEntry, HostedTeam } from './MemberEntry.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TaskStartCause } from '../team/TaskStartCause.js';
import type { RuntimeDelivery } from '../runtime/contracts.js';
import type { RuntimeActivityEvent } from '../runtime/activityContracts.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\0\r\n]/u.test(value));
const query = z.union([z.object({ memberName: id }).strict(), z.object({ taskId: id }).strict()]);
export interface TeamActivityReadOptions {
  team: HostedTeam;
  principalId: string;
  entries: readonly Pick<MemberEntry, 'binding' | 'team'>[];
  taskCause(intent: RuntimeDelivery): TaskStartCause | null;
  runtime: Pick<RuntimeOwner, 'readCapturedSession' | 'readActivitySnapshot' | 'readActivityFeed'>;
  assertCurrent(): void;
}
export interface ActivityLog {
  kind: 'host_activity';
  sessionId: string;
  memberId: string;
  memberName: string;
  generation: string | null;
  taskId?: string;
  description: string;
  startTime: null;
  durationMs: null;
  messageCount: number;
  isOngoing: boolean | null;
  events: {
    eventId: string;
    sequence: number;
    inputId?: string;
    data: Record<string, JsonValue>;
  }[];
  gaps: string[];
  lastOutputPreview?: string;
}
/** Finite read of the existing retained event journal. Never creates inputs, sessions or another cursor store. */
export function readTeamActivity(options: TeamActivityReadOptions, raw: unknown): ActivityLog[] {
  options.assertCurrent();
  const selected = query.parse(raw),
    { team, principalId, runtime } = options;
  team.owner.withLaunchAuthority(principalId, 'read', () => undefined);
  const roster = team.connection.readRoster();
  const member =
    'memberName' in selected
      ? roster.members.find((value) => value.name === selected.memberName)
      : undefined;
  if ('memberName' in selected && !member) throw new RuntimeOwnerError('invalid');
  if ('taskId' in selected && !team.connection.getTask(selected.taskId))
    throw new RuntimeOwnerError('invalid');
  const sources = options.entries.filter(
    (entry) =>
      entry.team.definition.binding.teamId === team.definition.binding.teamId &&
      (!member || entry.binding.memberId === member.memberId)
  );
  if (sources.length > 256) throw new RuntimeOwnerError('hold');
  const logs: ActivityLog[] = [];
  let budget = 256 * 1024;
  for (const entry of sources) {
    options.assertCurrent();
    if (!team.owner.authorizeRuntimeAccess(principalId, entry.binding, 'read'))
      throw new RuntimeOwnerError('forbidden');
    const observed = runtime.readCapturedSession(entry.binding),
      record = observed.record;
    const snapshot = runtime.readActivitySnapshot(entry.binding);
    const gaps = new Set<string>(snapshot.gap ? [snapshot.gap.reason] : []);
    const bound = new Map((record?.inputs ?? []).map((input) => [input.intent.inputId, input]));
    const events: RuntimeActivityEvent[] = [];
    let cursor = { ...snapshot.cursor, sequence: Math.max(0, snapshot.retainedFrom - 1) };
    // Storage is capped at 256 events; page count and initial high water are fixed for this query.
    for (let page = 0; page < 4 && cursor.sequence < snapshot.cursor.sequence; page++) {
      options.assertCurrent();
      const feed = runtime.readActivityFeed(entry.binding, cursor);
      if (feed.gap) gaps.add(feed.gap.reason);
      for (const event of feed.events) {
        if (event.sequence > snapshot.cursor.sequence) break;
        if (event.inputId) {
          const input = bound.get(event.inputId);
          if (
            !input ||
            input.operationRef !== event.operationRef ||
            input.fingerprint !== deliveryFingerprint(input.intent) ||
            runtimeDigest(input.intent.binding) !== runtimeDigest(entry.binding)
          ) {
            gaps.add('unattributed input');
            continue;
          }
          if ('taskId' in selected) {
            const cause = options.taskCause(input.intent);
            if (!cause || cause.taskId !== selected.taskId) continue;
          }
        } else if ('taskId' in selected) continue;
        if (
          ![
            'text',
            'tool',
            'tool-result',
            'usage',
            'compaction',
            'result',
            'diagnostic',
            'gap',
            'subagent',
          ].includes(event.data.kind)
        )
          continue;
        events.push(event);
      }
      const next = feed.events.at(-1)?.sequence;
      if (next === undefined || next <= cursor.sequence) break;
      cursor = { ...cursor, sequence: next };
    }
    if (cursor.sequence < snapshot.cursor.sequence) gaps.add('bounded activity page limit');
    if (snapshot.retainedFrom > 1) gaps.add('earlier runtime activity is not retained');
    if (!record) gaps.add('runtime state unavailable');
    const projected = projectRuntimeActivity({
      memberId: entry.binding.memberId,
      source: {
        binding: snapshot.binding,
        cursor: snapshot.cursor,
        retainedFrom: snapshot.retainedFrom,
        events,
        hasMore: false,
      },
      requested: { ...snapshot.cursor, sequence: Math.max(0, snapshot.retainedFrom - 1) },
      nativeReady: snapshot.state?.nativeReady === true,
    }) as { events: ActivityLog['events'] };
    if (projected.events.length < events.length) gaps.add('bounded activity projection limit');
    const retained: ActivityLog['events'] = [];
    for (const event of projected.events) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (size > budget) {
        gaps.add('bounded activity byte limit');
        break;
      }
      budget -= size;
      retained.push(event);
    }
    if ('taskId' in selected && retained.length === 0) continue;
    const messages = new Set(
      retained
        .filter((event) => event.data.kind === 'text')
        .map((event) => `${event.inputId}:${String(event.data.messageRef)}`)
    );
    const output = retained.filter((event) => event.data.kind === 'text').at(-1)?.data.text;
    logs.push({
      kind: 'host_activity',
      sessionId: `host-activity-${runtimeDigest(entry.binding)}`,
      memberId: entry.binding.memberId,
      memberName:
        roster.members.find((value) => value.memberId === entry.binding.memberId)?.name ??
        entry.team.definition.members.find((value) => value.memberId === entry.binding.memberId)
          ?.name ??
        entry.binding.memberId,
      generation: entry.binding.generation,
      ...('taskId' in selected ? { taskId: selected.taskId } : {}),
      description: 'Captured runtime activity',
      startTime: null,
      durationMs: null,
      messageCount: messages.size,
      isOngoing: record
        ? observed.attached &&
          record.inputs.some((input) => ['claimed', 'consumed'].includes(input.phase))
        : null,
      events: retained,
      gaps: [...gaps],
      ...(typeof output === 'string' ? { lastOutputPreview: output.slice(-1000) } : {}),
    });
  }
  if (logs.length === 0)
    logs.push({
      kind: 'host_activity',
      sessionId: `host-activity-${runtimeDigest({ teamId: team.definition.binding.teamId, selected })}`,
      memberId: member?.memberId ?? '',
      memberName: member?.name ?? '',
      generation: null,
      ...('taskId' in selected ? { taskId: selected.taskId } : {}),
      description: 'Captured runtime activity',
      startTime: null,
      durationMs: null,
      messageCount: 0,
      isOngoing: null,
      events: [],
      gaps: ['No retained runtime activity is available for this selection.'],
    });
  options.assertCurrent();
  team.owner.withLaunchAuthority(principalId, 'read', () => undefined);
  return logs;
}

/** Reported units only. Per-operation token snapshots are deduplicated; cumulative session cost is never summed per turn. */
export function summarizeTeamActivity(memberName: string, logs: readonly ActivityLog[]) {
  const tools = new Map<string, string>(),
    messages = new Set<string>(),
    compactions = new Set<string>();
  const usage = new Map<string, Record<string, JsonValue>>(),
    costs = new Map<string, number>();
  const gaps = new Set(logs.flatMap((log) => log.gaps));
  let unattributedUsage = false;
  for (const log of logs)
    for (const event of log.events) {
      const data = event.data,
        scope = log.sessionId;
      if (data.kind === 'tool')
        tools.set(`${scope}:${event.inputId}:${String(data.toolRef)}`, String(data.name));
      if (data.kind === 'text')
        messages.add(`${scope}:${event.inputId}:${String(data.messageRef)}`);
      if (data.kind === 'compaction') compactions.add(`${scope}:${String(data.sourceRef)}`);
      if (data.kind === 'gap') gaps.add(String(data.reason));
      if (data.kind === 'usage') {
        if (event.inputId) usage.set(`${scope}:${event.inputId}`, data);
        else {
          unattributedUsage = true;
          gaps.add('token usage has no retained input attribution');
        }
        if (typeof data.cumulativeCostUsd === 'number') costs.set(scope, data.cumulativeCostUsd);
      }
    }
  const toolUsage: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const name of tools.values()) toolUsage[name] = (toolUsage[name] ?? 0) + 1;
  const tokens = (field: string) =>
    !unattributedUsage &&
    usage.size &&
    [...usage.values()].every((value) => typeof value[field] === 'number')
      ? [...usage.values()].reduce((total, value) => total + Number(value[field]), 0)
      : null;
  const generations = logs.filter((log) => log.generation !== null).length;
  return {
    kind: 'host_activity_stats' as const,
    memberName,
    scope: 'retained_runtime_activity' as const,
    generations,
    observedMessages: messages.size,
    toolUsage,
    compactions: compactions.size,
    inputTokens: tokens('inputTokens'),
    outputTokens: tokens('outputTokens'),
    costUsd:
      generations > 0 && costs.size === generations
        ? [...costs.values()].reduce((sum, cost) => sum + cost, 0)
        : null,
    gaps: [...gaps],
    computedAt: new Date().toISOString(),
  };
}
