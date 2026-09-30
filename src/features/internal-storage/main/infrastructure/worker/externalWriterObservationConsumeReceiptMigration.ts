export const EXTERNAL_WRITER_OBSERVATION_CONSUME_RECEIPT_MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS external_writer_observation_consume_receipts (
    deployment_id TEXT NOT NULL,
    observer_id TEXT NOT NULL,
    consume_attempt_id TEXT NOT NULL CHECK (
      length(consume_attempt_id) BETWEEN 1 AND 128
      AND consume_attempt_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
    result_revision INTEGER NOT NULL CHECK (result_revision > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version = 2),
    checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
    checkpoint_sha256 TEXT NOT NULL CHECK (
      length(checkpoint_sha256) = 64
      AND checkpoint_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (deployment_id, observer_id)
  )`,
] as const;

export const EXTERNAL_WRITER_OBSERVATION_CONSUME_RECEIPT_MIGRATION = Object.freeze({
  version: 26,
  statements: [...EXTERNAL_WRITER_OBSERVATION_CONSUME_RECEIPT_MIGRATION_STATEMENTS],
});
