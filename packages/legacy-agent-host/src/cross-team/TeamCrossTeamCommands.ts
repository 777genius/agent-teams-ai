import { crossTeamSenderCopy } from './crossTeamRecords.js';
import { validateCrossTeamIntent } from './validateCrossTeamIntent.js';
import { digest } from '../team/identity.js';
import { TeamOwnerError } from '../team/contracts.js';
import { teamCommandPath, listTeamCommandEntries } from '../team/commandEntries.js';

import type { TeamBinding } from '../team/contracts.js';
import type { TeamPolicyPort, TeamStore } from '../team/ports.js';
import type { CapturedCrossTeamIntent, BackendCrossTeamReceipt } from './contracts.js';

export interface CrossTeamCommandReceipt {
  schemaVersion: 1;
  family: 'cross-team';
  binding: TeamBinding;
  commandId: string;
  principalId: string;
  requestDigest: string;
  fingerprint: string;
  authorityRevision: number;
  intent: CapturedCrossTeamIntent;
  phase: 'prepared' | 'completed';
  result?: BackendCrossTeamReceipt;
}

export function crossTeamReceiptFingerprint(
  receipt: Omit<CrossTeamCommandReceipt, 'fingerprint' | 'phase' | 'result'>
): string {
  return digest({
    family: receipt.family,
    binding: receipt.binding,
    commandId: receipt.commandId,
    principalId: receipt.principalId,
    requestDigest: receipt.requestDigest,
    authorityRevision: receipt.authorityRevision,
    intent: receipt.intent,
  });
}
export function crossTeamIntentFingerprint(
  intent: Omit<CapturedCrossTeamIntent, 'authorityFingerprint'>
): string {
  return digest({
    commandId: intent.commandId,
    pair: intent.pair,
    request: intent.request,
    timestamp: intent.timestamp,
    targetCommandId: intent.targetCommandId,
  });
}
export function validateCrossTeamCommandReceipt(
  receipt: CrossTeamCommandReceipt
): CrossTeamCommandReceipt {
  validateCrossTeamIntent(receipt.intent);
  if (
    receipt.family !== 'cross-team' ||
    receipt.schemaVersion !== 1 ||
    !['prepared', 'completed'].includes(receipt.phase) ||
    !/^[a-f0-9]{64}$/.test(receipt.requestDigest) ||
    receipt.fingerprint !== crossTeamReceiptFingerprint(receipt) ||
    !Number.isSafeInteger(receipt.authorityRevision) ||
    receipt.authorityRevision < 1 ||
    receipt.intent.commandId !== receipt.commandId ||
    receipt.intent.authorityFingerprint !== crossTeamIntentFingerprint(receipt.intent) ||
    (receipt.phase === 'completed' &&
      (!receipt.result ||
        receipt.result.phase !== 'completed' ||
        receipt.result.commandId !== receipt.commandId ||
        receipt.result.messageId !== receipt.intent.request.messageId ||
        receipt.result.conversationId !== receipt.intent.request.conversationId ||
        receipt.result.toMember !== receipt.intent.pair.target.recipient.name))
  )
    throw new TeamOwnerError('hold');
  return receipt;
}

/** Original pair admission shares the existing Team command namespace; it is not a delivery queue. */
export function createTeamCrossTeamCommands(options: {
  store: TeamStore;
  binding: TeamBinding;
  principalId: string;
  authorize(action: 'read' | 'write'): number;
  reserved(commandId: string): boolean;
  policy?: Pick<TeamPolicyPort, 'readSentMessages' | 'appendSentMessage'>;
  invalidate?(): void;
  canReadAll?(): boolean;
}) {
  const { store, binding, principalId } = options;
  function read(commandId: string, history = false): CrossTeamCommandReceipt | undefined {
    const receipt = store.read<CrossTeamCommandReceipt>(teamCommandPath(commandId));
    if (!receipt) return undefined;
    validateCrossTeamIntent(receipt.intent);
    if (receipt.family !== 'cross-team') throw new TeamOwnerError('conflict');
    validateCrossTeamCommandReceipt(receipt);
    if (receipt.commandId !== commandId || digest(receipt.binding) !== digest(binding))
      throw new TeamOwnerError('hold');
    if (receipt.principalId !== principalId && !(history && options.canReadAll?.()))
      throw new TeamOwnerError('forbidden');
    return receipt;
  }
  function assertWritable(receipt: CrossTeamCommandReceipt): void {
    options.authorize('read');
    if (options.authorize('write') !== receipt.authorityRevision) throw new TeamOwnerError('hold');
    const current = read(receipt.commandId);
    if (!current || current.fingerprint !== receipt.fingerprint) throw new TeamOwnerError('hold');
  }
  return Object.freeze({
    lookup(commandId: string) {
      // Revoked write authority never forces a new grant identity merely to inspect original history.
      return store.fenced(() => {
        options.authorize('read');
        return structuredClone(read(commandId, true));
      });
    },
    history(): CrossTeamCommandReceipt[] {
      return store.fenced(() => {
        options.authorize('read');
        return listTeamCommandEntries(store)
          .filter((entry): entry is CrossTeamCommandReceipt =>
            'family' in entry && entry.family === 'cross-team')
          .map((entry) => {
            if (digest(entry.binding) !== digest(binding)) throw new TeamOwnerError('hold');
            return structuredClone(entry);
          });
      });
    },
    prepare(
      commandId: string,
      requestDigest: string,
      createOriginalIntent: () => CapturedCrossTeamIntent
    ) {
      return store.fenced(() => {
        if (!/^[a-f0-9]{64}$/.test(requestDigest)) throw new TeamOwnerError('invalid');
        options.authorize('read');
        const authorityRevision = options.authorize('write');
        if (options.reserved(commandId)) throw new TeamOwnerError('conflict');
        const existing = read(commandId);
        if (existing) {
          if (existing.requestDigest !== requestDigest) throw new TeamOwnerError('conflict');
          assertWritable(existing);
          return structuredClone(existing);
        }
        // Resolve recipient/run exactly once, only for a genuinely new source command.
        const intent = structuredClone(createOriginalIntent());
        validateCrossTeamIntent(intent);
        if (
          intent.commandId !== commandId ||
          intent.pair.ownerId !== binding.backendId ||
          intent.pair.source.teamId !== binding.teamId ||
          intent.pair.source.teamName !== binding.teamName ||
          intent.pair.source.principalId !== principalId ||
          intent.pair.source.grantRevision !== authorityRevision
        )
          throw new TeamOwnerError('invalid');
        const value = {
          schemaVersion: 1 as const,
          family: 'cross-team' as const,
          binding,
          commandId,
          principalId,
          requestDigest,
          authorityRevision,
          intent,
        };
        const receipt: CrossTeamCommandReceipt = {
          ...value,
          fingerprint: crossTeamReceiptFingerprint(value),
          phase: 'prepared',
        };
        store.write(teamCommandPath(commandId), receipt);
        return structuredClone(receipt);
      });
    },
    assertCurrent(receipt: CrossTeamCommandReceipt) {
      store.fenced(() => assertWritable(receipt));
    },
    appendSenderCopy(receipt: CrossTeamCommandReceipt): void {
      store.fenced(() => {
        assertWritable(receipt);
        const { intent } = receipt,
          request = intent.request;
        const row = crossTeamSenderCopy(intent);
        if (!options.policy?.readSentMessages || !options.policy.appendSentMessage)
          throw new TeamOwnerError('hold');
        const rows = options.policy
          .readSentMessages()
          .filter(
            (entry) =>
              entry &&
              typeof entry === 'object' &&
              !Array.isArray(entry) &&
              entry.messageId === request.messageId
          );
        if (rows.length > 1 || (rows[0] && digest(rows[0]) !== digest(row)))
          throw new TeamOwnerError('hold');
        if (!rows.length) {
          const result = options.policy.appendSentMessage(row);
          if (digest(result) !== digest(row)) throw new TeamOwnerError('hold');
          options.invalidate?.();
        }
      });
    },
    complete(receipt: CrossTeamCommandReceipt, result: BackendCrossTeamReceipt) {
      return store.fenced(() => {
        assertWritable(receipt);
        const current = read(receipt.commandId)!;
        if (
          result.commandId !== current.commandId ||
          result.messageId !== current.intent.request.messageId ||
          result.conversationId !== current.intent.request.conversationId ||
          result.phase !== 'completed'
        )
          throw new TeamOwnerError('hold');
        if (current.phase === 'completed') {
          if (digest(current.result) !== digest(result)) throw new TeamOwnerError('conflict');
          return structuredClone(current);
        }
        current.phase = 'completed';
        current.result = structuredClone(result);
        store.write(teamCommandPath(current.commandId), current);
        return structuredClone(current);
      });
    },
  });
}
