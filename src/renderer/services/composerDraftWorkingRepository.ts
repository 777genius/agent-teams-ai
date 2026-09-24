import {
  composerDraftEntriesByPrefix,
  composerDraftReadwrite as readwrite,
  requestValue,
} from '@renderer/services/composerDraftIndexedDb';
import {
  createComposerWorkingRevision as nextRevision,
  createEmptyComposerWorking as emptyWorking,
  isComposerRecoveryRecord as isRecoveryRecord,
  isComposerWorkingRecord as isWorkingRecord,
  readComposerRecoveryIndex as readIndex,
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
  sameComposerDraftAddress,
} from '@renderer/utils/composerDraftIdentity';
import { get } from 'idb-keyval';

import type {
  ComposerDraftAddress,
  ComposerDraftContent,
  ComposerDraftRepositoryEvent,
  ComposerEditorContext,
  ComposerPersistenceStatus,
  ComposerRecoveryRecord,
  ComposerRecoverySummary,
  ComposerWorkingRecord,
  ComposerWorkingSummary,
  RestoreRecoveryResult,
  SaveWorkingResult,
} from '@renderer/types/composerDraft';

export function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

class UnsupportedWorkingIndexError extends Error {}

export function workingIndexRecord(summaries: readonly ComposerWorkingSummary[]): {
  readonly version: 1;
  readonly summaries: readonly ComposerWorkingSummary[];
} {
  return { version: 1, summaries };
}

export function nextWorkingSummaries(
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

export class ComposerDraftWorkingRepository {
  protected readonly listeners = new Set<(event: ComposerDraftRepositoryEvent) => void>();
  protected readonly activeAttempts = new Set<string>();
  protected readonly memoryNamespaces = new Set<string>();
  protected readonly memoryWorking = new Map<string, ComposerWorkingRecord>();
  protected readonly memoryRecoveries = new Map<string, ComposerRecoveryRecord>();
  private readonly memoryIndexes = new Map<string, ComposerRecoverySummary[]>();
  private readonly memoryWorkingIndexes = new Map<string, ComposerWorkingSummary[]>();
  protected readonly memoryReadErrors = new Map<string, string>();
  private readonly workingMigrations = new Map<string, Promise<void>>();
  private readonly migratedWorkingNamespaces = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  protected status(address: ComposerDraftAddress): ComposerPersistenceStatus {
    return this.memoryNamespaces.has(composerDraftNamespace(address)) ? 'memory-only' : 'durable';
  }

  protected namespace(contextId: string, teamName: string): string {
    return `${encodeURIComponent(contextId)}:${encodeURIComponent(teamName)}`;
  }

  protected enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => undefined).then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private emit(event: ComposerDraftRepositoryEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  protected workingEvent(address: ComposerDraftAddress): void {
    this.emit({
      kind: 'working',
      address,
      contextId: address.contextId,
      teamName: address.teamName,
    });
  }

  protected recoveriesEvent(contextId: string, teamName: string): void {
    this.emit({ kind: 'recoveries', contextId, teamName });
  }

  protected workingIndexEvent(address: ComposerDraftAddress): void {
    this.emit({
      kind: 'working-index',
      address,
      contextId: address.contextId,
      teamName: address.teamName,
    });
  }

  protected attemptStateEvent(address: ComposerDraftAddress): void {
    this.emit({
      kind: 'attempt-state',
      address,
      contextId: address.contextId,
      teamName: address.teamName,
    });
  }

  protected markMemoryOnly(contextId: string, teamName: string, error: unknown): void {
    const namespace = this.namespace(contextId, teamName);
    this.memoryNamespaces.add(namespace);
    const message = error instanceof Error ? error.message : 'IndexedDB is unavailable.';
    this.memoryReadErrors.set(namespace, message);
    console.warn('[composerDraftRepository] Using session-memory overlay:', message);
  }

  protected memoryIndex(contextId: string, teamName: string): ComposerRecoverySummary[] {
    return this.memoryIndexes.get(this.namespace(contextId, teamName)) ?? [];
  }

  protected setMemoryIndex(
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

  protected updateMemoryWorkingSummary(
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

  protected async seedMemoryNamespace(contextId: string, teamName: string): Promise<void> {
    const namespace = this.namespace(contextId, teamName);
    if (this.memoryIndexes.has(namespace) && this.memoryWorkingIndexes.has(namespace)) return;
    try {
      const [recoveryRaw, workingRaw] = await Promise.all([
        get<unknown>(composerRecoveryIndexKey(contextId, teamName)),
        get<unknown>(composerWorkingIndexKey(contextId, teamName)),
      ]);
      const summaries = readIndex(recoveryRaw).summaries;
      this.setMemoryIndex(contextId, teamName, summaries);
      const workingSummaries = readComposerWorkingIndex(workingRaw).summaries;
      this.setMemoryWorkingIndex(contextId, teamName, workingSummaries);
      await Promise.all([
        ...summaries.map(async (summary) => {
          if (summary.legacy || !summary.address) return;
          const raw = await get<unknown>(composerRecoveryKey(summary.address, summary.id));
          if (isRecoveryRecord(raw)) {
            this.memoryRecoveries.set(composerRecoveryKey(summary.address, summary.id), clone(raw));
          }
        }),
        ...workingSummaries.map(async (summary) => {
          const key = composerDraftAddressKey(summary.address);
          const raw = await get<unknown>(key);
          if (isWorkingRecord(raw) && sameComposerDraftAddress(raw.address, summary.address)) {
            this.memoryWorking.set(key, clone(raw));
          }
        }),
      ]);
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
        const latest =
          isWorkingRecord(latestRaw) && sameComposerDraftAddress(latestRaw.address, address)
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

  async listWorkingSummaries(
    contextId: string,
    teamName: string
  ): Promise<{
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
        content: record.content ? { ...record.content, restoredOrigin: undefined } : null,
        editorContext: { kind: 'plain' },
        updatedAt: Date.now(),
      });
      const namespace = composerDraftNamespace(source);
      if (this.memoryNamespaces.has(namespace)) {
        const sourceRecord = this.memoryWorking.get(sourceKey);
        const destinationRecord =
          this.memoryWorking.get(destinationKey) ?? emptyWorking(destination);
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
            error:
              result.kind === 'blocked-index'
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

  discardNamespace(contextId: string, teamName: string): Promise<'discarded' | 'blocked'> {
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
}
