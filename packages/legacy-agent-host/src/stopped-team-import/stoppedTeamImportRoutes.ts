import { z } from 'zod';
import { importRequestSchema } from './contracts.js';
import type { FileStoppedSnapshotResolver } from './FileStoppedSnapshotResolver.js';
import type { FileStoppedTeamImport } from './FileStoppedTeamImport.js';

const context = z.object({ contextId: z.string().min(1).max(256) }).strict();
/** Finite Host lane; trusted composition checks owner envelope/principal before these methods. */
export function stoppedTeamImportRoutes(
  publisher: FileStoppedTeamImport,
  snapshots: FileStoppedSnapshotResolver
) {
  return {
    publish(commandId: string, raw: unknown) {
      const request = importRequestSchema.parse(raw);
      const prior = publisher.lookup(commandId, request.contextId, request);
      return prior
        ? publisher.retry(commandId, request.contextId)!
        : publisher.import(commandId, request, snapshots.read(request));
    },
    lookup(commandId: string, raw: unknown) {
      const parsed = context.safeParse(raw);
      if (parsed.success) return publisher.lookup(commandId, parsed.data.contextId);
      const request = importRequestSchema.parse(raw);
      return publisher.lookup(commandId, request.contextId, request);
    },
    retry(commandId: string, raw: unknown) {
      const request = importRequestSchema.parse(raw);
      publisher.lookup(commandId, request.contextId, request);
      return publisher.retry(commandId, request.contextId);
    },
    list(raw: unknown) {
      const { contextId } = context.parse(raw);
      return { entries: publisher.listImports(contextId) };
    },
  };
}
