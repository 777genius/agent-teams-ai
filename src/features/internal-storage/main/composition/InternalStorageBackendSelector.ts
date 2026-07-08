import { createLogger } from '@shared/utils/logger';

import type {
  InternalStorageBackendInfo,
  InternalStorageBackendKind,
} from '../../contracts/internalStorageContracts';

const logger = createLogger('Feature:InternalStorage');

/**
 * Decides the storage backend once per session, on first store access, and
 * shares that decision across every store in the feature so state never
 * splits between backends.
 *
 * If the initial ping fails (worker bundle missing, native module ABI
 * mismatch, unrecoverable database corruption) the session permanently falls
 * back to the legacy JSON stores, so the app keeps working with degraded
 * storage. After a successful ping there is no mid-session switch: a later
 * error propagates to the caller instead of silently changing backends.
 */
export class InternalStorageBackendSelector {
  private decision: Promise<InternalStorageBackendKind> | null = null;
  private backendKind: InternalStorageBackendKind = 'sqlite';

  constructor(private readonly ping: () => Promise<InternalStorageBackendInfo>) {}

  getBackendKind(): InternalStorageBackendKind {
    return this.backendKind;
  }

  async select<T>(sqliteBackend: T, jsonBackend: T): Promise<T> {
    const kind = await this.resolve();
    return kind === 'sqlite' ? sqliteBackend : jsonBackend;
  }

  private resolve(): Promise<InternalStorageBackendKind> {
    if (!this.decision) {
      this.decision = this.ping()
        .then((info): InternalStorageBackendKind => {
          const message = `internal-storage backend=sqlite schemaVersion=${info.schemaVersion} integrity=${info.integrity} db=${info.databasePath}`;
          if (info.integrity === 'recovered') {
            logger.warn(message);
          } else {
            logger.info(message);
          }
          return 'sqlite';
        })
        .catch((error: unknown): InternalStorageBackendKind => {
          this.backendKind = 'json-fallback';
          logger.error(
            'internal-storage sqlite backend unavailable; falling back to JSON stores for this session',
            error
          );
          return 'json-fallback';
        });
    }
    return this.decision;
  }
}
