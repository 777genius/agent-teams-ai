import {
  NodeExternalContentChecksum,
  NodeExternalFileObservationSource,
  NodeExternalWriterWatchPort,
  RegisteredExternalFileCatalog,
} from '../infrastructure';

import type {
  CreateExternalWriterFileAdaptersInput,
  ExternalWriterFileAdapters,
} from '../application/externalWriterFileAdapterContracts';

export type {
  CreateExternalWriterFileAdaptersInput,
  ExternalWriterFileAdapters,
} from '../application/externalWriterFileAdapterContracts';

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
