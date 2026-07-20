import { watch } from 'node:fs';
import { basename } from 'node:path';

import type { ExternalWriterScope, ExternalWriterWatchCallbacks } from '../../contracts';
import type { ExternalWriterWatchHandle, ExternalWriterWatchPort } from '../../core/application';
import type {
  RegisteredExternalFile,
  RegisteredExternalFileCatalog,
} from './RegisteredExternalFileCatalog';

export interface NodeExternalWriterNativeWatcher {
  on(event: 'error', listener: (error: Error) => void): NodeExternalWriterNativeWatcher;
  close(): void;
}

export type NodeExternalWriterWatchFactory = (input: {
  parentPath: string;
  persistent: boolean;
  onEvent: (eventType: string, fileName: string | Buffer | null) => void;
}) => NodeExternalWriterNativeWatcher;

export interface NodeExternalWriterWatchPortOptions {
  onInvalidation?: (invalidation: NodeExternalWriterWatchInvalidation) => void;
  persistent?: boolean;
  watchFactory?: NodeExternalWriterWatchFactory;
}

export type NodeExternalWriterWatchInvalidationReason =
  | 'native_watch_error'
  | 'watched_identity_replaced';

export interface NodeExternalWriterWatchInvalidation {
  kind: 'terminal_invalidation';
  reason: NodeExternalWriterWatchInvalidationReason;
  reestablishment: 'construct_and_start_fresh_catalog_and_port';
  scopes: readonly ExternalWriterScope[];
}

export interface NodeExternalWriterWatchHandle extends ExternalWriterWatchHandle {
  /** Every entry is terminal for its scopes and can be repaired only with a fresh catalog/port. */
  getInvalidations(): readonly NodeExternalWriterWatchInvalidation[];
}

export type NodeExternalWriterWatchPortErrorCode =
  | 'already_started'
  | 'close_failed'
  | 'start_failed';

export class NodeExternalWriterWatchPortError extends Error {
  constructor(readonly code: NodeExternalWriterWatchPortErrorCode) {
    super(`node-external-writer-watch:${code}`);
    this.name = 'NodeExternalWriterWatchPortError';
  }
}

interface WatchGroup {
  parentPath: string;
  filesByName: ReadonlyMap<string, RegisteredExternalFile>;
  scopes: readonly ExternalWriterScope[];
}

interface ActiveWatchGroup {
  group: WatchGroup;
  watcher: NodeExternalWriterNativeWatcher | null;
  invalidated: boolean;
  watcherClosed: boolean;
  periodicRescan: {
    cancelCompletionTracking: (() => void) | null;
    requestPending: boolean;
    trailingRequested: boolean;
  };
}

// A native watch remains attached to the old inode when its path is renamed.
// Node does not expose the object identity retained by FSWatcher, so matching
// path identities before and after watch() cannot prove attachment: A may be
// replaced by B for watch() and restored before the second check. Each tick
// therefore both invalidates visible identity replacement and requests a
// bounded catalog-scope rescan. The rescan is the fail-closed attachment fence
// for an undetectable ABA; it observes writes to the current expected object
// even if the native watcher was attached to the transient replacement.
const IDENTITY_CHECK_INTERVAL_MS = 1_000;

const platformNameKey = (name: string): string =>
  process.platform === 'win32' ? name.toLocaleLowerCase('en-US') : name;

const scopeKey = (scope: ExternalWriterScope): string =>
  `${scope.teamId.length}:${scope.teamId}${scope.featureKey.length}:${scope.featureKey}`;

const defaultWatchFactory: NodeExternalWriterWatchFactory = ({ parentPath, persistent, onEvent }) =>
  watch(
    parentPath,
    {
      encoding: 'utf8',
      persistent,
      recursive: false,
    },
    onEvent
  );

const buildWatchGroups = (catalog: RegisteredExternalFileCatalog): readonly WatchGroup[] => {
  const filesByParent = new Map<string, RegisteredExternalFile[]>();
  for (const file of catalog.listRegisteredFiles()) {
    const files = filesByParent.get(file.realParentPath) ?? [];
    files.push(file);
    filesByParent.set(file.realParentPath, files);
  }

  return Object.freeze(
    [...filesByParent].map(([parentPath, files]) => {
      const scopesByKey = new Map<string, ExternalWriterScope>();
      const filesByName = new Map<string, RegisteredExternalFile>();
      for (const file of files) {
        filesByName.set(platformNameKey(basename(file.realFilePath)), file);
        scopesByKey.set(scopeKey(file.registration.scope), file.registration.scope);
      }
      return Object.freeze({
        parentPath,
        filesByName,
        scopes: Object.freeze([...scopesByKey.values()]),
      });
    })
  );
};

/**
 * Watches only parent directories that contain registered files. Native events
 * are filtered back to exact catalog identities before crossing the port.
 */
export class NodeExternalWriterWatchPort implements ExternalWriterWatchPort {
  private readonly catalog: RegisteredExternalFileCatalog;
  private readonly groups: readonly WatchGroup[];
  private readonly onInvalidation:
    | ((invalidation: NodeExternalWriterWatchInvalidation) => void)
    | undefined;
  private readonly invalidations: NodeExternalWriterWatchInvalidation[] = [];
  private readonly persistent: boolean;
  private readonly watchFactory: NodeExternalWriterWatchFactory;
  private started = false;

  constructor(
    catalog: RegisteredExternalFileCatalog,
    options: NodeExternalWriterWatchPortOptions = {}
  ) {
    this.catalog = catalog;
    this.groups = buildWatchGroups(catalog);
    this.onInvalidation = options.onInvalidation;
    this.persistent = options.persistent ?? false;
    this.watchFactory = options.watchFactory ?? defaultWatchFactory;
  }

  getInvalidations(): readonly NodeExternalWriterWatchInvalidation[] {
    return Object.freeze([...this.invalidations]);
  }

  async start(callbacks: ExternalWriterWatchCallbacks): Promise<NodeExternalWriterWatchHandle> {
    if (this.started) {
      throw new NodeExternalWriterWatchPortError('already_started');
    }
    this.started = true;
    const activeWatches: ActiveWatchGroup[] = [];
    let closed = false;
    let closeFailed = false;
    let identityCheckTimer: NodeJS.Timeout | null = null;

    const reportOverflow = (scopes: readonly ExternalWriterScope[]): boolean => {
      if (closed || scopes.length === 0) {
        return false;
      }
      try {
        callbacks.onOverflow({ scopes });
        return true;
      } catch {
        // The native callback must never throw into Node's watcher event loop.
        return false;
      }
    };

    const isGroupCurrent = (group: WatchGroup): boolean =>
      [...group.filesByName.values()].every((file) => this.catalog.isRootAndParentCurrent(file));

    const isGroupCatalogAdmitted = (group: WatchGroup): boolean =>
      group.scopes.every((scope) => !this.catalog.isWatchScopeInvalidated(scope));

    const closeNativeWatch = (activeWatch: ActiveWatchGroup): void => {
      if (activeWatch.watcherClosed || activeWatch.watcher === null) {
        return;
      }
      activeWatch.watcherClosed = true;
      try {
        activeWatch.watcher.close();
      } catch {
        closeFailed = true;
      }
    };

    const cancelPeriodicRescan = (activeWatch: ActiveWatchGroup): void => {
      activeWatch.periodicRescan.cancelCompletionTracking?.();
      activeWatch.periodicRescan.cancelCompletionTracking = null;
      activeWatch.periodicRescan.requestPending = false;
      activeWatch.periodicRescan.trailingRequested = false;
    };

    const beginPeriodicRescan = (activeWatch: ActiveWatchGroup): void => {
      const state = activeWatch.periodicRescan;
      state.requestPending = true;
      state.cancelCompletionTracking = this.catalog.onNextScopeScansCompleted(
        activeWatch.group.scopes,
        () => {
          state.cancelCompletionTracking = null;
          state.requestPending = false;
          if (closed || activeWatch.invalidated) {
            state.trailingRequested = false;
            return;
          }
          if (state.trailingRequested) {
            state.trailingRequested = false;
            beginPeriodicRescan(activeWatch);
          }
        }
      );
      if (!reportOverflow(activeWatch.group.scopes)) {
        cancelPeriodicRescan(activeWatch);
      }
    };

    const requestPeriodicRescan = (activeWatch: ActiveWatchGroup): void => {
      if (closed || activeWatch.invalidated) {
        return;
      }
      if (activeWatch.periodicRescan.requestPending) {
        // Retain exactly one trailing edge. It is requested only after the
        // current catalog-scope scan, including reconciliation, completes.
        activeWatch.periodicRescan.trailingRequested = true;
        return;
      }
      beginPeriodicRescan(activeWatch);
    };

    const invalidateWatch = (
      activeWatch: ActiveWatchGroup,
      reason: NodeExternalWriterWatchInvalidationReason
    ): void => {
      if (closed || activeWatch.invalidated) {
        return;
      }
      activeWatch.invalidated = true;
      const invalidation = Object.freeze({
        kind: 'terminal_invalidation' as const,
        reason,
        reestablishment: 'construct_and_start_fresh_catalog_and_port' as const,
        scopes: activeWatch.group.scopes,
      });
      // Retire the catalog before reporting overflow. The observer's recovery
      // rescan must fail closed instead of clearing dirty state while this
      // group is permanently detached from the watched path.
      this.catalog.invalidateWatchScopes(activeWatch.group.scopes);
      cancelPeriodicRescan(activeWatch);
      closeNativeWatch(activeWatch);
      this.invalidations.push(invalidation);
      try {
        this.onInvalidation?.(invalidation);
      } catch {
        // Invalidation remains recorded even when a diagnostic consumer fails.
      }
      reportOverflow(activeWatch.group.scopes);
    };

    const verifyWatchIdentity = (activeWatch: ActiveWatchGroup): void => {
      if (!closed && !activeWatch.invalidated && !isGroupCurrent(activeWatch.group)) {
        invalidateWatch(activeWatch, 'watched_identity_replaced');
      }
    };

    try {
      for (const group of this.groups) {
        if (!isGroupCatalogAdmitted(group) || !isGroupCurrent(group)) {
          throw new NodeExternalWriterWatchPortError('start_failed');
        }
        const activeWatch: ActiveWatchGroup = {
          group,
          watcher: null,
          invalidated: false,
          watcherClosed: false,
          periodicRescan: {
            cancelCompletionTracking: null,
            requestPending: false,
            trailingRequested: false,
          },
        };
        const watcher = this.watchFactory({
          parentPath: group.parentPath,
          persistent: this.persistent,
          onEvent: (eventType, fileName) => {
            if (closed || activeWatch.invalidated) {
              return;
            }
            if (!isGroupCurrent(group)) {
              invalidateWatch(activeWatch, 'watched_identity_replaced');
              return;
            }
            if (fileName === null) {
              reportOverflow(group.scopes);
              return;
            }
            const decodedName = Buffer.isBuffer(fileName) ? fileName.toString('utf8') : fileName;
            const file = group.filesByName.get(platformNameKey(decodedName));
            if (!file) {
              return;
            }
            const kind =
              eventType === 'change' ? 'change' : eventType === 'rename' ? 'rename' : null;
            if (kind === null) {
              reportOverflow(Object.freeze([file.registration.scope]));
              return;
            }
            try {
              callbacks.onNotification({
                kind,
                scope: file.registration.scope,
                fileKey: file.registration.fileKey,
              });
            } catch {
              reportOverflow(Object.freeze([file.registration.scope]));
            }
          },
        });
        activeWatch.watcher = watcher;
        activeWatches.push(activeWatch);
        watcher.on('error', () => invalidateWatch(activeWatch, 'native_watch_error'));
        if (!isGroupCatalogAdmitted(group) || !isGroupCurrent(group)) {
          throw new NodeExternalWriterWatchPortError('start_failed');
        }
      }
      if (activeWatches.length > 0) {
        identityCheckTimer = setInterval(() => {
          for (const activeWatch of activeWatches) {
            verifyWatchIdentity(activeWatch);
            if (!closed && !activeWatch.invalidated) {
              requestPeriodicRescan(activeWatch);
            }
          }
        }, IDENTITY_CHECK_INTERVAL_MS);
        identityCheckTimer.unref();
      }
    } catch {
      closed = true;
      if (identityCheckTimer !== null) {
        clearInterval(identityCheckTimer);
        identityCheckTimer = null;
      }
      for (const activeWatch of activeWatches) {
        cancelPeriodicRescan(activeWatch);
        closeNativeWatch(activeWatch);
      }
      throw new NodeExternalWriterWatchPortError('start_failed');
    }

    return Object.freeze({
      getInvalidations: (): readonly NodeExternalWriterWatchInvalidation[] =>
        this.getInvalidations(),
      close: async (): Promise<void> => {
        if (closed) {
          return;
        }
        closed = true;
        if (identityCheckTimer !== null) {
          clearInterval(identityCheckTimer);
          identityCheckTimer = null;
        }
        for (const activeWatch of activeWatches) {
          cancelPeriodicRescan(activeWatch);
          closeNativeWatch(activeWatch);
        }
        if (closeFailed) {
          throw new NodeExternalWriterWatchPortError('close_failed');
        }
      },
    });
  }
}
