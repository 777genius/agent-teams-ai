import { runtimeDigest } from '../runtime/identity.js';
import { TeamLaunchError } from './contracts.js';
import type { JsonValue } from '../contracts.js';
import type {
  ExpectedLaunchMember,
  LaunchAttempt,
  TeamLaunchDefinition,
  TeamLaunchRecord,
} from './contracts.js';

/** Private immutable addition in the original launch record, not a second launch/command journal. */
export interface NativeLaunchAddition {
  commandId: string;
  inputAuthority: string;
  rosterRevision: string;
  member: ExpectedLaunchMember;
  /** Same existing capture source and recipe references used to rebuild the one captured target. */
  capture: JsonValue;
  fingerprint: string;
}
type AdditionRecord = TeamLaunchRecord & {
  nativeAdditions?: NativeLaunchAddition[];
};
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256 && !value.includes('\0');

export function captureNativeLaunchAddition(
  input: Omit<NativeLaunchAddition, 'fingerprint'>
): NativeLaunchAddition {
  const value = structuredClone(input);
  if (
    !text(value.commandId) ||
    !hash(value.inputAuthority) ||
    !hash(value.rosterRevision) ||
    !value.member?.binding ||
    !text(value.member.memberId) ||
    value.member.memberId !== value.member.binding.memberId ||
    value.member.skipped ||
    !hash(value.member.configurationDigest) ||
    !hash(value.member.contextDigest) ||
    !text(value.member.configRevision) ||
    !Number.isSafeInteger(value.member.timeoutMs) ||
    value.member.timeoutMs < 1 ||
    value.member.timeoutMs > 300000 ||
    Buffer.byteLength(JSON.stringify(value.capture)) > 512 * 1024
  )
    throw new TeamLaunchError('invalid', 'native-addition');
  return { ...value, fingerprint: runtimeDigest(value) };
}

/** Caller holds the existing original Team authority/store fence; no async work or Runtime allocation. */
export function appendNativeLaunchMember(options: {
  record: AdditionRecord;
  input: Omit<NativeLaunchAddition, 'fingerprint'>;
  initial(member: ExpectedLaunchMember, attemptId: string): LaunchAttempt;
}): { record: AdditionRecord; fresh: boolean } {
  const original = options.record,
    addition = captureNativeLaunchAddition(options.input);
  const target = addition.member.binding!;
  if (
    target.runId !== original.definition.launchId ||
    original.definition.members.some(
      (row) =>
        row.binding &&
        ['backendId', 'teamId', 'runId'].some(
          (key) => row.binding![key as 'runId'] !== target[key as 'runId']
        )
    )
  )
    throw new TeamLaunchError('conflict', 'native-addition-run');
  validateNativeLaunchAdditions(original);
  const previous = original.nativeAdditions?.find((row) => row.commandId === addition.commandId);
  if (previous) {
    if (previous.fingerprint !== addition.fingerprint)
      throw new TeamLaunchError('conflict', 'native-addition-command');
    return { record: original, fresh: false };
  }
  if (
    original.definition.members.length >= 256 ||
    (original.nativeAdditions?.length ?? 0) >= 255 ||
    original.definition.members.some((row) => row.memberId === addition.member.memberId) ||
    original.retries.some((row) => row.commandId === addition.commandId) ||
    original.restorations?.some((row) => row.commandId === addition.commandId)
  )
    throw new TeamLaunchError('conflict', 'native-addition-member');
  const next = structuredClone(original),
    attemptId = `native-add-${runtimeDigest({ commandId: addition.commandId, memberId: addition.member.memberId })}`;
  next.definition.members.push(structuredClone(addition.member));
  next.definition.rosterRevision = runtimeDigest({
    scope: next.definition.rosterScope ?? next.definition.launchId,
    members: next.definition.members,
  });
  next.fingerprint = runtimeDigest(next.definition);
  next.members.push({
    memberId: addition.member.memberId,
    currentAttemptId: attemptId,
    attempts: [options.initial(addition.member, attemptId)],
  });
  next.nativeAdditions = [...(next.nativeAdditions ?? []), addition];
  validateNativeLaunchAdditions(next);
  return { record: next, fresh: true };
}

export function validateNativeLaunchAdditions(record: AdditionRecord): void {
  if (!Array.isArray(record.nativeAdditions ?? []) || (record.nativeAdditions?.length ?? 0) > 255)
    throw new TeamLaunchError('hold', 'native-addition-record');
  const commands = new Set<string>(),
    members = new Set<string>();
  for (const row of record.nativeAdditions ?? []) {
    const { fingerprint, ...input } = row;
    if (
      captureNativeLaunchAddition(input).fingerprint !== fingerprint ||
      commands.has(row.commandId) ||
      members.has(row.member.memberId) ||
      row.member.binding!.runId !== record.definition.launchId ||
      !record.definition.members.some((member) => member.memberId === row.member.memberId) ||
      !record.members.some((member) => member.memberId === row.member.memberId)
    )
      throw new TeamLaunchError('hold', 'native-addition-record');
    commands.add(row.commandId);
    members.add(row.member.memberId);
  }
}

/** Reconstruct the same expected roster before constructing its original launch owner. Never opens anything. */
export function nativeAdditionDefinition(
  base: TeamLaunchDefinition,
  record: AdditionRecord
): TeamLaunchDefinition {
  validateNativeLaunchAdditions(record);
  if (
    base.launchId !== record.definition.launchId ||
    runtimeDigest(record.definition) !== record.fingerprint
  )
    throw new TeamLaunchError('hold', 'native-addition-record');
  const ids = new Set((record.nativeAdditions ?? []).map((row) => row.member.memberId));
  const original = record.definition.members.filter((member) => !ids.has(member.memberId));
  if (
    runtimeDigest(original) !== runtimeDigest(base.members) ||
    runtimeDigest({
      ...record.definition,
      members: base.members,
      rosterRevision: base.rosterRevision,
    }) !== runtimeDigest(base)
  )
    throw new TeamLaunchError('hold', 'native-addition-base');
  return structuredClone(record.definition);
}
