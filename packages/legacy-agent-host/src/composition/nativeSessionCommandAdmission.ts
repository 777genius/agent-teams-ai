import { TeamOwnerError } from '../team/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { nativeCommandMessage, parseNativeSessionCommand } from '../team/nativeSessionCommand.js';
import type { TeamCommand } from '../team/contracts.js';
import type { RuntimeDelivery } from '../runtime/contracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';

function capability(entry: MemberEntry, name: string): boolean {
  return (
    entry.profile.provider === 'claude' &&
    entry.provider?.isReady() === true &&
    entry.provider.sessionCommands?.().some((command) => command.name === name) === true
  );
}

/** New human submission only; completed original command lookup happens before this check. */
export function assertNativeSessionCommand(
  options: {
    team: HostedTeam;
    entries: Iterable<MemberEntry>;
    runtime: Pick<RuntimeOwner, 'readCapturedSession'>;
    isCurrent(entry: MemberEntry): boolean;
  },
  command: TeamCommand
): void {
  const native = nativeCommandMessage(command);
  if (!native || command.operation !== 'message.send') return;
  const member = options.team.connection
    .readRoster()
    .members.find((row) => row.name === command.payload.to);
  if (!member || member.role !== 'lead' || command.payload.attachments?.length)
    throw new TeamOwnerError('invalid');
  const entries = [...options.entries].filter(
    (entry) =>
      entry.binding.teamId === options.team.definition.binding.teamId &&
      entry.profile.memberId === member.memberId &&
      options.isCurrent(entry)
  );
  const entry = entries.length === 1 ? entries[0] : undefined;
  if (!entry || !capability(entry, native.name)) throw new TeamOwnerError('invalid');
  const { record, attached } = options.runtime.readCapturedSession(entry.binding);
  if (
    !record ||
    !attached ||
    !record.nativeReady ||
    record.sealed ||
    record.phase !== 'allocated' ||
    record.custody !== 'owned' ||
    runtimeDigest(record.binding) !== runtimeDigest(entry.binding) ||
    Buffer.byteLength(native.raw) > entry.profile.limits.inputBytes
  )
    throw new TeamOwnerError('hold');
}

/** Defense in depth for recovered/out-of-band deliveries; Team already verified the exact receipt. */
export function nativeSessionCommandAuthorized(
  entry: MemberEntry,
  intent: RuntimeDelivery
): boolean {
  const native = parseNativeSessionCommand(intent.content);
  if (!native) return true;
  if (!capability(entry, native.name) || intent.attachments?.length) return false;
  try {
    return nativeSessionCommandCause(entry, intent)?.command.raw === native.raw;
  } catch {
    return false;
  }
}

/** Original Team receipt supplies actor/role and message identity; Runtime never invents these fields. */
export function nativeSessionCommandCause(entry: MemberEntry, intent: RuntimeDelivery) {
  const cause = entry.team.owner.lookupToolInputCause(entry.profile.principalId, intent);
  if (!cause || !('messageCommandId' in cause)) return;
  const receipt = entry.team.connection.lookup(cause.messageCommandId);
  if (!receipt || receipt.phase !== 'completed' || receipt.command.operation !== 'message.send')
    return;
  const command = nativeCommandMessage(receipt.command);
  if (
    !command ||
    command.raw !== intent.content.trim() ||
    receipt.command.payload.attachments?.length
  )
    return;
  const identity = entry.team.owner.crossTeamIdentity(receipt.principalId, true);
  const member = identity.members.find((row) => row.memberId === intent.binding.memberId);
  if (
    identity.actor !== 'user' ||
    identity.revision !== receipt.authorityRevision ||
    member?.role !== 'lead' ||
    runtimeDigest(intent.binding) !== runtimeDigest(entry.binding)
  )
    return;
  return { command, receipt, member };
}
