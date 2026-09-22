import {
  composerDraftEntriesByPrefix,
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
  composerWorkingSummary as workingSummaryFor,
  readComposerWorkingIndex,
  removeComposerWorkingSummary,
  upsertComposerWorkingSummary,
} from '@renderer/services/composerDraftWorkingSummary';
import {
  composerDraftAddressKey,
  composerDraftNamespace,
  composerNamespacePrefix,
  composerRecoveryIndexKey,
  composerRecoveryKey,
  composerWorkingIndexKey,
  composerWorkingIndexMigrationKey,
  composerWorkingKeyPrefix,
  legacyComposerKeys,
  sameComposerDraftAddress,
} from '@renderer/utils/composerDraftIdentity';
import { get } from 'idb-keyval';

import type {
  BeginAttemptResult,
  ComposerAttemptOutcome,
  ComposerDraftAddress,
  ComposerDraftContent,
  ComposerDraftRepository,
  ComposerDraftRepositoryEvent,
  ComposerEditorContext,
  ComposerPersistenceStatus,
  ComposerRecoveryRecord,
  ComposerRecoverySummary,
  ComposerWorkingRecord,
  ComposerWorkingSummary,
  PreparedComposerAttempt,
  ReconcileRecoveryResult,
  RestoreRecoveryResult,
  SaveWorkingResult,
} from '@renderer/types/composerDraft';

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

class UnsupportedWorkingIndexError extends Error {}

function workingIndexRecord(summaries: readonly ComposerWorkingSummary[]): {
  readonly version: 1;
  readonly summaries: readonly ComposerWorkingSummary[];
} {
  return { version: 1, summaries };
}

function nextWorkingSummaries(
  rawIndex: unknown,
  address: ComposerDraftAddress,
  record: ComposerWorkingRecord | null
): ComposerWorkingSummary[] | null {
  const current = readComposerWorkingIndex(rawIndex);
  if (current.unsupported) return null;
  const summary = record ? workingSummaryFor(record) : null;
  return summary
    ? upsertComposerWorkingSummary(current.summaries, summary)
    : removeComposerWorkingSummary(current.summaries, address);
}

function sameWorkingSummary(
  left: ComposerWorkingSummary | undefined,
  right: ComposerWorkingSummary | null
): boolean {
  if (!left || !right) return left == null && right == null;
  return (
    left.workingRevision === right.workingRevision &&
    left.updatedAt === right.updatedAt &&
    left.preview === right.preview &&
    left.attachmentCount === right.attachmentCount &&
    left.chipCount === right.chipCount &&
    left.editorKind === right.editorKind
  );
}

export class IndexedDbComposerDraftRepository implements ComposerDraftRepository {
  private readonly listeners = new Set<(event: ComposerDraftRepositoryEvent) => void>();
  private readonly activeAttempts = new Set<string>();
  private readonly memoryNamespaces = new Set<string>();
  private readonly memoryWorking = new Map<string, ComposerWorkingRecord>();
  private readonly memoryRecoveries = new Map<string, ComposerRecoveryRecord>();
  private readonly memoryIndexes = new Map<string, ComposerRecoverySummary[]>();
  private readonly memoryWorkingIndexes = new Map<string, ComposerWorkingSummary[]>();
  private readonly memoryReadErrors = new Map<string, string>();
  private readonly workingMigrations = new Map<string, Promise<void>>();
  private readonly migratedWorkingNamespaces = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  private status(address: ComposerDraftAddress): ComposerPersistenceStatus {
    return this.memoryNamespaces.has(composerDraftNamespace(address)) ? 'memory-only' : 'durable';
  }

  private namespace(contextId: string, teamName: string): string {
    return `${encodeURIComponent(contextId)}:${encodeURIComponent(teamName)}`;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => undefined).then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private emit(event: ComposerDraftRepositoryEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private workingEvent(address: ComposerDraftAddress): void {
    this.emit({
      kind: 'working',
      address,
      contextId: address.contextId,
      teamName: address.teamName,
    });
  }

  private recoveriesEvent(contextId: string, teamName: string): void {
    this.emit({ kind: 'recoveries', contextId, teamName });
  }

  private workingIndexEvent(address: ComposerDraftAddress): void {
    this.emit({
      kind: 'working-index',
      address,
      contextId: address.contextId,
      teamName: address.teamName,
    });
  }

  private attemptStateEvent(address: ComposerDraftAddress): void {
    this.emit({
      kind: 'attempt-state',
      address,
      contextId: address.contextId,
      teamName: address.teamName,
    });
  }

  private markMemoryOnly(contextId: string, teamName: string, error: unknown): void {
    const namespace = this.namespace(contextId, teamName);
    this.memoryNamespaces.add(namespace);
    const message = error instanceof Error ? error.message : 'IndexedDB is unavailable.';
    this.memoryReadErrors.set(namespace, message);
    console.warn('[composerDraftRepository] Using session-memory overlay:', message);
  }

  private memoryIndex(contextId: string, teamName: string): ComposerRecoverySummary[] {
    return this.memoryIndexes.get(this.namespace(contextId, teamName)) ?? [];
  }

  private setMemoryIndex(
    contextId: string,
    teamName: string,
    summaries: ComposerRecoverySummary[]
  ): void {
    this.memoryIndexes.set(this.namespace(contextId, teamName), clone(summaries));
  }

  private memoryWorkingIndex(contextId: string, teamName: string): ComposerWorkingSummary[] {
    return this.memoryWorkingIndexes.get(this.namespace(contextId, teamName)) ?? [];
  }

  private setMemoryWorkingIndex(
    contextId: string,
    teamName: string,
    summaries: ComposerWorkingSummary[]
  ): void {
    this.memoryWorkingIndexes.set(this.namespace(contextId, teamName), clone(summaries));
  }

  private updateMemoryWorkingSummary(
    address: ComposerDraftAddress,
    record: ComposerWorkingRecord | null
  ): void {
    const current = this.memoryWorkingIndex(address.contextId, address.teamName);
    const summary = record ? workingSummaryFor(record) : null;
    this.setMemoryWorkingIndex(
      address.contextId,
      address.teamName,
      summary
        ? upsertComposerWorkingSummary(current, summary)
        : removeComposerWorkingSummary(current, address)
    );
  }

  private async seedMemoryNamespace(contextId: string, teamName: string): Promise<void> {
    const namespace = this.namespace(contextId, teamName);
    if (this.memoryIndexes.has(namespace) && this.memoryWorkingIndexes.has(namespace)) return;
    try {
      const [recoveryRaw, workingRaw] = await Promise.all([
        get<unknown>(composerRecoveryIndexKey(contextId, teamName)),
        get<unknown>(composerWorkingIndexKey(contextId, teamName)),
      ]);
      const summaries = readIndex(recoveryRaw);
      this.setMemoryIndex(contextId, teamName, summaries);
      this.setMemoryWorkingIndex(
        contextId,
        teamName,
        readComposerWorkingIndex(workingRaw).summaries
      );
      await Promise.all(
        summaries.map(async (summary) => {
          if (summary.legacy || !summary.address) return;
          const raw = await get<unknown>(composerRecoveryKey(summary.address, summary.id));
          if (isRecoveryRecord(raw)) {
            this.memoryRecoveries.set(composerRecoveryKey(summary.address, summary.id), clone(raw));
          }
        })
      );
    } catch {
      this.setMemoryIndex(contextId, teamName, []);
      this.setMemoryWorkingIndex(contextId, teamName, []);
    }
  }

  private ensureWorkingIndexMigrated(contextId: string, teamName: string): Promise<void> {
    const namespace = this.namespace(contextId, teamName);
    if (this.migratedWorkingNamespaces.has(namespace)) return Promise.resolve();
    const existing = this.workingMigrations.get(namespace);
    if (existing) return existing;
    const migration = this.enqueue(async () => {
      if (this.memoryNamespaces.has(namespace)) return;
      try {
        const summaries = await readwrite(async (store) => {
          const migrationKey = composerWorkingIndexMigrationKey(contextId, teamName);
          const indexKey = composerWorkingIndexKey(contextId, teamName);
          const [markerRaw, indexRaw] = await Promise.all([
            requestValue(store.get(migrationKey)),
            requestValue(store.get(indexKey)),
          ]);
          if (markerRaw != null && (markerRaw as { version?: unknown }).version !== 1) {
            throw new UnsupportedWorkingIndexError(
              'The draft summary migration uses an unsupported schema.'
            );
          }
          const current = readComposerWorkingIndex(indexRaw);
          if (current.unsupported) {
            throw new UnsupportedWorkingIndexError(
              'The draft summary index uses an unsupported schema.'
            );
          }
          if (markerRaw != null) return current.summaries;
          const entries = await composerDraftEntriesByPrefix(
            store,
            composerWorkingKeyPrefix(contextId, teamName)
          );
          const byAddress = new Map<string, ComposerWorkingSummary>();
          for (const [, raw] of entries) {
            if (!isWorkingRecord(raw)) continue;
            if (raw.address.contextId !== contextId || raw.address.teamName !== teamName) continue;
            const summary = workingSummaryFor(raw);
            if (summary) byAddress.set(composerDraftAddressKey(raw.address), summary);
          }
          const rebuilt = [...byAddress.values()];
          store.put(workingIndexRecord(rebuilt), indexKey);
          store.put({ version: 1 }, migrationKey);
          return rebuilt;
        });
        this.setMemoryWorkingIndex(contextId, teamName, summaries);
        this.migratedWorkingNamespaces.add(namespace);
      } catch (error) {
        if (error instanceof UnsupportedWorkingIndexError) {
          this.memoryReadErrors.set(namespace, error.message);
          throw error;
        }
        await this.seedMemoryNamespace(contextId, teamName);
        this.markMemoryOnly(contextId, teamName, error);
      }
    }).finally(() => {
      this.workingMigrations.delete(namespace);
    });
    this.workingMigrations.set(namespace, migration);
    return migration;
  }

  private async repairWorkingIndex(
    address: ComposerDraftAddress,
    working: ComposerWorkingRecord | null
  ): Promise<string | undefined> {
    if (this.status(address) === 'memory-only') {
      const next = workingSummaryFor(working ?? emptyWorking(address));
      this.setMemoryWorkingIndex(
        address.contextId,
        address.teamName,
        next
          ? upsertComposerWorkingSummary(
              this.memoryWorkingIndex(address.contextId, address.teamName),
              next
            )
          : removeComposerWorkingSummary(
              this.memoryWorkingIndex(address.contextId, address.teamName),
              address
            )
      );
      return undefined;
    }
    try {
      const repaired = await readwrite(async (store) => {
        const workingKey = composerDraftAddressKey(address);
        const indexKey = composerWorkingIndexKey(address.contextId, address.teamName);
        const [latestRaw, indexRaw] = await Promise.all([
          requestValue(store.get(workingKey)),
          requestValue(store.get(indexKey)),
        ]);
        const latest = isWorkingRecord(latestRaw) && sameComposerDraftAddress(latestRaw.address, address)
          ? latestRaw
          : null;
        const current = readComposerWorkingIndex(indexRaw);
        if (current.unsupported) return null;
        const key = composerDraftAddressKey(address);
        const expected = latest ? workingSummaryFor(latest) : null;
        const existing = current.summaries.find(
          (summary) => composerDraftAddressKey(summary.address) === key
        );
        if (sameWorkingSummary(existing, expected)) return false;
        const summaries = nextWorkingSummaries(indexRaw, address, latest);
        if (!summaries) return false;
        store.put(workingIndexRecord(summaries), indexKey);
        return true;
      });
      if (repaired == null) return 'The draft summary index uses an unsupported schema.';
      if (repaired) this.workingIndexEvent(address);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : 'Unable to repair the draft summary index.';
    }
  }

  async loadWorking(address: ComposerDraftAddress): Promise<{
    working: ComposerWorkingRecord;
    status: ComposerPersistenceStatus;
    readError?: string;
    writeBlocked?: boolean;
  }> {
    const key = composerDraftAddressKey(address);
    const namespace = composerDraftNamespace(address);
    if (this.memoryNamespaces.has(namespace)) {
      return {
        working: clone(this.memoryWorking.get(key) ?? emptyWorking(address)),
        status: 'memory-only',
        readError: this.memoryReadErrors.get(namespace),
      };
    }
    try {
      const raw = await get<unknown>(key);
      if (raw == null) {
        const working = emptyWorking(address);
        this.memoryWorking.set(key, clone(working));
        const repairError = await this.repairWorkingIndex(address, null);
        return {
          working,
          status: 'durable',
          ...(repairError ? { readError: repairError } : {}),
        };
      }
      if (!isWorkingRecord(raw) || !sameComposerDraftAddress(raw.address, address)) {
        return {
          working: emptyWorking(address),
          status: 'durable',
          readError: 'The saved draft uses an unsupported schema and was left untouched.',
          writeBlocked: true,
        };
      }
      this.memoryWorking.set(key, clone(raw));
      const repairError = await this.repairWorkingIndex(address, raw);
      return {
        working: clone(raw),
        status: 'durable',
        ...(repairError ? { readError: repairError } : {}),
      };
    } catch (error) {
      this.markMemoryOnly(address.contextId, address.teamName, error);
      return {
        working: emptyWorking(address),
        status: 'memory-only',
        readError: 'Unable to load the saved draft. New edits are stored in memory only.',
      };
    }
  }

  saveWorking(
    address: ComposerDraftAddress,
    expectedRevision: string,
    nextWorkingRevision: string,
    content: ComposerDraftContent | null,
    editorContext: ComposerEditorContext
  ): Promise<SaveWorkingResult> {
    return this.enqueue(async () => {
      const key = composerDraftAddressKey(address);
      const record: ComposerWorkingRecord = {
        version: 2,
        address,
        workingRevision: nextWorkingRevision,
        content,
        editorContext,
        updatedAt: Date.now(),
      };
      if (this.status(address) === 'memory-only') {
        const current = this.memoryWorking.get(key) ?? emptyWorking(address);
        if (current.workingRevision !== expectedRevision) {
          return {
            kind: 'conflict',
            currentWorkingRevision: current.workingRevision,
            status: 'memory-only',
          };
        }
        this.memoryWorking.set(key, clone(record));
        this.updateMemoryWorkingSummary(address, record);
        this.workingEvent(address);
        this.workingIndexEvent(address);
        return { kind: 'saved', workingRevision: nextWorkingRevision, status: 'memory-only' };
      }
      try {
        const result = await readwrite(async (store) => {
          const indexKey = composerWorkingIndexKey(address.contextId, address.teamName);
          const [raw, indexRaw] = await Promise.all([
            requestValue(store.get(key)),
            requestValue(store.get(indexKey)),
          ]);
          if (
            raw != null &&
            (!isWorkingRecord(raw) || !sameComposerDraftAddress(raw.address, address))
          ) {
            return { kind: 'blocked' as const };
          }
          const current = isWorkingRecord(raw) ? raw : emptyWorking(address);
          if (current.workingRevision !== expectedRevision) {
            return { kind: 'conflict' as const, revision: current.workingRevision };
          }
          const summaries = nextWorkingSummaries(indexRaw, address, record);
          if (!summaries) return { kind: 'blocked-index' as const };
          store.put(record, key);
          store.put(workingIndexRecord(summaries), indexKey);
          return { kind: 'saved' as const };
        });
        if (result.kind === 'blocked' || result.kind === 'blocked-index') {
          return {
            kind: 'blocked',
            status: 'durable',
            error:
              result.kind === 'blocked-index'
                ? 'The draft summary index uses an unsupported schema and was left untouched.'
                : 'The saved draft uses an unsupported schema and was left untouched.',
          };
        }
        if (result.kind === 'conflict') {
          return { kind: 'conflict', currentWorkingRevision: result.revision, status: 'durable' };
        }
        this.memoryWorking.set(key, clone(record));
        this.updateMemoryWorkingSummary(address, record);
        this.workingEvent(address);
        this.workingIndexEvent(address);
        return { kind: 'saved', workingRevision: nextWorkingRevision, status: 'durable' };
      } catch (error) {
        await this.seedMemoryNamespace(address.contextId, address.teamName);
        this.markMemoryOnly(address.contextId, address.teamName, error);
        const current = this.memoryWorking.get(key) ?? emptyWorking(address);
        if (current.workingRevision !== expectedRevision) {
          return {
            kind: 'conflict',
            currentWorkingRevision: current.workingRevision,
            status: 'memory-only',
          };
        }
        this.memoryWorking.set(key, clone(record));
        this.updateMemoryWorkingSummary(address, record);
        this.workingEvent(address);
        this.workingIndexEvent(address);
        return { kind: 'saved', workingRevision: nextWorkingRevision, status: 'memory-only' };
      }
    });
  }

  async listWorkingSummaries(contextId: string, teamName: string): Promise<{
    summaries: ComposerWorkingSummary[];
    status: ComposerPersistenceStatus;
    readError?: string;
  }> {
    const namespace = this.namespace(contextId, teamName);
    try {
      await this.ensureWorkingIndexMigrated(contextId, teamName);
    } catch (error) {
      return {
        summaries: [],
        status: 'durable',
        readError: error instanceof Error ? error.message : 'Unable to migrate draft summaries.',
      };
    }
    if (this.memoryNamespaces.has(namespace)) {
      return {
        summaries: clone(this.memoryWorkingIndex(contextId, teamName)),
        status: 'memory-only',
        ...(this.memoryReadErrors.get(namespace)
          ? { readError: this.memoryReadErrors.get(namespace) }
          : {}),
      };
    }
    try {
      const parsed = readComposerWorkingIndex(
        await get<unknown>(composerWorkingIndexKey(contextId, teamName))
      );
      if (parsed.unsupported) {
        return {
          summaries: [],
          status: 'durable',
          readError: 'The draft summary index uses an unsupported schema.',
        };
      }
      this.setMemoryWorkingIndex(contextId, teamName, parsed.summaries);
      return { summaries: clone(parsed.summaries), status: 'durable' };
    } catch (error) {
      await this.seedMemoryNamespace(contextId, teamName);
      this.markMemoryOnly(contextId, teamName, error);
      return {
        summaries: clone(this.memoryWorkingIndex(contextId, teamName)),
        status: 'memory-only',
        readError: 'Unable to load durable draft summaries.',
      };
    }
  }

  discardWorking(
    address: ComposerDraftAddress,
    expectedRevision: string
  ): Promise<'discarded' | 'missing' | 'conflict' | 'blocked'> {
    return this.enqueue(async () => {
      const key = composerDraftAddressKey(address);
      if (this.status(address) === 'memory-only') {
        const current = this.memoryWorking.get(key);
        if (!current) return 'missing';
        if (current.workingRevision !== expectedRevision) return 'conflict';
        this.memoryWorking.delete(key);
        this.updateMemoryWorkingSummary(address, null);
        this.workingEvent(address);
        this.workingIndexEvent(address);
        return 'discarded';
      }
      try {
        const result = await readwrite(async (store) => {
          const indexKey = composerWorkingIndexKey(address.contextId, address.teamName);
          const [raw, indexRaw] = await Promise.all([
            requestValue(store.get(key)),
            requestValue(store.get(indexKey)),
          ]);
          if (raw == null) return 'missing' as const;
          if (!isWorkingRecord(raw) || !sameComposerDraftAddress(raw.address, address)) {
            return 'blocked' as const;
          }
          if (raw.workingRevision !== expectedRevision) return 'conflict' as const;
          const summaries = nextWorkingSummaries(indexRaw, address, null);
          if (!summaries) return 'blocked' as const;
          store.delete(key);
          store.put(workingIndexRecord(summaries), indexKey);
          return 'discarded' as const;
        });
        if (result === 'discarded') {
          this.memoryWorking.delete(key);
          this.updateMemoryWorkingSummary(address, null);
          this.workingEvent(address);
          this.workingIndexEvent(address);
        }
        return result;
      } catch {
        return 'blocked';
      }
    });
  }

  moveWorkingAsNew(
    source: ComposerDraftAddress,
    expectedSourceRevision: string,
    destination: ComposerDraftAddress,
    expectedDestinationRevision: string
  ): Promise<RestoreRecoveryResult> {
    return this.enqueue(async () => {
      if (
        source.contextId !== destination.contextId ||
        source.teamName !== destination.teamName ||
        sameComposerDraftAddress(source, destination)
      ) {
        return {
          kind: 'blocked',
          status: this.status(destination),
          error: 'A draft can only move to another chat in the same team.',
        };
      }
      const sourceKey = composerDraftAddressKey(source);
      const destinationKey = composerDraftAddressKey(destination);
      const makeMoved = (record: ComposerWorkingRecord): ComposerWorkingRecord => ({
        version: 2,
        address: destination,
        workingRevision: nextRevision('move'),
        content: record.content
          ? { ...record.content, restoredOrigin: undefined }
          : null,
        editorContext: { kind: 'plain' },
        updatedAt: Date.now(),
      });
      const namespace = composerDraftNamespace(source);
      if (this.memoryNamespaces.has(namespace)) {
        const sourceRecord = this.memoryWorking.get(sourceKey);
        const destinationRecord = this.memoryWorking.get(destinationKey) ?? emptyWorking(destination);
        if (!sourceRecord) return { kind: 'missing', status: 'memory-only' };
        if (
          sourceRecord.workingRevision !== expectedSourceRevision ||
          !sourceRecord.content ||
          destinationRecord.workingRevision !== expectedDestinationRevision ||
          destinationRecord.content != null
        ) {
          return { kind: 'conflict', status: 'memory-only' };
        }
        const moved = makeMoved(sourceRecord);
        this.memoryWorking.delete(sourceKey);
        this.memoryWorking.set(destinationKey, clone(moved));
        this.updateMemoryWorkingSummary(source, null);
        this.updateMemoryWorkingSummary(destination, moved);
        this.workingEvent(source);
        this.workingEvent(destination);
        this.workingIndexEvent(destination);
        return { kind: 'restored', working: moved, status: 'memory-only' };
      }
      try {
        const result = await readwrite(async (store) => {
          const indexKey = composerWorkingIndexKey(source.contextId, source.teamName);
          const [sourceRaw, destinationRaw, indexRaw] = await Promise.all([
            requestValue(store.get(sourceKey)),
            requestValue(store.get(destinationKey)),
            requestValue(store.get(indexKey)),
          ]);
          if (!isWorkingRecord(sourceRaw) || !sameComposerDraftAddress(sourceRaw.address, source)) {
            return sourceRaw == null ? { kind: 'missing' as const } : { kind: 'blocked' as const };
          }
          if (
            destinationRaw != null &&
            (!isWorkingRecord(destinationRaw) ||
              !sameComposerDraftAddress(destinationRaw.address, destination))
          ) {
            return { kind: 'blocked' as const };
          }
          const currentDestination = isWorkingRecord(destinationRaw)
            ? destinationRaw
            : emptyWorking(destination);
          if (
            sourceRaw.workingRevision !== expectedSourceRevision ||
            !sourceRaw.content ||
            currentDestination.workingRevision !== expectedDestinationRevision ||
            currentDestination.content != null
          ) {
            return { kind: 'conflict' as const };
          }
          const parsedIndex = readComposerWorkingIndex(indexRaw);
          if (parsedIndex.unsupported) return { kind: 'blocked-index' as const };
          const moved = makeMoved(sourceRaw);
          const withoutSource = removeComposerWorkingSummary(parsedIndex.summaries, source);
          const movedSummary = workingSummaryFor(moved);
          if (!movedSummary) return { kind: 'blocked' as const };
          store.delete(sourceKey);
          store.put(moved, destinationKey);
          store.put(
            workingIndexRecord(upsertComposerWorkingSummary(withoutSource, movedSummary)),
            indexKey
          );
          return { kind: 'restored' as const, moved };
        });
        if (result.kind === 'blocked' || result.kind === 'blocked-index') {
          return {
            kind: 'blocked',
            status: 'durable',
            error: result.kind === 'blocked-index'
              ? 'The draft summary index uses an unsupported schema and was left untouched.'
              : 'The draft uses an unsupported schema and was left untouched.',
          };
        }
        if (result.kind !== 'restored') return { kind: result.kind, status: 'durable' };
        this.memoryWorking.delete(sourceKey);
        this.memoryWorking.set(destinationKey, clone(result.moved));
        this.updateMemoryWorkingSummary(source, null);
        this.updateMemoryWorkingSummary(destination, result.moved);
        this.workingEvent(source);
        this.workingEvent(destination);
        this.workingIndexEvent(destination);
        return { kind: 'restored', working: result.moved, status: 'durable' };
      } catch {
        return {
          kind: 'blocked',
          status: 'durable',
          error: 'The draft could not be moved safely.',
        };
      }
    });
  }

  discardNamespace(
    contextId: string,
    teamName: string
  ): Promise<'discarded' | 'blocked'> {
    return this.enqueue(async () => {
      const prefix = composerNamespacePrefix(contextId, teamName);
      const clearMemory = (): void => {
        for (const key of [...this.memoryWorking.keys()]) {
          if (key.startsWith(prefix)) this.memoryWorking.delete(key);
        }
        for (const key of [...this.memoryRecoveries.keys()]) {
          if (key.startsWith(prefix)) this.memoryRecoveries.delete(key);
        }
        const namespace = this.namespace(contextId, teamName);
        this.memoryIndexes.delete(namespace);
        this.memoryWorkingIndexes.delete(namespace);
        this.memoryNamespaces.delete(namespace);
        this.memoryReadErrors.delete(namespace);
        this.migratedWorkingNamespaces.delete(namespace);
        this.emit({ kind: 'working-index', contextId, teamName });
        this.recoveriesEvent(contextId, teamName);
      };
      try {
        await readwrite(async (store) => {
          const entries = await composerDraftEntriesByPrefix(store, prefix);
          for (const [key] of entries) store.delete(key);
        });
      } catch (error) {
        clearMemory();
        console.warn('[composerDraftRepository] Namespace cleanup failed:', {
          namespace: this.namespace(contextId, teamName),
          errorClass: error instanceof Error ? error.name : 'UnknownError',
        });
        return 'blocked';
      }
      clearMemory();
      return 'discarded';
    });
  }

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
            (!isWorkingRecord(workingRaw) ||
              !sameComposerDraftAddress(workingRaw.address, address))
          ) {
            return { kind: 'blocked' as const };
          }
          if (existingRaw != null) return null;
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
            { version: 2, summaries: upsertSummary(readIndex(indexRaw), summaryFor(recovery)) },
            indexKey
          );
          return { kind: 'prepared' as const, workingCleared, currentWorkingRevision };
        });
        if (result == null) return { kind: 'already-exists', status: 'durable' };
        if (result.kind === 'blocked' || result.kind === 'blocked-index') {
          return {
            kind: 'blocked',
            status: 'durable',
            error:
              result.kind === 'blocked-index'
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
            { version: 2, summaries: upsertSummary(readIndex(rawIndex), summaryFor(updated)) },
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
        const summary = this.memoryIndex(contextId, teamName).find((candidate) => candidate.id === id);
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
          const summaries = readIndex(rawIndex);
          const currentSummary = summaries.find((candidate) => candidate.id === id);
          if (!currentSummary?.address) return 'missing' as const;
          const recoveryKey = composerRecoveryKey(currentSummary.address, id);
          const rawRecovery = await requestValue(store.get(recoveryKey));
          if (!isRecoveryRecord(rawRecovery)) return 'missing' as const;
          if (!isReconcilable(rawRecovery)) return 'mismatch' as const;
          store.delete(recoveryKey);
          store.put(
            { version: 2, summaries: removeSummary(summaries, id) },
            indexKey
          );
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
        (!current.content.text && !current.content.chips.length && !current.content.attachments.length)
      ) {
        return { kind: 'conflict', status: currentResult.status };
      }
      const attempt: PreparedComposerAttempt = {
        attemptId: id,
        snapshot: { content: current.content, editorContext: current.editorContext },
        preparedRequest: { kind: 'local', teamName: address.teamName, request: { member: '', text: '' } },
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

  async listRecoveries(contextId: string, teamName: string): Promise<{
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
        summaries = readIndex(await get<unknown>(composerRecoveryIndexKey(contextId, teamName)));
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
            store.put(restored.working, destinationKey);
            store.put(workingIndexRecord(workingSummaries), destinationIndexKey);
            store.delete(sourceKey);
            store.put(
              { version: 2, summaries: removeSummary(readIndex(indexRaw), id) },
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
        if (committed === 'blocked' || committed === 'blocked-index') {
          return {
            kind: 'blocked',
            status: 'durable',
            error:
              committed === 'blocked-index'
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
        this.setMemoryIndex(contextId, teamName, removeSummary(this.memoryIndex(contextId, teamName), id));
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
          store.delete(recoveryKey);
          store.put({ version: 2, summaries: removeSummary(readIndex(rawIndex), id) }, indexKey);
          return true;
        });
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
