import type { ExternalFileRegistration, ExternalWriterScope } from '../../contracts';
import type {
  ExternalContentChecksumPort,
  ExternalFileObservationCatalog,
  ExternalFileObservationSource,
  ExternalWriterWatchHandle,
  ExternalWriterWatchPort,
} from '../../core/application';

export interface RegisteredExternalFileDefinition {
  registration: ExternalFileRegistration;
  rootPath: string;
  filePath: string;
}

export interface RegisteredExternalFile {
  registration: ExternalFileRegistration;
  rootPath: string;
  realRootPath: string;
  rootDevice: string;
  rootInode: string;
  filePath: string;
  realFilePath: string;
  parentPath: string;
  realParentPath: string;
  parentDevice: string;
  parentInode: string;
}

export interface NodeExternalWriterNativeWatcher {
  on(event: 'error', listener: (error: Error) => void): NodeExternalWriterNativeWatcher;
  close(): void;
}

export type NodeExternalWriterWatchFactory = (input: {
  parentPath: string;
  persistent: boolean;
  onEvent: (eventType: string, fileName: string | Buffer | null) => void;
}) => NodeExternalWriterNativeWatcher;

export type NodeExternalWriterWatchInvalidationReason =
  | 'native_watch_error'
  | 'watched_identity_replaced';

export interface NodeExternalWriterWatchInvalidation {
  kind: 'terminal_invalidation';
  reason: NodeExternalWriterWatchInvalidationReason;
  reestablishment: 'construct_and_start_fresh_catalog_and_port';
  scopes: readonly ExternalWriterScope[];
}

export interface NodeExternalWriterWatchPortOptions {
  onInvalidation?: (invalidation: NodeExternalWriterWatchInvalidation) => void;
  persistent?: boolean;
  watchFactory?: NodeExternalWriterWatchFactory;
}

export interface NodeExternalWriterWatchHandle extends ExternalWriterWatchHandle {
  /** Every entry is terminal for its scopes and can be repaired only with a fresh catalog/port. */
  getInvalidations(): readonly NodeExternalWriterWatchInvalidation[];
}

export interface ExternalWriterFileWatchPort extends ExternalWriterWatchPort {
  start(
    callbacks: Parameters<ExternalWriterWatchPort['start']>[0]
  ): Promise<NodeExternalWriterWatchHandle>;
  getInvalidations(): readonly NodeExternalWriterWatchInvalidation[];
}

export type ExternalWriterFileWatchHandle = NodeExternalWriterWatchHandle;

export type NodeExternalFileObservationSourceErrorCode =
  | 'invalid_max_bytes'
  | 'outside_containment'
  | 'oversized'
  | 'symlink_not_allowed'
  | 'unstable'
  | 'unsupported_file_type';

export class NodeExternalFileObservationSourceError extends Error {
  constructor(readonly code: NodeExternalFileObservationSourceErrorCode) {
    super(`node-external-file-observation-source:${code}`);
    this.name = 'NodeExternalFileObservationSourceError';
  }
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

export type RegisteredExternalFileCatalogErrorCode =
  | 'duplicate_alias'
  | 'duplicate_registration'
  | 'invalid_registration'
  | 'path_not_absolute'
  | 'path_outside_root'
  | 'root_not_directory'
  | 'symlink_not_allowed'
  | 'unsupported_file_type'
  | 'watch_invalidated';

export class RegisteredExternalFileCatalogError extends Error {
  constructor(readonly code: RegisteredExternalFileCatalogErrorCode) {
    super(`registered-external-file-catalog:${code}`);
    this.name = 'RegisteredExternalFileCatalogError';
  }
}

export type ExternalWriterFileAdapterErrorCode =
  | NodeExternalFileObservationSourceErrorCode
  | NodeExternalWriterWatchPortErrorCode
  | RegisteredExternalFileCatalogErrorCode;

export interface ExternalWriterFileAdapterError extends Error {
  readonly code: ExternalWriterFileAdapterErrorCode;
}

export interface CreateExternalWriterFileAdaptersInput {
  files: readonly RegisteredExternalFileDefinition[];
  watchOptions?: NodeExternalWriterWatchPortOptions;
}

export interface ExternalWriterFileAdapters {
  catalog: ExternalFileObservationCatalog;
  watch: ExternalWriterFileWatchPort;
  source: ExternalFileObservationSource;
  checksums: ExternalContentChecksumPort;
}
