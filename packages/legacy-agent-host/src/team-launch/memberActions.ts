import { runtimeDigest as digest } from '../runtime/identity.js';
import { TeamLaunchError } from './contracts.js';
import type {
  ExpectedLaunchMember,
  LaunchAttempt,
  TeamLaunchRecord,
} from './contracts.js';
export interface MemberActionInput {
  commandId: string;
  launchId: string;
  rosterRevision: string;
  memberId: string;
  expectedGeneration: string | null;
  action: 'restart' | 'skip';
}
export interface MemberActionActor {
  principalId: string;
  authorityRevision: number;
  inputAuthority?: string;
}
export interface MemberActionRecord {
  input: MemberActionInput;
  actor: MemberActionActor;
  noAllocation: boolean;
  sourceAttemptId: string;
  fingerprint: string;
  source: ExpectedLaunchMember;
  selected: ExpectedLaunchMember;
  phase: 'prepared' | 'requested' | 'closed' | 'unallocated' | 'selected' | 'refused';
}
export type ActionLaunchRecord = TeamLaunchRecord & { memberActions?: MemberActionRecord[] };
export interface MemberActionJournal {
  authorized<T>(action: 'read' | 'control', fn: () => T): T;
  read(): ActionLaunchRecord;
  captureActor(): MemberActionActor;
  observe(
    memberId: string
  ): import('./contracts.js').RuntimeLaunchObservation;
  /** Selection writes update the existing owner's in-memory definition/fingerprint too. */
  write(record: ActionLaunchRecord): void;
  initial(member: ExpectedLaunchMember, attemptId: string): LaunchAttempt;
}
export type MemberActionAuthority = Pick<MemberActionJournal, 'authorized' | 'captureActor'>;
function fail(reason: string, code: 'invalid' | 'conflict' | 'hold' = 'hold'): never {
  throw new TeamLaunchError(code, reason);
}
const id = (value: string) => {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))
    fail('member-action-identity', 'invalid');
};
const sameMember = (a: ExpectedLaunchMember, b: ExpectedLaunchMember) =>
  a.memberId === b.memberId &&
  (a.binding === null || b.binding === null
    ? a.binding === b.binding
    : ['backendId', 'teamId', 'runId', 'memberId'].every(
        (k) => a.binding![k as 'memberId'] === b.binding![k as 'memberId']
      ));
const shape = (member: ExpectedLaunchMember, strictNative: boolean) => {
  id(member.memberId);
  if (
    typeof member.skipped !== 'boolean' ||
    !Number.isSafeInteger(member.timeoutMs) ||
    member.timeoutMs < 1 ||
    member.timeoutMs > 300000
  )
    fail('member-action-record');
  if (member.binding && member.binding.memberId !== member.memberId) fail('member-action-record');
  if (
    strictNative &&
    (!member.binding ||
      !Number.isSafeInteger(member.runtimeGeneration) ||
      member.runtimeGeneration! < 0 ||
      !/^[a-f0-9]{64}$/.test(member.configurationDigest ?? '') ||
      !/^[a-f0-9]{64}$/.test(member.baseConfigurationDigest ?? '') ||
      !/^[a-f0-9]{64}$/.test(member.contextDigest ?? '') ||
      !member.configRevision)
  )
    fail('member-action-record');
};
const noNativeAllocation = (observed: ReturnType<MemberActionJournal['observe']>) =>
  !observed.attached &&
  (!observed.record ||
    ((observed.record.phase === 'unopened' || observed.record.phase === 'closed') &&
      observed.record.custody === 'released' &&
      observed.record.config === null &&
      observed.record.openFingerprint === null));
const fingerprint = (row: Omit<MemberActionRecord, 'fingerprint' | 'phase'>) =>
  digest({
    input: row.input,
    actor: row.actor,
    noAllocation: row.noAllocation,
    sourceAttemptId: row.sourceAttemptId,
    source: row.source,
    selected: row.selected,
  });
/** Strict immutable action records in the existing launch file, never another state store. */
export function validateMemberActions(record: ActionLaunchRecord): void {
  const rows = record.memberActions ?? [];
  if (
    !Array.isArray(rows) ||
    rows.length > 64 ||
    Buffer.byteLength(JSON.stringify(record)) > 1024 * 1024
  )
    fail('member-action-budget');
  const commands = new Set<string>(),
    pending = new Set<string>();
  for (const row of rows) {
    const input = row.input;
    if (!input || !['restart', 'skip'].includes(input.action)) fail('member-action-record');
    for (const value of [input.commandId, input.launchId, input.rosterRevision, input.memberId])
      id(value);
    if (
      !row.actor ||
      typeof row.actor.principalId !== 'string' ||
      !row.actor.principalId ||
      !Number.isSafeInteger(row.actor.authorityRevision) ||
      row.actor.authorityRevision < 1
    )
      fail('member-action-actor');
    id(row.actor.principalId);
    if (row.actor.inputAuthority !== undefined && !/^[a-f0-9]{64}$/.test(row.actor.inputAuthority))
      fail('member-action-actor');
    if (input.expectedGeneration !== null) id(input.expectedGeneration);
    if (typeof row.noAllocation !== 'boolean' || (row.noAllocation && input.action !== 'skip'))
      fail('member-action-proof');
    id(row.sourceAttemptId);
    shape(row.source, !row.noAllocation);
    shape(row.selected, !row.noAllocation);
    if (
      commands.has(input.commandId) ||
      input.launchId !== record.definition.launchId ||
      input.memberId !== row.source.memberId ||
      input.memberId !== row.selected.memberId ||
      input.expectedGeneration !== (row.source.binding?.generation ?? null) ||
      !sameMember(row.source, row.selected) ||
      !['prepared', 'requested', 'closed', 'unallocated', 'selected', 'refused'].includes(
        row.phase
      ) ||
      row.fingerprint !== fingerprint(row) ||
      (row.phase === 'unallocated' && !row.noAllocation) ||
      row.source.baseConfigurationDigest !== row.selected.baseConfigurationDigest ||
      row.source.contextDigest !== row.selected.contextDigest ||
      row.source.configRevision !== row.selected.configRevision ||
      row.source.timeoutMs !== row.selected.timeoutMs
    )
      fail('member-action-record');
    if (input.action === 'restart') {
      if (
        row.selected.skipped ||
        row.selected.restore ||
        row.selected.binding!.generation !==
          `restart-${digest({ commandId: input.commandId, sourceBinding: row.source.binding })}` ||
        row.selected.runtimeGeneration !== row.source.runtimeGeneration! + 1
      )
        fail('member-action-binding');
    } else if (
      !row.selected.skipped ||
      row.source.skipped ||
      digest({ ...row.source, skipped: true }) !== digest(row.selected)
    )
      fail('member-action-skip');
    if (row.phase !== 'selected' && row.phase !== 'refused') {
      if (pending.has(input.memberId)) fail('member-action-pending');
      pending.add(input.memberId);
      const current = record.definition.members.find((m) => m.memberId === input.memberId);
      if (digest(current) !== digest(row.source)) fail('member-action-source');
    }
    commands.add(input.commandId);
  }
}
/** One validated selection chain combines checkpoint restores and fresh actions without relabelling either. */
export function validateMemberSelectionChain(record: ActionLaunchRecord): void {
  validateMemberActions(record);
  const actions = (record.memberActions ?? []).filter((r) => r.phase === 'selected');
  for (const current of record.definition.members) {
    const selections = [
      ...(record.restorations ?? [])
        .filter((r) => r.member.memberId === current.memberId)
        .map((r) => ({ source: r.member.restore!.sourceBinding, member: r.member })),
      ...actions
        .filter((r) => r.input.memberId === current.memberId && r.input.action === 'restart')
        .map((r) => ({ source: r.source.binding!, member: r.selected })),
    ];
    if (!selections.length) {
      const skip = actions
        .filter((r) => r.input.memberId === current.memberId && r.input.action === 'skip')
        .at(-1);
      if (skip && digest(skip.selected) !== digest(current)) fail('member-action-current');
      continue;
    }
    const bySource = new Map<string, (typeof selections)[number]>(),
      targets = new Set<string>();
    for (const selection of selections) {
      const source = selection.source,
        next = selection.member;
      if (
        !next.binding ||
        source.generation === next.binding.generation ||
        ['backendId', 'teamId', 'runId', 'memberId'].some(
          (k) => source[k as 'memberId'] !== next.binding![k as 'memberId']
        ) ||
        bySource.has(digest(source)) ||
        targets.has(digest(next.binding))
      )
        fail('member-selection-chain');
      bySource.set(digest(source), selection);
      targets.add(digest(next.binding));
    }
    const roots = selections.filter((s) => !targets.has(digest(s.source)));
    if (roots.length !== 1) fail('member-selection-chain');
    let selected = roots[0]!,
      count = 1;
    const seen = new Set<string>();
    while (bySource.has(digest(selected.member.binding))) {
      const key = digest(selected.member.binding);
      if (seen.has(key)) fail('member-selection-cycle');
      seen.add(key);
      const next = bySource.get(key)!;
      if (
        next.member.runtimeGeneration! <= selected.member.runtimeGeneration! ||
        next.member.baseConfigurationDigest !== selected.member.baseConfigurationDigest ||
        next.member.contextDigest !== selected.member.contextDigest ||
        next.member.configRevision !== selected.member.configRevision
      )
        fail('member-selection-recipe');
      selected = next;
      count++;
    }
    if (count !== selections.length) fail('member-selection-chain');
    const skip = actions
      .filter(
        (r) =>
          r.input.memberId === current.memberId &&
          r.input.action === 'skip' &&
          digest(r.source.binding) === digest(selected.member.binding)
      )
      .at(-1);
    if (digest(skip?.selected ?? selected.member) !== digest(current))
      fail('member-selection-current');
  }
}
export function memberActionBlocksSelection(record: ActionLaunchRecord, memberId: string): boolean {
  return (record.memberActions ?? []).some(
    (a) => a.input.memberId === memberId && !['selected', 'refused'].includes(a.phase)
  );
}
export function memberActionBlocksStart(record: ActionLaunchRecord, memberId: string): boolean {
  return (record.memberActions ?? []).some(
    (a) => a.input.memberId === memberId && ['requested', 'closed', 'unallocated'].includes(a.phase)
  );
}
export function createLaunchMemberActions(journal: MemberActionJournal) {
  const read = () => {
    const r = journal.read();
    validateMemberActions(r);
    return r;
  };
  const select = (r: ActionLaunchRecord, commandId: string) =>
    r.memberActions?.find((a) => a.input.commandId === commandId);
  const lookup = (commandId: string) =>
    journal.authorized('read', () => {
      id(commandId);
      return structuredClone(select(read(), commandId) ?? null);
    });
  return {
    lookup,
    source(memberId: string) {
      return journal.authorized('read', () => {
        const selected = read().definition.members.find((m) => m.memberId === memberId);
        if (!selected) fail('member-action-source', 'invalid');
        return structuredClone(selected);
      });
    },
    read(memberId: string) {
      return journal.authorized('read', () => {
        const record = read();
        const member = record.definition.members.find((m) => m.memberId === memberId);
        if (!member) fail('member-action-source', 'invalid');
        return structuredClone({
          launchId: record.definition.launchId,
          rosterRevision: record.definition.rosterRevision,
          member,
          actions: (record.memberActions ?? []).filter((r) => r.input.memberId === memberId),
          retries: record.retries
            .filter((r) => r.memberIds.includes(memberId))
            .map((r) => ({
              commandId: r.commandId,
              attemptId: r.attemptId,
              current:
                record.members.find((m) => m.memberId === memberId)?.currentAttemptId ===
                r.attemptId,
            })),
        });
      });
    },
    pending(memberId: string) {
      return journal.authorized('read', () =>
        structuredClone(
          (read().memberActions ?? []).filter(
            (r) => r.input.memberId === memberId && r.phase !== 'selected' && r.phase !== 'refused'
          )
        )
      );
    },
    prepare(input: MemberActionInput, selected: ExpectedLaunchMember) {
      const original = lookup(input.commandId);
      if (original) {
        if (
          digest(original.input) !== digest(input) ||
          digest(original.selected) !== digest(selected)
        )
          fail('member-action-command', 'conflict');
        return { created: false, record: original };
      }
      const before = journal.authorized('control', () => structuredClone(read()));
      const beforeMember = before.members.find((m) => m.memberId === input.memberId);
      if (!beforeMember) fail('member-action-source', 'invalid');
      const beforeAttempt = beforeMember.attempts.find(
        (a) => a.attemptId === beforeMember.currentAttemptId
      )!;
      const noAllocation =
        input.action === 'skip' &&
        (!beforeAttempt.claimed || beforeAttempt.noAllocation) &&
        noNativeAllocation(journal.observe(input.memberId));
      return journal.authorized('control', () => {
        const record = read(),
          known = select(record, input.commandId);
        if (known) {
          if (digest(known.input) !== digest(input) || digest(known.selected) !== digest(selected))
            fail('member-action-command', 'conflict');
          return { created: false, record: structuredClone(known) };
        }
        if (
          input.launchId !== record.definition.launchId ||
          input.rosterRevision !== record.definition.rosterRevision
        )
          fail('member-action-scope', 'conflict');
        const source = record.definition.members.find((m) => m.memberId === input.memberId);
        if (
          !source ||
          (source.binding?.generation ?? null) !== input.expectedGeneration ||
          (input.action === 'restart' && !source.binding)
        )
          fail('member-action-source', 'conflict');
        if (
          (record.memberActions ?? []).some(
            (r) =>
              r.input.memberId === input.memberId && r.phase !== 'selected' && r.phase !== 'refused'
          )
        )
          fail('member-action-unresolved');
        if ((record.memberActions?.length ?? 0) >= 64) fail('member-action-budget');
        const target = record.members.find((m) => m.memberId === input.memberId);
        if (!target || target.attempts.length >= 65) fail('member-action-attempt-budget');
        if (
          target.currentAttemptId !== beforeMember.currentAttemptId ||
          digest(source) !==
            digest(before.definition.members.find((m) => m.memberId === input.memberId))
        )
          fail('member-action-source', 'conflict');
        if (!source.binding && !noAllocation) fail('member-action-no-allocation');
        const value: MemberActionRecord = {
          input: structuredClone(input),
          actor: journal.captureActor(),
          noAllocation,
          sourceAttemptId: target.currentAttemptId,
          source: structuredClone(source),
          selected: structuredClone(selected),
          phase: 'prepared',
          fingerprint: '',
        };
        value.fingerprint = fingerprint(value);
        (record.memberActions ??= []).push(value);
        validateMemberActions(record);
        journal.write(record);
        return { created: true, record: structuredClone(value) };
      });
    },
    proveNoAllocation(commandId: string) {
      const action = lookup(commandId);
      if (!action?.noAllocation) return false;
      const original = journal.authorized('read', () => {
        const record = read(),
          member = record.members.find((m) => m.memberId === action.input.memberId);
        return (
          !!member &&
          member.currentAttemptId === action.sourceAttemptId &&
          digest(record.definition.members.find((m) => m.memberId === action.input.memberId)) ===
            digest(action.source)
        );
      });
      return original && noNativeAllocation(journal.observe(action.input.memberId));
    },
    refusePrepared(commandId: string) {
      return journal.authorized('control', () => {
        const record = read(),
          action = select(record, commandId);
        if (!action) fail('member-action-missing');
        if (action.phase === 'prepared') {
          action.phase = 'refused';
          journal.write(record);
        }
        return structuredClone(action);
      });
    },
    request(commandId: string) {
      return journal.authorized('control', () => {
        const record = read(),
          action = select(record, commandId);
        if (!action) fail('member-action-missing');
        if (action.phase !== 'prepared') return { created: false, record: structuredClone(action) };
        const member = record.members.find((m) => m.memberId === action.input.memberId),
          attempt = member?.attempts.find((a) => a.attemptId === member.currentAttemptId);
        if (
          !member ||
          !attempt ||
          member.currentAttemptId !== action.sourceAttemptId ||
          (action.noAllocation && attempt.claimed && !attempt.noAllocation) ||
          digest(record.definition.members.find((m) => m.memberId === action.input.memberId)) !==
            digest(action.source) ||
          digest(action.actor) !== digest(journal.captureActor())
        ) {
          action.phase = 'refused';
          journal.write(record);
          return { created: false, record: structuredClone(action) };
        }
        action.phase = 'requested';
        journal.write(record);
        return { created: true, record: structuredClone(action) };
      });
    },
    closed(commandId: string, proveOriginalClosure: () => boolean) {
      if (!proveOriginalClosure()) fail('member-action-custody');
      return journal.authorized('control', () => {
        const record = read(),
          action = select(record, commandId);
        if (!action) fail('member-action-missing');
        if (action.phase === 'requested') {
          action.phase = 'closed';
          journal.write(record);
        }
        return structuredClone(action);
      });
    },
    unallocated(commandId: string) {
      if (!this.proveNoAllocation(commandId)) fail('member-action-no-allocation');
      return journal.authorized('control', () => {
        const record = read(),
          action = select(record, commandId);
        if (!action?.noAllocation || action.phase !== 'requested')
          fail('member-action-no-allocation');
        action.phase = 'unallocated';
        journal.write(record);
        return structuredClone(action);
      });
    },
    publish(commandId: string) {
      return journal.authorized('control', () => {
        const record = read(),
          action = select(record, commandId);
        if (!action) fail('member-action-missing');
        if (action.phase === 'selected') return structuredClone(action);
        if (action.phase !== 'closed' && action.phase !== 'unallocated')
          fail('member-action-custody');
        const current = record.definition.members.find((m) => m.memberId === action.input.memberId);
        if (digest(current) !== digest(action.source)) fail('member-action-source', 'conflict');
        record.definition.members[record.definition.members.indexOf(current!)] = structuredClone(
          action.selected
        );
        record.definition.rosterRevision = digest({
          scope: record.definition.rosterScope ?? record.definition.launchId,
          members: record.definition.members,
        });
        record.fingerprint = digest(record.definition);
        const member = record.members.find((m) => m.memberId === action.input.memberId)!;
        member.currentAttemptId = `action-${digest(commandId)}`;
        member.attempts.push(journal.initial(action.selected, member.currentAttemptId));
        action.phase = 'selected';
        validateMemberSelectionChain(record);
        journal.write(record);
        return structuredClone(action);
      });
    },
  };
}
