export const EXTERNAL_WRITER_RECONCILIATION_MIGRATION_STATEMENTS = Object.freeze([
  `CREATE TABLE external_writer_reconciliation_receipts (
    deployment_id TEXT NOT NULL,
    reconciliation_id TEXT NOT NULL,
    input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
    event_id TEXT NOT NULL UNIQUE,
    source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
    feature_revision INTEGER NOT NULL CHECK (feature_revision >= 0),
    event_body_json TEXT NOT NULL CHECK (json_valid(event_body_json)),
    committed_at TEXT NOT NULL,
    PRIMARY KEY (deployment_id, reconciliation_id)
  )`,
  `CREATE TRIGGER external_writer_reconciliation_no_update
   BEFORE UPDATE ON external_writer_reconciliation_receipts
   BEGIN SELECT RAISE(ABORT, 'external-writer-reconciliation-receipt-immutable'); END`,
  `CREATE TRIGGER external_writer_reconciliation_no_delete
   BEFORE DELETE ON external_writer_reconciliation_receipts
   BEGIN SELECT RAISE(ABORT, 'external-writer-reconciliation-receipt-immutable'); END`,
]);

export const EXTERNAL_WRITER_RECONCILIATION_MIGRATION = Object.freeze({
  version: 27,
  statements: [...EXTERNAL_WRITER_RECONCILIATION_MIGRATION_STATEMENTS],
});
