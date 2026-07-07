import type {
  CommentJournalEntryRecord,
  StallJournalEntryRecord,
} from '../../../contracts/internalStorageContracts';

export interface InternalStorageWorkerData {
  databasePath: string;
}

export type InternalStorageWorkerRequest =
  | { id: string; op: 'ping'; payload: Record<string, never> }
  | { id: string; op: 'stallJournal.load'; payload: { teamName: string } }
  | {
      id: string;
      op: 'stallJournal.replace';
      payload: { teamName: string; entries: StallJournalEntryRecord[] };
    }
  | { id: string; op: 'commentJournal.load'; payload: { teamName: string } }
  | {
      id: string;
      op: 'commentJournal.replace';
      payload: { teamName: string; entries: CommentJournalEntryRecord[] };
    }
  | { id: string; op: 'commentJournal.exists'; payload: { teamName: string } }
  | { id: string; op: 'commentJournal.ensureInitialized'; payload: { teamName: string } }
  | {
      id: string;
      op: 'storeImports.record';
      payload: { storeId: string; teamName: string; entryCount: number };
    }
  // Member-work-sync ops share one wire shape; the typed client methods and
  // the worker-side dispatcher (memberWorkSyncWorkerOps) own the payloads.
  | { id: string; op: `mws.${string}`; payload: unknown }
  | { id: string; op: 'close'; payload: Record<string, never> };

export type InternalStorageWorkerOp = InternalStorageWorkerRequest['op'];

export type InternalStorageWorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };
