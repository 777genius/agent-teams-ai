import type {
  CommentJournalEntryRecord,
  InternalStorageBackendInfo,
  StallJournalEntryRecord,
} from '@features/internal-storage/contracts/internalStorageContracts';
import type { InternalStorageGateway } from '@features/internal-storage/core/application/ports';
import type { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';

/** In-process gateway: same op handlers the worker uses, minus the thread hop. */
export class InProcessGateway implements InternalStorageGateway {
  constructor(private readonly core: InternalStorageWorkerCore) {}

  ping(): Promise<InternalStorageBackendInfo> {
    return Promise.resolve(this.core.handle('ping', {}) as InternalStorageBackendInfo);
  }

  loadStallJournalEntries(teamName: string): Promise<StallJournalEntryRecord[]> {
    return Promise.resolve(
      this.core.handle('stallJournal.load', { teamName }) as StallJournalEntryRecord[]
    );
  }

  replaceStallJournalEntries(teamName: string, entries: StallJournalEntryRecord[]): Promise<void> {
    this.core.handle('stallJournal.replace', { teamName, entries });
    return Promise.resolve();
  }

  loadCommentJournalEntries(teamName: string): Promise<CommentJournalEntryRecord[]> {
    return Promise.resolve(
      this.core.handle('commentJournal.load', { teamName }) as CommentJournalEntryRecord[]
    );
  }

  replaceCommentJournalEntries(
    teamName: string,
    entries: CommentJournalEntryRecord[]
  ): Promise<void> {
    this.core.handle('commentJournal.replace', { teamName, entries });
    return Promise.resolve();
  }

  commentJournalExists(teamName: string): Promise<boolean> {
    return Promise.resolve(this.core.handle('commentJournal.exists', { teamName }) === true);
  }

  ensureCommentJournalInitialized(teamName: string): Promise<void> {
    this.core.handle('commentJournal.ensureInitialized', { teamName });
    return Promise.resolve();
  }

  recordStoreImport(storeId: string, teamName: string, entryCount: number): Promise<void> {
    this.core.handle('storeImports.record', { storeId, teamName, entryCount });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.core.close();
    return Promise.resolve();
  }
}
