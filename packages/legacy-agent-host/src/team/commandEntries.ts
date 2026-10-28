import { validateGroupCommandReceipt } from '../group-chats/groupCommandRecords.js';
import type { GroupCommandReceipt } from '../group-chats/groupCommandRecords.js';
import { validateWorkSyncCommandReceipt } from '../work-sync/commandContracts.js';
import type { WorkSyncCommandReceipt } from '../work-sync/commandContracts.js';
import { validateQueuedDiscardReceipt } from './queuedDiscardContracts.js';
import type { QueuedDiscardReceipt } from './queuedDiscardContracts.js';
import { validateTeamLifecycleReceipt } from './lifecycleContracts.js';
import type { TeamLifecycleReceipt } from './lifecycleContracts.js';
import { validateProcessReceipt } from '../process/validateProcessRecords.js';
import type { ProcessCommandReceipt } from '../process/registeredProcessContracts.js';
import { validateCrossTeamCommandReceipt } from '../cross-team/TeamCrossTeamCommands.js';
import type { CrossTeamCommandReceipt } from '../cross-team/TeamCrossTeamCommands.js';
import { reviewMethodKind } from './reviewMethodKind.js';
import { isReviewWriterMethod } from '@agent-teams/task-change-ledger/review-transport';
import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import { validateTeamCommand, validateTeamText } from './validateTeamCommand.js';
import { teamCommandFingerprint } from './teamCommandFingerprint.js';
import type { CommandReceipt } from './contracts.js';
import type { ReviewCommandReceipt } from './reviewCommandContracts.js';
import type { TeamStore } from './ports.js';
export type TeamCommandEntry =
  | CommandReceipt
  | GroupCommandReceipt
  | ReviewCommandReceipt
  | CrossTeamCommandReceipt
  | ProcessCommandReceipt
  | WorkSyncCommandReceipt
  | TeamLifecycleReceipt
  | QueuedDiscardReceipt;
export function teamCommandPath(commandId: string): string {
  validateTeamText(commandId);
  if (commandId.length > 256) throw new TeamOwnerError('invalid');
  return `commands/${digest(commandId)}.json`;
}
export function reviewReceiptFingerprint(
  receipt: Omit<ReviewCommandReceipt, 'fingerprint'>
): string {
  return digest({
    family: 'review',
    binding: receipt.binding,
    commandId: receipt.commandId,
    principalId: receipt.principalId,
    origin: receipt.origin,
    method: receipt.method,
    requestDigest: receipt.requestDigest,
  });
}
/** Never silently skip malformed/unknown receipt families during recovery scans. */
export function validateCommandEntry(value: TeamCommandEntry): TeamCommandEntry {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      value.schemaVersion !== 1 ||
      typeof value.commandId !== 'string' ||
      !value.commandId ||
      value.commandId.length > 256 ||
      typeof value.principalId !== 'string' ||
      typeof value.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
      !value.binding
    )
      throw new TeamOwnerError('hold');
    if ('family' in value && value.family === 'group-chat')
      return validateGroupCommandReceipt(value);
    if ('family' in value && value.family === 'queued-discard')
      return validateQueuedDiscardReceipt(value);
    if ('family' in value && value.family === 'lifecycle')
      return validateTeamLifecycleReceipt(value);
    if ('family' in value && value.family === 'work-sync')
      return validateWorkSyncCommandReceipt(value);
    if ('family' in value && value.family === 'process')
      return validateProcessReceipt(value, digest);
    if ('family' in value && value.family === 'cross-team')
      return validateCrossTeamCommandReceipt(value);
    if ('family' in value) {
      if (
        value.family !== 'review' ||
        !['prepared', 'held', 'completed'].includes(value.phase) ||
        !value.origin ||
        (!value.origin.taskId && !value.origin.memberName) ||
        !/^[a-f0-9]{64}$/.test(value.requestDigest) ||
        !Number.isSafeInteger(value.authorityRevision) ||
        value.authorityRevision < 1 ||
        value.fingerprint !== reviewReceiptFingerprint(value)
      )
        throw new TeamOwnerError('hold');
      if (
        value.responseRef !== undefined &&
        (value.phase !== 'completed' ||
          value.response !== undefined ||
          !/^[a-f0-9]{64}$/.test(value.responseRef.sha256) ||
          !Number.isSafeInteger(value.responseRef.sizeBytes) ||
          value.responseRef.sizeBytes < 1 ||
          value.responseRef.sizeBytes > 32 * 1024 * 1024)
      )
        throw new TeamOwnerError('hold');
      if (
        value.recoveryScopeRef !== undefined &&
        (!/^[a-f0-9]{64}$/.test(value.recoveryScopeRef.sha256) ||
          !Number.isSafeInteger(value.recoveryScopeRef.sizeBytes) ||
          value.recoveryScopeRef.sizeBytes < 1 ||
          value.recoveryScopeRef.sizeBytes > 32 * 1024 * 1024)
      )
        throw new TeamOwnerError('hold');
      if (
        value.commitProof !== undefined &&
        (value.phase !== 'completed' ||
          !/^[a-f0-9-]{36}$/i.test(value.commitProof.walId) ||
          !Number.isSafeInteger(value.commitProof.decisionRevision) ||
          value.commitProof.decisionRevision < 1 ||
          typeof value.commitProof.kind !== 'string' ||
          (value.commitProof.actionId !== undefined &&
            typeof value.commitProof.actionId !== 'string'))
      )
        throw new TeamOwnerError('hold');
      if (
        value.response !== undefined &&
        (value.phase !== 'completed' ||
          value.response.kind !== 'review-writer' ||
          value.response.method !== value.method ||
          !Object.hasOwn(value.response, 'result') ||
          digest(value.response) !== value.responseDigest)
      )
        throw new TeamOwnerError('hold');
      if (!isReviewWriterMethod(value.method)) throw new TeamOwnerError('hold');
      return value;
    }
    if (!['prepared', 'applying', 'completed', 'rejected', 'held'].includes(value.phase))
      throw new TeamOwnerError('hold');
    validateTeamCommand(value.command);
    if (value.commandId !== value.command.commandId ||
      value.fingerprint !== teamCommandFingerprint(value)) throw new TeamOwnerError('hold');
    return value;
  } catch {
    throw new TeamOwnerError('hold');
  }
}
export function listTeamCommandEntries(store: TeamStore): TeamCommandEntry[] {
  return store
    .list<TeamCommandEntry>('commands')
    .map(validateCommandEntry)
    .filter(
      (entry) =>
        !('family' in entry) ||
        entry.family === 'group-chat' ||
        entry.family === 'cross-team' ||
        entry.family === 'process' ||
        entry.family === 'work-sync' ||
        entry.family === 'lifecycle' ||
        entry.family === 'queued-discard' ||
        reviewMethodKind(entry.method) === 'mutation'
    );
}
export function listProductCommandReceipts(store: TeamStore): CommandReceipt[] {
  return listTeamCommandEntries(store).filter(
    (entry): entry is CommandReceipt => !('family' in entry)
  );
}
export function productCommandReceipt(
  value: TeamCommandEntry | undefined
): CommandReceipt | undefined {
  if (!value) return undefined;
  const entry = validateCommandEntry(value);
  if ('family' in entry) throw new TeamOwnerError('conflict');
  return entry;
}

export function readProductCommand(
  store: TeamStore,
  commandId: string
): CommandReceipt | undefined {
  const receipt = productCommandReceipt(store.read(teamCommandPath(commandId)));
  if (receipt && receipt.commandId !== commandId) throw new TeamOwnerError('hold');
  return receipt;
}

/** Caller holds the original Team read authority fence. */
export function lookupOwnedProductCommand(
  store: TeamStore,
  principalId: string,
  commandId: string
): CommandReceipt | undefined {
  const receipt = readProductCommand(store, commandId);
  if (receipt && receipt.principalId !== principalId) throw new TeamOwnerError('forbidden');
  return receipt;
}
