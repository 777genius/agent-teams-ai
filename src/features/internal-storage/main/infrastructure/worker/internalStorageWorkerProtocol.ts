import type { StallJournalEntryRecord } from '../../../contracts/internalStorageContracts';

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
  | {
      id: string;
      op: 'storeImports.record';
      payload: { storeId: string; teamName: string; entryCount: number };
    }
  | { id: string; op: 'close'; payload: Record<string, never> };

export type InternalStorageWorkerOp = InternalStorageWorkerRequest['op'];

export type InternalStorageWorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };
