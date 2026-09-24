import {
  composerDraftReadwrite as readwrite,
  requestValue,
} from '@renderer/services/composerDraftIndexedDb';
import {
  createLegacyRecoveryRecord,
  decodeSplitLegacy,
  decodeUnifiedLegacy,
  LEGACY_SPLIT_RECOVERY_ID,
  LEGACY_UNIFIED_RECOVERY_ID,
} from '@renderer/services/composerDraftLegacy';
import {
  buildRestoredWorking,
  composerRecoverySummary as summaryFor,
  createComposerWorkingRevision as nextRevision,
  createEmptyComposerWorking as emptyWorking,
  isComposerRecoveryRecord as isRecoveryRecord,
  isComposerWorkingRecord as isWorkingRecord,
  readComposerRecoveryIndex as readIndex,
  removeComposerRecoverySummary as removeSummary,
  upsertComposerRecoverySummary as upsertSummary,
} from '@renderer/services/composerDraftRecovery';
import {
  clone,
  ComposerDraftWorkingRepository,
  nextWorkingSummaries,
  workingIndexRecord,
} from '@renderer/services/composerDraftWorkingRepository';
import {
  composerDraftAddressKey,
  composerDraftNamespace,
  composerRecoveryIndexKey,
  composerRecoveryKey,
  composerWorkingIndexKey,
  legacyComposerKeys,
  sameComposerDraftAddress,
} from '@renderer/utils/composerDraftIdentity';
import { get } from 'idb-keyval';

import type {
  BeginAttemptResult,
  ComposerAttemptOutcome,
  ComposerDraftAddress,
  ComposerDraftRepository,
  ComposerDraftRepositoryEvent,
  ComposerPersistenceStatus,
  ComposerRecoveryRecord,
  ComposerRecoverySummary,
  ComposerWorkingRecord,
  PreparedComposerAttempt,
  ReconcileRecoveryResult,
  RestoreRecoveryResult,
} from '@renderer/types/composerDraft';

export class IndexedDbComposerDraftRepository
  extends ComposerDraftWorkingRepository
  implements ComposerDraftRepository
{
  beginAttempt(
    address: ComposerDraftAddress,
    expectedRevision: string,
    attempt: PreparedComposerAttempt
  ): Promise<BeginAttemptResult> {
    return this.enqueue(async () => {
      const recovery: ComposerRecoveryRecord = {
        version: 2,
        id: attempt.attemptId,
        address,
        snapshot: attempt.snapshot,
        preparedRequest: attempt.preparedRequest,
        reason: attempt.recoveryReason ?? 'pending-send',
        createdAt: attempt.createdAt,
        updatedAt: attempt.createdAt,
      };
      const workingKey = composerDraftAddressKey(address);
      const recoveryKey = composerRecoveryKey(address, attempt.attemptId);
      const indexKey = composerRecoveryIndexKey(address.contextId, address.teamName);
      const workingIndexKey = composerWorkingIndexKey(address.contextId, address.teamName);
      const clearedWorking = (revision: string): ComposerWorkingRecord => ({
        ...emptyWorking(address),
        workingRevision: revision,
        updatedAt: Date.now(),
      });
      const runMemory = (): BeginAttemptResult => {
        if (this.memoryRecoveries.has(recoveryKey)) {
          return { kind: 'already-exists', status: 'memory-only' };
        }
        const current = this.memoryWorking.get(workingKey) ?? emptyWorking(address);
        const workingCleared = current.workingRevision === expectedRevision;
        const currentWorkingRevision = workingCleared
          ? nextRevision(`attempt:${attempt.attemptId}`)
          : current.workingRevision;
        if (workingCleared) {
          const cleared = clearedWorking(currentWorkingRevision);
          this.memoryWorking.set(workingKey, cleared);
          this.updateMemoryWorkingSummary(address, cleared);
        }
        this.memoryRecoveries.set(recoveryKey, clone(recovery));
        this.setMemoryIndex(
          address.contextId,
          address.teamName,
          upsertSummary(this.memoryIndex(address.contextId, address.teamName), summaryFor(recovery))
        );
        this.recoveriesEvent(address.contextId, address.teamName);
        if (workingCleared) {
          this.workingEvent(address);
          this.workingIndexEvent(address);
        }
        return {
          kind: 'prepared',
          workingCleared,
          currentWorkingRevision,
          status: 'memory-only',
        };
      };
      if (this.status(address) === 'memory-only') return runMemory();
      try {
        const result = await readwrite(async (store) => {
          const [existingRaw, workingRaw, indexRaw, workingIndexRaw] = await Promise.all([
            requestValue(store.get(recoveryKey)),
            requestValue(store.get(workingKey)),
            requestValue(store.get(indexKey)),
            requestValue(store.get(workingIndexKey)),
          ]);
          if (
            workingRaw != null &&
            (!isWorkingRecord(workingRaw) || !sameComposerDraftAddress(workingRaw.address, address))
          ) {
            return { kind: 'blocked' as const };
          }
          if (existingRaw != null) return null;
          const recoveryIndex = readIndex(indexRaw);
          if (recoveryIndex.unsupported) return { kind: 'blocked-recovery-index' as const };
          const working = isWorkingRecord(workingRaw) ? workingRaw : emptyWorking(address);
          const workingCleared = working.workingRevision === expectedRevision;
          const currentWorkingRevision = workingCleared
            ? nextRevision(`attempt:${attempt.attemptId}`)
            : working.workingRevision;
          if (workingCleared) {
            const cleared = clearedWorking(currentWorkingRevision);
            const workingSummaries = nextWorkingSummaries(workingIndexRaw, address, cleared);
            if (!workingSummaries) return { kind: 'blocked-index' as const };
            store.put(cleared, workingKey);
            store.put(workingIndexRecord(workingSummaries), workingIndexKey);
          }
          store.put(recovery, recoveryKey);
          store.put(
            { version: 2, summaries: upsertSummary(recoveryIndex.summaries, summaryFor(recovery)) },
            indexKey
          );
          return { kind: 'prepared' as const, workingCleared, currentWorkingRevision };
        });
        if (result == null) return { kind: 'already-exists', status: 'durable' };
        if (
          result.kind === 'blocked' ||
          result.kind === 'blocked-index' ||
          result.kind === 'blocked-recovery-index'
        ) {
          return {
            kind: 'blocked',
            status: 'durable',
            error:
              result.kind === 'blocked-recovery-index'
                ? 'The saved message index uses an unsupported schema and was left untouched.'
                : result.kind === 'blocked-index'
                  ? 'The draft summary index uses an unsupported schema and was left untouched.'
                  : 'The saved draft uses an unsupported schema and was left untouched.',
          };
        }
        if (result.workingCleared) {
          const cleared = clearedWorking(result.currentWorkingRevision);
          this.memoryWorking.set(workingKey, cleared);
          this.updateMemoryWorkingSummary(address, cleared);
        }
        this.recoveriesEvent(address.contextId, address.teamName);
        if (result.workingCleared) {
          this.workingEvent(address);
          this.workingIndexEvent(address);
        }
        return { ...result, status: 'durable' };
      } catch (error) {
        await this.seedMemoryNamespace(address.contextId, address.teamName);
        this.markMemoryOnly(address.contextId, address.teamName, error);
        return runMemory();
      }
    });
  }

  settleAttempt(
    address: ComposerDraftAddress,
    id: string,
    outcome: ComposerAttemptOutcome
  ): Promise<ComposerPersistenceStatus> {
    return this.enqueue(async () => {
      const recoveryKey = composerRecoveryKey(address, id);
      const indexKey = composerRecoveryIndexKey(address.contextId, address.teamName);
      const applyMemory = (): void => {
        const current = this.memoryRecoveries.get(recoveryKey);
        if (!current) return;
        const updated: ComposerRecoveryRecord = {
          ...current,
          reason:
            outcome.kind === 'accepted'
              ? 'accepted-awaiting-echo'
              : outcome.kind === 'unconfirmed'
                ? 'unconfirmed-send'
                : 'not-sent',
          outcome,
          updatedAt: Date.now(),
        };
        this.memoryRecoveries.set(recoveryKey, updated);
        this.setMemoryIndex(
          address.contextId,
          address.teamName,
          upsertSummary(this.memoryIndex(address.contextId, address.teamName), summaryFor(updated))
        );
        this.recoveriesEvent(address.contextId, address.teamName);
      };
      if (this.status(address) === 'memory-only') {
        applyMemory();
        return 'memory-only';
      }
      try {
        const changed = await readwrite(async (store) => {
          const [rawRecovery, rawIndex] = await Promise.all([
            requestValue(store.get(recoveryKey)),
            requestValue(store.get(indexKey)),
          ]);
          if (!isRecoveryRecord(rawRecovery)) return false;
          const recoveryIndex = readIndex(rawIndex);
          if (recoveryIndex.unsupported) return false;
          const updated: ComposerRecoveryRecord = {
            ...rawRecovery,
            reason:
              outcome.kind === 'accepted'
                ? 'accepted-awaiting-echo'
                : outcome.kind === 'unconfirmed'
                  ? 'unconfirmed-send'
                  : 'not-sent',
            outcome,
            updatedAt: Date.now(),
          };
          store.put(updated, recoveryKey);
          store.put(
            { version: 2, summaries: upsertSummary(recoveryIndex.summaries, summaryFor(updated)) },
            indexKey
          );
          return true;
        });
        if (changed) this.recoveriesEvent(address.contextId, address.teamName);
        return 'durable';
      } catch (error) {
        await this.seedMemoryNamespace(address.contextId, address.teamName);
        this.markMemoryOnly(address.contextId, address.teamName, error);
        applyMemory();
        return 'memory-only';
      }
    });
  }

  reconcileRecovery(
    contextId: string,
    teamName: string,
    id: string,
    expectedMessageId: string
  ): Promise<ReconcileRecoveryResult> {
    return this.enqueue(async () => {
      const normalizedMessageId = expectedMessageId.trim();
      if (!normalizedMessageId) return 'mismatch';
      const indexKey = composerRecoveryIndexKey(contextId, teamName);
      const isReconcilable = (record: ComposerRecoveryRecord): boolean =>
        (record.reason === 'accepted-awaiting-echo' || record.reason === 'unconfirmed-send') &&
        record.outcome?.kind !== 'not-sent' &&
        record.outcome?.messageId?.trim() === normalizedMessageId;
      const applyMemory = (): ReconcileRecoveryResult => {
        const summary = this.memoryIndex(contextId, teamName).find(
          (candidate) => candidate.id === id
        );
        const address = summary?.address ?? null;
        if (!address) return 'missing';
        const recoveryKey = composerRecoveryKey(address, id);
        const current = this.memoryRecoveries.get(recoveryKey);
        if (!current) return 'missing';
        if (!isReconcilable(current)) return 'mismatch';
        this.memoryRecoveries.delete(recoveryKey);
        this.setMemoryIndex(
          contextId,
          teamName,
          removeSummary(this.memoryIndex(contextId, teamName), id)
        );
        this.recoveriesEvent(contextId, teamName);
        return 'reconciled';
      };
      if (this.memoryNamespaces.has(this.namespace(contextId, teamName))) {
        return applyMemory();
      }
      try {
        const result = await readwrite(async (store) => {
          const rawIndex = await requestValue(store.get(indexKey));
          const parsedIndex = readIndex(rawIndex);
          if (parsedIndex.unsupported) return 'blocked' as const;
          const summaries = parsedIndex.summaries;
          const currentSummary = summaries.find((candidate) => candidate.id === id);
          if (!currentSummary?.address) return 'missing' as const;
          const recoveryKey = composerRecoveryKey(currentSummary.address, id);
          const rawRecovery = await requestValue(store.get(recoveryKey));
          if (!isRecoveryRecord(rawRecovery)) return 'missing' as const;
          if (!isReconcilable(rawRecovery)) return 'mismatch' as const;
          store.delete(recoveryKey);
          store.put({ version: 2, summaries: removeSummary(summaries, id) }, indexKey);
          return 'reconciled' as const;
        });
        if (result === 'reconciled') {
          const memorySummary = this.memoryIndex(contextId, teamName).find(
            (candidate) => candidate.id === id
          );
          if (memorySummary?.address) {
            this.memoryRecoveries.delete(composerRecoveryKey(memorySummary.address, id));
          }
          this.setMemoryIndex(
            contextId,
            teamName,
            removeSummary(this.memoryIndex(contextId, teamName), id)
          );
          this.recoveriesEvent(contextId, teamName);
        }
        return result;
      } catch (error) {
        await this.seedMemoryNamespace(contextId, teamName);
        this.markMemoryOnly(contextId, teamName, error);
        return 'blocked';
      }
    });
  }

  stashWorking(
    address: ComposerDraftAddress,
    expectedRevision: string,
    id: string
  ): Promise<RestoreRecoveryResult> {
    return (async (): Promise<RestoreRecoveryResult> => {
      const currentResult = await this.loadWorking(address);
      if (currentResult.writeBlocked) {
        return {
          kind: 'blocked',
          status: currentResult.status,
          error: currentResult.readError ?? 'The saved draft cannot be changed safely.',
        };
      }
      const current = currentResult.working;
      if (
        current.workingRevision !== expectedRevision ||
        current.content == null ||
        (!current.content.text &&
          !current.content.chips.length &&
          !current.content.attachments.length)
      ) {
        return { kind: 'conflict', status: currentResult.status };
      }
      const attempt: PreparedComposerAttempt = {
        attemptId: id,
        snapshot: { content: current.content, editorContext: current.editorContext },
        preparedRequest: {
          kind: 'local',
          teamName: address.teamName,
          request: { member: '', text: '' },
        },
        recoveryReason: 'displaced-draft',
        createdAt: Date.now(),
      };
      const begun = await this.beginAttempt(address, expectedRevision, attempt);
      if (begun.kind !== 'prepared') {
        return begun.kind === 'already-exists'
          ? { kind: 'conflict', status: begun.status }
          : { kind: 'blocked', status: begun.status, error: begun.error };
      }
      return {
        kind: 'restored',
        working: { ...emptyWorking(address), workingRevision: begun.currentWorkingRevision },
        status: begun.status,
      };
    })();
  }

  async listRecoveries(
    contextId: string,
    teamName: string
  ): Promise<{
    recoveries: ComposerRecoverySummary[];
    status: ComposerPersistenceStatus;
    readError?: string;
  }> {
    const namespace = this.namespace(contextId, teamName);
    const memoryOnly = this.memoryNamespaces.has(namespace);
    let summaries: ComposerRecoverySummary[] = [];
    let readError = this.memoryReadErrors.get(namespace);
    if (memoryOnly) {
      summaries = clone(this.memoryIndex(contextId, teamName));
    } else {
      try {
        const parsed = readIndex(await get<unknown>(composerRecoveryIndexKey(contextId, teamName)));
        summaries = parsed.summaries;
        if (parsed.unsupported) {
          readError = 'The saved message index uses an unsupported schema and was left untouched.';
        }
      } catch (error) {
        await this.seedMemoryNamespace(contextId, teamName);
        this.markMemoryOnly(contextId, teamName, error);
        summaries = clone(this.memoryIndex(contextId, teamName));
        readError = 'Unable to load durable saved messages.';
      }
    }
    try {
      const keys = legacyComposerKeys(teamName);
      const [unifiedRaw, textRaw, chipsRaw, attachmentsRaw] = await Promise.all([
        get<unknown>(keys.unified),
        get<unknown>(keys.text),
        get<unknown>(keys.chips),
        get<unknown>(keys.attachments),
      ]);
      const unified = decodeUnifiedLegacy(unifiedRaw);
      const split = decodeSplitLegacy([textRaw, chipsRaw, attachmentsRaw]);
      const legacySummaries: ComposerRecoverySummary[] = [];
      if (unified) {
        legacySummaries.push(
          summaryFor(createLegacyRecoveryRecord(LEGACY_UNIFIED_RECOVERY_ID, unified))
        );
      }
      if (split && (!unified || JSON.stringify(split) !== JSON.stringify(unified))) {
        legacySummaries.push(
          summaryFor(createLegacyRecoveryRecord(LEGACY_SPLIT_RECOVERY_ID, split))
        );
      }
      summaries = [...summaries, ...legacySummaries];
      if (unifiedRaw != null && !unified) {
        readError = 'A legacy draft uses an unsupported schema and was left untouched.';
      }
    } catch {
      readError ??= 'Unable to inspect legacy saved messages.';
    }
    return {
      recoveries: summaries.sort((left, right) => right.createdAt - left.createdAt),
      status: this.memoryNamespaces.has(namespace) ? 'memory-only' : 'durable',
      ...(readError ? { readError } : {}),
    };
  }

  async loadRecovery(
    contextId: string,
    teamName: string,
    id: string
  ): Promise<ComposerRecoveryRecord | null> {
    if (id === LEGACY_UNIFIED_RECOVERY_ID || id === LEGACY_SPLIT_RECOVERY_ID) {
      const keys = legacyComposerKeys(teamName);
      const values = await Promise.all([
        get<unknown>(keys.unified),
        get<unknown>(keys.text),
        get<unknown>(keys.chips),
        get<unknown>(keys.attachments),
      ]);
      const snapshot =
        id === LEGACY_UNIFIED_RECOVERY_ID
          ? decodeUnifiedLegacy(values[0])
          : decodeSplitLegacy(values.slice(1));
      return snapshot ? createLegacyRecoveryRecord(id, snapshot) : null;
    }
    const summaries = (await this.listRecoveries(contextId, teamName)).recoveries;
    const summary = summaries.find((candidate) => candidate.id === id && candidate.address);
    if (!summary?.address) return null;
    const key = composerRecoveryKey(summary.address, id);
    if (this.memoryNamespaces.has(this.namespace(contextId, teamName))) {
      return clone(this.memoryRecoveries.get(key) ?? null);
    }
    try {
      const raw = await get<unknown>(key);
      return isRecoveryRecord(raw) ? clone(raw) : null;
    } catch (error) {
      await this.seedMemoryNamespace(contextId, teamName);
      this.markMemoryOnly(contextId, teamName, error);
      return clone(this.memoryRecoveries.get(key) ?? null);
    }
  }

  restoreRecovery(
    sourceContextId: string,
    sourceTeamName: string,
    id: string,
    destination: ComposerDraftAddress,
    expectedDestinationRevision: string,
    options?: { readonly asNewMessage?: boolean }
  ): Promise<RestoreRecoveryResult> {
    return this.enqueue(async () => {
      if (this.activeAttempts.has(id)) return { kind: 'active', status: this.status(destination) };
      const source = await this.loadRecovery(sourceContextId, sourceTeamName, id);
      if (!source) return { kind: 'missing', status: this.status(destination) };
      const restored = buildRestoredWorking(
        source,
        destination,
        nextRevision(`restore:${id}`),
        options?.asNewMessage === true
      );
      if (restored.kind === 'blocked') {
        return { ...restored, status: this.status(destination) };
      }
      const destinationKey = composerDraftAddressKey(destination);
      const sourceNamespace = this.namespace(sourceContextId, sourceTeamName);
      const destinationNamespace = composerDraftNamespace(destination);
      if (
        this.memoryNamespaces.has(sourceNamespace) ||
        this.memoryNamespaces.has(destinationNamespace)
      ) {
        if (sourceNamespace !== destinationNamespace) {
          return {
            kind: 'blocked',
            status: 'memory-only',
            error: 'Recovered items cannot move across unavailable storage namespaces.',
          };
        }
        if (!source.address) {
          return {
            kind: 'blocked',
            status: 'memory-only',
            error: 'Legacy storage cannot be consumed while durable storage is unavailable.',
          };
        }
        const current = this.memoryWorking.get(destinationKey) ?? emptyWorking(destination);
        if (current.workingRevision !== expectedDestinationRevision || current.content != null) {
          return { kind: 'conflict', status: 'memory-only' };
        }
        this.memoryWorking.set(destinationKey, clone(restored.working));
        this.updateMemoryWorkingSummary(destination, restored.working);
        this.memoryRecoveries.delete(composerRecoveryKey(source.address, id));
        this.setMemoryIndex(
          sourceContextId,
          sourceTeamName,
          removeSummary(this.memoryIndex(sourceContextId, sourceTeamName), id)
        );
        this.workingEvent(destination);
        this.workingIndexEvent(destination);
        this.recoveriesEvent(sourceContextId, sourceTeamName);
        return { kind: 'restored', working: restored.working, status: 'memory-only' };
      }
      try {
        const committed = await readwrite(async (store) => {
          const destinationIndexKey = composerWorkingIndexKey(
            destination.contextId,
            destination.teamName
          );
          const [destinationRaw, destinationIndexRaw] = await Promise.all([
            requestValue(store.get(destinationKey)),
            requestValue(store.get(destinationIndexKey)),
          ]);
          if (
            destinationRaw != null &&
            (!isWorkingRecord(destinationRaw) ||
              !sameComposerDraftAddress(destinationRaw.address, destination))
          ) {
            return 'blocked' as const;
          }
          const current = isWorkingRecord(destinationRaw)
            ? destinationRaw
            : emptyWorking(destination);
          if (current.workingRevision !== expectedDestinationRevision || current.content != null) {
            return 'conflict' as const;
          }
          const workingSummaries = nextWorkingSummaries(
            destinationIndexRaw,
            destination,
            restored.working
          );
          if (!workingSummaries) return 'blocked-index' as const;
          if (source.address) {
            const sourceKey = composerRecoveryKey(source.address, id);
            const indexKey = composerRecoveryIndexKey(sourceContextId, sourceTeamName);
            const [sourceRaw, indexRaw] = await Promise.all([
              requestValue(store.get(sourceKey)),
              requestValue(store.get(indexKey)),
            ]);
            if (!isRecoveryRecord(sourceRaw)) return 'missing' as const;
            const recoveryIndex = readIndex(indexRaw);
            if (recoveryIndex.unsupported) return 'blocked-recovery-index' as const;
            store.put(restored.working, destinationKey);
            store.put(workingIndexRecord(workingSummaries), destinationIndexKey);
            store.delete(sourceKey);
            store.put(
              { version: 2, summaries: removeSummary(recoveryIndex.summaries, id) },
              indexKey
            );
            return 'restored' as const;
          }
          const keys = legacyComposerKeys(sourceTeamName);
          const raw = await Promise.all([
            requestValue(store.get(keys.unified)),
            requestValue(store.get(keys.text)),
            requestValue(store.get(keys.chips)),
            requestValue(store.get(keys.attachments)),
          ]);
          const legacy =
            id === LEGACY_UNIFIED_RECOVERY_ID
              ? decodeUnifiedLegacy(raw[0])
              : decodeSplitLegacy(raw.slice(1));
          if (!legacy) return 'missing' as const;
          store.put(restored.working, destinationKey);
          store.put(workingIndexRecord(workingSummaries), destinationIndexKey);
          if (id === LEGACY_UNIFIED_RECOVERY_ID) store.delete(keys.unified);
          else {
            store.delete(keys.text);
            store.delete(keys.chips);
            store.delete(keys.attachments);
          }
          return 'restored' as const;
        });
        if (
          committed === 'blocked' ||
          committed === 'blocked-index' ||
          committed === 'blocked-recovery-index'
        ) {
          return {
            kind: 'blocked',
            status: 'durable',
            error:
              committed === 'blocked-recovery-index'
                ? 'The saved message index uses an unsupported schema and was left untouched.'
                : committed === 'blocked-index'
                  ? 'The destination draft summary index uses an unsupported schema and was left untouched.'
                  : 'The destination draft uses an unsupported schema and was left untouched.',
          };
        }
        if (committed !== 'restored') return { kind: committed, status: 'durable' };
        this.memoryWorking.set(destinationKey, clone(restored.working));
        this.updateMemoryWorkingSummary(destination, restored.working);
        this.workingEvent(destination);
        this.workingIndexEvent(destination);
        this.recoveriesEvent(sourceContextId, sourceTeamName);
        return { kind: 'restored', working: restored.working, status: 'durable' };
      } catch (error) {
        await this.seedMemoryNamespace(sourceContextId, sourceTeamName);
        if (sourceNamespace !== destinationNamespace) {
          await this.seedMemoryNamespace(destination.contextId, destination.teamName);
        }
        this.markMemoryOnly(sourceContextId, sourceTeamName, error);
        if (sourceNamespace !== destinationNamespace) {
          this.markMemoryOnly(destination.contextId, destination.teamName, error);
        }
        return {
          kind: 'blocked',
          status: 'memory-only',
          error: 'The restore transaction failed; source and destination were left unchanged.',
        };
      }
    });
  }

  discardRecovery(
    contextId: string,
    teamName: string,
    id: string
  ): Promise<'discarded' | 'missing' | 'active' | 'blocked'> {
    return this.enqueue(async () => {
      if (this.activeAttempts.has(id)) return 'active';
      const keys = legacyComposerKeys(teamName);
      if (id === LEGACY_UNIFIED_RECOVERY_ID || id === LEGACY_SPLIT_RECOVERY_ID) {
        try {
          const changed = await readwrite(async (store) => {
            if (id === LEGACY_UNIFIED_RECOVERY_ID) {
              const raw = await requestValue(store.get(keys.unified));
              if (raw == null) return false;
              store.delete(keys.unified);
            } else {
              const raw = await Promise.all([
                requestValue(store.get(keys.text)),
                requestValue(store.get(keys.chips)),
                requestValue(store.get(keys.attachments)),
              ]);
              if (raw.every((value) => value == null)) return false;
              store.delete(keys.text);
              store.delete(keys.chips);
              store.delete(keys.attachments);
            }
            return true;
          });
          if (changed) this.recoveriesEvent(contextId, teamName);
          return changed ? 'discarded' : 'missing';
        } catch {
          return 'blocked';
        }
      }
      const source = await this.loadRecovery(contextId, teamName, id);
      if (!source?.address) return 'missing';
      const recoveryKey = composerRecoveryKey(source.address, id);
      const indexKey = composerRecoveryIndexKey(contextId, teamName);
      if (this.memoryNamespaces.has(this.namespace(contextId, teamName))) {
        if (!this.memoryRecoveries.delete(recoveryKey)) return 'missing';
        this.setMemoryIndex(
          contextId,
          teamName,
          removeSummary(this.memoryIndex(contextId, teamName), id)
        );
        this.recoveriesEvent(contextId, teamName);
        return 'discarded';
      }
      try {
        const changed = await readwrite(async (store) => {
          const [raw, rawIndex] = await Promise.all([
            requestValue(store.get(recoveryKey)),
            requestValue(store.get(indexKey)),
          ]);
          if (raw == null) return false;
          const recoveryIndex = readIndex(rawIndex);
          if (recoveryIndex.unsupported) return 'blocked' as const;
          store.delete(recoveryKey);
          store.put(
            { version: 2, summaries: removeSummary(recoveryIndex.summaries, id) },
            indexKey
          );
          return true;
        });
        if (changed === 'blocked') return 'blocked';
        if (changed) this.recoveriesEvent(contextId, teamName);
        return changed ? 'discarded' : 'missing';
      } catch {
        return 'blocked';
      }
    });
  }

  subscribe(listener: (event: ComposerDraftRepositoryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isAttemptActive(id: string): boolean {
    return this.activeAttempts.has(id);
  }

  setAttemptActive(id: string, active: boolean, address?: ComposerDraftAddress): void {
    // eslint-disable-next-line sonarjs/no-selector-parameter -- The repository contract uses this boolean activation flag.
    if (active) this.activeAttempts.add(id);
    else {
      this.activeAttempts.delete(id);
      if (address) this.attemptStateEvent(address);
    }
  }
}

export const composerDraftRepository: ComposerDraftRepository =
  new IndexedDbComposerDraftRepository();

if (import.meta.env.DEV && typeof window !== 'undefined') {
  Object.defineProperty(window, '__agentTeamsComposerDraftRepository', {
    configurable: true,
    value: composerDraftRepository,
  });
}
