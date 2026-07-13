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
  | { id: string; op: `appCommandLedger.${string}`; payload: unknown }
  | { id: string; op: `mws.${string}`; payload: unknown }
  | { id: string; op: 'close'; payload: Record<string, never> };

export type InternalStorageWorkerOp = InternalStorageWorkerRequest['op'];

interface JournalReplacePayloadByOp {
  'stallJournal.replace': { teamName: string; entries: StallJournalEntryRecord[] };
  'commentJournal.replace': { teamName: string; entries: CommentJournalEntryRecord[] };
}

/**
 * Runtime-checks the team-isolation invariant before a replace operation can
 * delete any rows. TypeScript cannot guarantee that every entry's embedded
 * teamName agrees with the payload teamName after the worker-thread hop.
 */
export function parseJournalReplacePayload<TOp extends keyof JournalReplacePayloadByOp>(
  op: TOp,
  payload: unknown
): JournalReplacePayloadByOp[TOp] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`Invalid ${op} payload: expected an object`);
  }

  const candidate = payload as { teamName?: unknown; entries?: unknown };
  if (typeof candidate.teamName !== 'string') {
    throw new Error(`Invalid ${op} payload: teamName must be a string`);
  }
  if (!Array.isArray(candidate.entries)) {
    throw new Error(`Invalid ${op} payload: entries must be an array`);
  }

  for (const [index, entry] of candidate.entries.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Invalid ${op} payload: entries[${index}] must be an object`);
    }
    const entryTeamName = (entry as { teamName?: unknown }).teamName;
    if (entryTeamName !== candidate.teamName) {
      throw new Error(
        `Invalid ${op} payload: entries[${index}].teamName must match payload teamName`
      );
    }
  }

  return candidate as JournalReplacePayloadByOp[TOp];
}

export type InternalStorageWorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };
