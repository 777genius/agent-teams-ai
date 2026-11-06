import { reviewMethodKind } from './reviewMethodKind.js';
import type { ReviewDecisionPersistenceScope } from '@agent-teams/task-change-ledger/contracts';
import type { ReviewCommandCommitProof } from '@agent-teams/task-change-ledger/review-writer';
import { createHash } from 'node:crypto';
import type { JsonValue } from '../contracts.js';
import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import {
  listTeamCommandEntries,
  reviewReceiptFingerprint,
  teamCommandPath,
  validateCommandEntry,
} from './commandEntries.js';
import type { TeamBinding } from './contracts.js';
import type { TeamStore } from './ports.js';
import type { ReviewCommandReceipt, ReviewCommandLookup } from './reviewCommandContracts.js';
import type {
  ReviewWriterRequest,
  ReviewWriterResponse,
  ReviewOriginScope,
} from '@agent-teams/task-change-ledger/review-transport';

const MAX_INLINE_RESPONSE_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
/** Admission/result receipts share Team's existing command namespace/fence, never replay effects. */
export function createTeamReviewCommands(options: {
  store: TeamStore;
  binding: TeamBinding;
  principalId: string;
  authorize(action: 'read' | 'control'): number;
  reserved(commandId: string): boolean;
}) {
  const { store, binding, principalId } = options;
  const authorize = () => {
    options.authorize('read');
    return options.authorize('control');
  };
  const read = (commandId: string): ReviewCommandReceipt | undefined => {
    const raw = store.read<ReviewCommandReceipt>(teamCommandPath(commandId));
    if (!raw) return undefined;
    const entry = validateCommandEntry(raw);
    if (!('family' in entry) || entry.family !== 'review') throw new TeamOwnerError('conflict');
    if (digest(entry.binding) !== digest(binding)) throw new TeamOwnerError('hold');
    if (entry.principalId !== principalId) throw new TeamOwnerError('forbidden');
    return entry;
  };
  const writeArtifact = (value: unknown) => {
    if (!store.readCommandResult) throw new TeamOwnerError('hold');
    const serialized = JSON.stringify(value, null, 2);
    const sizeBytes = Buffer.byteLength(serialized);
    if (sizeBytes < 1 || sizeBytes > MAX_RESPONSE_BYTES) throw new TeamOwnerError('hold');
    const reference = { sha256: createHash('sha256').update(serialized).digest('hex'), sizeBytes };
    store.write(`command-results/${reference.sha256}.json`, value);
    return reference;
  };
  const validateRecoveryScope = (
    value: unknown,
    origin: ReviewOriginScope
  ): ReviewDecisionPersistenceScope => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new TeamOwnerError('hold');
    const scope = value as Partial<ReviewDecisionPersistenceScope>;
    const scopeKey = origin.taskId ? `task-${origin.taskId}` : `agent-${origin.memberName}`;
    if (
      scope.scopeKey !== scopeKey ||
      typeof scope.scopeToken !== 'string' ||
      !scope.scopeToken ||
      scope.scopeToken.includes('\0') ||
      Buffer.byteLength(scope.scopeToken) > MAX_RESPONSE_BYTES
    )
      throw new TeamOwnerError('hold');
    return { scopeKey, scopeToken: scope.scopeToken };
  };
  const captureRecoveryScope = (request: ReviewWriterRequest, origin: ReviewOriginScope) => {
    switch (request.method) {
      case 'applyDecisions':
        return request.args[0].decisionPersistenceScope
          ? validateRecoveryScope(request.args[0].decisionPersistenceScope, origin)
          : undefined;
      case 'executeReviewMutation':
      case 'restoreReviewHistory':
        return validateRecoveryScope(request.args[0].decisionPersistenceScope, origin);
      default:
        return undefined;
    }
  };
  const responseOf = (receipt: ReviewCommandReceipt): ReviewWriterResponse | undefined => {
    if (receipt.response) return structuredClone(receipt.response);
    if (!receipt.responseRef) return undefined;
    if (!store.readCommandResult) throw new TeamOwnerError('hold');
    const result = store.readCommandResult(receipt.responseRef) as ReviewWriterResponse;
    if (
      !result ||
      result.kind !== 'review-writer' ||
      result.method !== receipt.method ||
      !Object.hasOwn(result, 'result')
    )
      throw new TeamOwnerError('hold');
    return result;
  };
  return {
    admit(commandId: string, origin: ReviewOriginScope, request: ReviewWriterRequest) {
      return store.fenced(() => {
        const authorityRevision = authorize();
        if (reviewMethodKind(request.method) !== 'mutation') throw new TeamOwnerError('invalid');
        const cleanRequest: ReviewWriterRequest = JSON.parse(JSON.stringify(request));
        const base = {
          schemaVersion: 1 as const,
          family: 'review' as const,
          binding: structuredClone(binding),
          commandId,
          principalId,
          origin: structuredClone(origin),
          method: request.method,
          requestDigest: digest(cleanRequest),
          authorityRevision,
          createdAt: new Date().toISOString(),
          phase: 'prepared' as const,
        };
        const fingerprint = reviewReceiptFingerprint(base);
        const previous = read(commandId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new TeamOwnerError('conflict');
          if (previous.phase !== 'completed') throw new TeamOwnerError('hold');
          const response = responseOf(previous);
          if (!response) throw new TeamOwnerError('hold');
          return { kind: 'completed' as const, response };
        }
        if (options.reserved(commandId)) throw new TeamOwnerError('conflict');
        const entries = listTeamCommandEntries(store);
        if (entries.length >= 10000) throw new TeamOwnerError('hold');
        if (
          entries.some(
            (entry) =>
              'family' in entry && entry.family === 'review' &&
              entry.phase !== 'completed' &&
              digest(entry.origin) === digest(origin)
          )
        )
          throw new TeamOwnerError('hold');
        const recoveryScope = captureRecoveryScope(request, origin);
        const receipt: ReviewCommandReceipt = {
          ...base,
          fingerprint,
          ...(recoveryScope ? { recoveryScopeRef: writeArtifact(recoveryScope) } : {}),
        };
        validateCommandEntry(receipt);
        store.write(teamCommandPath(commandId), receipt);
        return { kind: 'admitted' as const, fingerprint };
      });
    },
    complete(commandId: string, fingerprint: string, response: ReviewWriterResponse): void {
      store.fenced(() => {
        const authorityRevision = authorize();
        const receipt = read(commandId);
        if (
          !receipt ||
          receipt.fingerprint !== fingerprint ||
          (receipt.phase !== 'prepared' &&
            !(receipt.phase === 'completed' && receipt.commitProof)) ||
          receipt.authorityRevision !== authorityRevision ||
          response.method !== receipt.method
        )
          throw new TeamOwnerError('hold');
        const json = JSON.stringify(response);
        if (Buffer.byteLength(json) > MAX_RESPONSE_BYTES) throw new TeamOwnerError('hold');
        const clean: ReviewWriterResponse = JSON.parse(json);
        const responseRef =
          Buffer.byteLength(json) > MAX_INLINE_RESPONSE_BYTES ? writeArtifact(clean) : undefined;
        const result = clean.result;
        const references: NonNullable<ReviewCommandReceipt['references']> = {
          ...receipt.references,
        };
        if (result && typeof result === 'object') {
          if ('decisionRevision' in result && typeof result.decisionRevision === 'number')
            references.decisionRevision = result.decisionRevision;
          if ('committedReviewAction' in result && result.committedReviewAction)
            references.actionId = result.committedReviewAction.id;
        }
        const completed: ReviewCommandReceipt = {
          ...receipt,
          phase: 'completed',
          ...(responseRef ? { responseRef } : { response: clean, responseDigest: digest(clean) }),
          ...(Object.keys(references).length ? { references } : {}),
        };
        validateCommandEntry(completed);
        store.write(teamCommandPath(commandId), completed);
      });
    },
    confirmCommitted(proof: ReviewCommandCommitProof): void {
      store.fenced(() => {
        authorize();
        const { correlation, walId, kind, decisionRevision, actionId } = proof;
        const receipt = read(correlation.commandId);
        if (
          !receipt ||
          receipt.fingerprint !== correlation.fingerprint ||
          digest(receipt.origin) !== digest(correlation.origin)
        )
          throw new TeamOwnerError('hold');
        const matches =
          receipt.method === 'applyDecisions'
            ? ['reject', 'bulk'].includes(kind)
            : receipt.method === 'executeReviewMutation'
              ? ['restore', 'rename', 'undo', 'redo', 'reload-external'].includes(kind)
              : receipt.method === 'restoreReviewHistory' && kind === 'restore-history';
        if (!matches) throw new TeamOwnerError('hold');
        const commitProof = { walId, kind, decisionRevision, ...(actionId ? { actionId } : {}) };
        if (receipt.commitProof) {
          if (digest(receipt.commitProof) !== digest(commitProof)) throw new TeamOwnerError('hold');
          return;
        }
        if (receipt.phase === 'completed') throw new TeamOwnerError('hold');
        const settled: ReviewCommandReceipt = {
          ...receipt,
          phase: 'completed',
          commitProof,
          references: { walId, decisionRevision, ...(actionId ? { actionId } : {}) },
        };
        validateCommandEntry(settled);
        store.write(teamCommandPath(receipt.commandId), settled);
      });
    },
    hold(commandId: string, fingerprint: string): void {
      store.fenced(() => {
        authorize();
        const receipt = read(commandId);
        if (!receipt || receipt.fingerprint !== fingerprint || receipt.phase !== 'prepared')
          throw new TeamOwnerError('hold');
        store.write(teamCommandPath(commandId), { ...receipt, phase: 'held' });
      });
    },
    retainedRecoveryScopes(origin: ReviewOriginScope) {
      return store.fenced(() => {
        authorize();
        return listTeamCommandEntries(store)
          .filter(
            (entry): entry is ReviewCommandReceipt =>
              'family' in entry && entry.family === 'review' &&
              entry.principalId === principalId &&
              digest(entry.origin) === digest(origin) &&
              entry.phase !== 'completed' &&
              !!entry.recoveryScopeRef
          )
          .map((entry) => {
            if (!store.readCommandResult || !entry.recoveryScopeRef)
              throw new TeamOwnerError('hold');
            return validateRecoveryScope(store.readCommandResult(entry.recoveryScopeRef), origin);
          });
      });
    },
    recoveryRead(origin: ReviewOriginScope) {
      return store.fenced(() => {
        authorize();
        const entries = listTeamCommandEntries(store).filter(
          (entry): entry is ReviewCommandReceipt =>
            'family' in entry && entry.family === 'review' &&
            entry.principalId === principalId &&
            digest(entry.origin) === digest(origin)
        );
        const pending = entries.filter((entry) => entry.phase !== 'completed');
        if (pending.length > 64) throw new TeamOwnerError('hold');
        const completed = entries
          .filter((entry) => entry.phase === 'completed')
          .sort(
            (a, b) =>
              b.createdAt.localeCompare(a.createdAt) || a.commandId.localeCompare(b.commandId)
          );
        const commands = [...pending, ...completed.slice(0, 64 - pending.length)].map((entry) => ({
          commandId: entry.commandId,
          method: entry.method,
          phase: entry.phase,
          outcome: entry.phase === 'completed' ? ('completed' as const) : ('unknown' as const),
          responseAvailable: !!(entry.response || entry.responseRef),
          ...(entry.references ? { references: structuredClone(entry.references) } : {}),
        }));
        return { kind: 'review-recovery' as const, origin: structuredClone(origin), commands };
      });
    },
    lookup(
      commandId: string,
      origin: ReviewOriginScope,
      expected?: ReviewWriterRequest
    ): ReviewCommandLookup | undefined {
      return store.fenced(() => {
        authorize();
        const receipt = read(commandId);
        if (receipt && digest(receipt.origin) !== digest(origin))
          throw new TeamOwnerError('conflict');
        if (
          receipt &&
          expected &&
          receipt.requestDigest !== digest(JSON.parse(JSON.stringify(expected)))
        )
          throw new TeamOwnerError('conflict');
        const response = receipt?.phase === 'completed' ? responseOf(receipt) : undefined;
        return receipt
          ? {
              kind: 'review-command',
              commandId,
              method: receipt.method,
              origin: structuredClone(receipt.origin),
              phase: receipt.phase,
              outcome: receipt.phase === 'completed' ? 'completed' : 'unknown',
              responseAvailable: response !== undefined,
              ...(response ? { response } : {}),
              ...(receipt.references ? { references: structuredClone(receipt.references) } : {}),
            }
          : undefined;
      });
    },
  };
}
