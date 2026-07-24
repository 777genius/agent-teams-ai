import {
  NodeExternalContentChecksum,
  NodeExternalFileObservationSource,
  NodeExternalWriterWatchPort,
  type NodeExternalWriterWatchPortOptions,
  RegisteredExternalFileCatalog,
  type RegisteredExternalFileDefinition,
} from '../infrastructure';

export interface CreateExternalWriterFileAdaptersInput {
  files: readonly RegisteredExternalFileDefinition[];
  watchOptions?: NodeExternalWriterWatchPortOptions;
}

export interface ExternalWriterFileAdapters {
  catalog: RegisteredExternalFileCatalog;
  watch: NodeExternalWriterWatchPort;
  source: NodeExternalFileObservationSource;
  checksums: NodeExternalContentChecksum;
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
    watch: new NodeExternalWriterWatchPort(catalog, input.watchOptions),
    source: new NodeExternalFileObservationSource(catalog),
    checksums: new NodeExternalContentChecksum(),
  });
};
