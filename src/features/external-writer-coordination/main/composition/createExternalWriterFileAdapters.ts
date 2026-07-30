import {
  NodeExternalContentChecksum,
  NodeExternalFileObservationSource,
  NodeExternalWriterWatchPort as NodeExternalWriterWatchPortImplementation,
  RegisteredExternalFileCatalog,
} from '../infrastructure';

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
  getInvalidations(): readonly NodeExternalWriterWatchInvalidation[];
}

export interface NodeExternalWriterWatchPort extends ExternalWriterWatchPort {
  start(
    callbacks: Parameters<ExternalWriterWatchPort['start']>[0]
  ): Promise<NodeExternalWriterWatchHandle>;
  getInvalidations(): readonly NodeExternalWriterWatchInvalidation[];
}

export type ExternalWriterFileWatchHandle = NodeExternalWriterWatchHandle;
export type ExternalWriterFileWatchPort = NodeExternalWriterWatchPort;

export interface CreateExternalWriterFileAdaptersInput {
  files: readonly RegisteredExternalFileDefinition[];
  watchOptions?: NodeExternalWriterWatchPortOptions;
}

export interface ExternalWriterFileAdapters {
  catalog: ExternalFileObservationCatalog;
  watch: NodeExternalWriterWatchPort;
  source: ExternalFileObservationSource;
  checksums: ExternalContentChecksumPort;
}

/**
 * Main-process composition boundary. Raw paths enter only here and are frozen
 * into the validated catalog before any watcher or observation source exists.
 */
export const createExternalWriterFileAdapters = (
  input: CreateExternalWriterFileAdaptersInput
): ExternalWriterFileAdapters => {
  const catalog = new RegisteredExternalFileCatalog(input.files);
  return Object.freeze({
    catalog,
    watch: new NodeExternalWriterWatchPortImplementation(catalog, input.watchOptions),
    source: new NodeExternalFileObservationSource(catalog),
    checksums: new NodeExternalContentChecksum(),
  });
};
