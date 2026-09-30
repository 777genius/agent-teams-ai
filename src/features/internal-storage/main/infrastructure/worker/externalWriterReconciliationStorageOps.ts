import {
  appendEventJournalRow,
  canonicalCoordinationStorageJson,
  ensureEventMetadata,
} from './coordinationDurabilityState';

import type {
  ExternalWriterReconciliationCommitRequest,
  ExternalWriterReconciliationReceipt,
} from '../../../contracts/externalWriterReconciliationStorageContracts';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

interface ReceiptRow {
  readonly reconciliation_id: string;
  readonly input_sha256: string;
  readonly event_id: string;
  readonly source_generation: number;
  readonly feature_revision: number;
  readonly event_body_json: string;
  readonly committed_at: string;
}

const receipt = (row: ReceiptRow): ExternalWriterReconciliationReceipt =>
  Object.freeze({
    reconciliationId: row.reconciliation_id,
    inputSha256: row.input_sha256,
    eventId: row.event_id,
    sourceGeneration: row.source_generation,
    featureRevision: row.feature_revision,
    eventBodyJson: row.event_body_json,
    committedAt: row.committed_at,
  });

export class ExternalWriterReconciliationStorageOps {
  constructor(private readonly getDb: () => SqliteDatabase) {}

  get(input: {
    readonly deploymentId: string;
    readonly reconciliationId: string;
  }): ExternalWriterReconciliationReceipt | null {
    const row = this.getDb()
      .prepare(
        `SELECT reconciliation_id, input_sha256, event_id, source_generation,
              feature_revision, event_body_json, committed_at
       FROM external_writer_reconciliation_receipts
       WHERE deployment_id = ? AND reconciliation_id = ?`
      )
      .get(input.deploymentId, input.reconciliationId) as ReceiptRow | undefined;
    return row ? receipt(row) : null;
  }

  commit(input: ExternalWriterReconciliationCommitRequest): {
    readonly outcome: 'committed' | 'idempotent_replay' | 'input_conflict';
    readonly receipt: ExternalWriterReconciliationReceipt | null;
  } {
    const db = this.getDb();
    return db
      .transaction(() => {
        const existing = this.get({
          deploymentId: input.deploymentId,
          reconciliationId: input.receipt.reconciliationId,
        });
        if (existing) {
          return Object.freeze({
            outcome:
              existing.inputSha256 === input.receipt.inputSha256
                ? ('idempotent_replay' as const)
                : ('input_conflict' as const),
            receipt: existing.inputSha256 === input.receipt.inputSha256 ? existing : null,
          });
        }
        const bodyJson = canonicalCoordinationStorageJson(input.event);
        if (
          input.receipt.eventId !== input.event.eventId ||
          (input.receipt.eventBodyJson !== '' && input.receipt.eventBodyJson !== bodyJson) ||
          input.receipt.committedAt !== input.event.emittedAt
        ) {
          throw new Error('external-writer-reconciliation-event-binding-invalid');
        }
        const metadata = ensureEventMetadata(
          db,
          input.deploymentId,
          undefined,
          input.receipt.committedAt
        );
        appendEventJournalRow(
          db,
          input.deploymentId,
          metadata.event_epoch,
          input.event,
          bodyJson,
          null,
          input.receipt.committedAt
        );
        db.prepare(
          `INSERT INTO external_writer_reconciliation_receipts (
           deployment_id, reconciliation_id, input_sha256, event_id, source_generation,
           feature_revision, event_body_json, committed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          input.deploymentId,
          input.receipt.reconciliationId,
          input.receipt.inputSha256,
          input.receipt.eventId,
          input.receipt.sourceGeneration,
          input.receipt.featureRevision,
          bodyJson,
          input.receipt.committedAt
        );
        return Object.freeze({
          outcome: 'committed' as const,
          receipt: Object.freeze({ ...input.receipt, eventBodyJson: bodyJson }),
        });
      })
      .immediate();
  }
}
