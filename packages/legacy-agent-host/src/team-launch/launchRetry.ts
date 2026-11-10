import { TeamLaunchError } from './contracts.js';
import { runtimeDigest as digest } from '../runtime/identity.js';
import { memberActionBlocksSelection } from './memberActions.js';
import type {
  TeamLaunchRecord,
  TeamLaunchDefinition,
  LaunchMemberRecord,
  LaunchAttempt,
  ExpectedLaunchMember,
  TeamLaunchSummary,
} from './contracts.js';
import type { MemberActionActor, MemberActionAuthority } from './memberActions.js';
export interface LaunchRetryInput {
  commandId: string;
  attemptId: string;
  memberIds: string[];
  launchId: string;
  rosterRevision: string;
}
export interface NativeLaunchRetryAuthority extends MemberActionAuthority {
  assertCurrent(): void;
  captureTarget(memberId: string): () => void;
}
export interface LaunchRetryJournal {
  definition: TeamLaunchDefinition;
  load(): TeamLaunchRecord;
  write(record: TeamLaunchRecord): void;
  authorized<T>(action: 'read' | 'control', callback: () => T): T;
  project(record: TeamLaunchRecord): TeamLaunchRecord;
  current(member: LaunchMemberRecord): LaunchAttempt;
  initial(member: ExpectedLaunchMember, attemptId: string): LaunchAttempt;
  start(memberId: string, assertAuthority?: () => void): Promise<void> | undefined;
  summary(record: TeamLaunchRecord): TeamLaunchSummary;
}
const id = (value: string) => {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))
    throw new TeamLaunchError('invalid', 'id');
};
export function retryLaunchMember(
  journal: LaunchRetryJournal,
  input: LaunchRetryInput,
  native?: NativeLaunchRetryAuthority
): TeamLaunchSummary {
  id(input.commandId);
  id(input.attemptId);
  if (
    !input.memberIds.length ||
    input.memberIds.length > 256 ||
    new Set(input.memberIds).size !== input.memberIds.length ||
    input.launchId !== journal.definition.launchId ||
    input.rosterRevision !== journal.definition.rosterRevision
  )
    throw new TeamLaunchError('conflict', 'retry-scope');
  const authorized = native?.authorized ?? journal.authorized;
  const actor = native?.captureActor();
  native?.assertCurrent();
  const projected = journal.project(authorized('control', () => structuredClone(journal.load())));
  const fingerprint = digest({
    ...input,
    memberIds: [...input.memberIds].sort(),
    ...(actor ? { actor } : {}),
  });
  native?.assertCurrent();
  const duplicate = authorized('control', () => {
    const record = journal.load(),
      prior = record.retries.find(
        (row) => row.commandId === input.commandId || row.attemptId === input.attemptId
      );
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new TeamLaunchError('conflict', 'retry-identity');
      return true;
    }
    if (record.retries.length >= 64) throw new TeamLaunchError('hold', 'retry-budget');
    for (const memberId of input.memberIds) {
      if (memberActionBlocksSelection(record, memberId))
        throw new TeamLaunchError('hold', 'member-action-unresolved');
      const member = projected.members.find((m) => m.memberId === memberId),
        target = record.members.find((m) => m.memberId === memberId);
      if (!member || !target || member.currentAttemptId !== target.currentAttemptId)
        throw new TeamLaunchError('conflict', 'retry-member');
      const attempt = journal.current(member);
      if (attempt.status !== 'failed' || !attempt.noAllocation)
        throw new TeamLaunchError('hold', 'generation-replacement-required');
      if (target.attempts.some((a) => a.attemptId === input.attemptId))
        throw new TeamLaunchError('conflict', 'retry-identity');
    }
    for (const memberId of input.memberIds) {
      const target = record.members.find((m) => m.memberId === memberId)!,
        member = journal.definition.members.find((m) => m.memberId === memberId)!;
      target.currentAttemptId = input.attemptId;
      target.attempts.push(journal.initial(member, input.attemptId));
    }
    record.retries.push({
      commandId: input.commandId,
      attemptId: input.attemptId,
      memberIds: [...input.memberIds].sort(),
      fingerprint,
      ...(actor
        ? { native: { actor: structuredClone(actor), input: structuredClone(input) } }
        : {}),
    });
    journal.write(record);
    return false;
  });
  if (!duplicate)
    for (const memberId of input.memberIds)
      journal.start(memberId, native?.captureTarget(memberId));
  return journal.summary(
    journal.project(authorized('read', () => structuredClone(journal.load())))
  );
}
export function readNativeRetry(
  record: TeamLaunchRecord,
  commandId: string,
  memberId: string,
  actor: MemberActionActor
) {
  id(commandId);
  const row = record.retries.find((r) => r.commandId === commandId);
  if (!row) return null;
  if (
    !row.native ||
    row.memberIds.length !== 1 ||
    row.memberIds[0] !== memberId ||
    digest(row.native.actor) !== digest(actor)
  )
    throw new TeamLaunchError('forbidden', 'retry-actor');
  return {
    commandId: row.commandId,
    attemptId: row.attemptId,
    current: row.memberIds.every(
      (id) => record.members.find((m) => m.memberId === id)?.currentAttemptId === row.attemptId
    ),
  };
}
export function validateNativeRetries(record: TeamLaunchRecord): void {
  for (const row of record.retries) {
    if (!row.native) continue;
    const { actor, input } = row.native;
    if (
      !actor ||
      typeof actor.principalId !== 'string' ||
      !actor.principalId ||
      !Number.isSafeInteger(actor.authorityRevision) ||
      actor.authorityRevision < 1 ||
      !/^[a-f0-9]{64}$/.test(actor.inputAuthority ?? '') ||
      !input ||
      input.commandId !== row.commandId ||
      input.attemptId !== row.attemptId ||
      input.launchId !== record.definition.launchId ||
      digest([...input.memberIds].sort()) !== digest(row.memberIds) ||
      row.fingerprint !== digest({ ...input, memberIds: [...input.memberIds].sort(), actor })
    )
      throw new TeamLaunchError('hold', 'retry-native-corrupt');
  }
}
