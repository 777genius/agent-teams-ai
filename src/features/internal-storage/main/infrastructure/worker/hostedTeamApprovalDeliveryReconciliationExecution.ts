import { HOSTED_TEAM_APPROVAL_DELIVERY_RECONCILIATION_STORAGE_MIGRATION_STATEMENTS } from './hostedTeamApprovalDeliveryReconciliationStorageMigration';

import type DatabaseConstructor from 'better-sqlite3';

export function executeHostedTeamApprovalDeliveryReconciliation(
  db: InstanceType<typeof DatabaseConstructor>
): void {
  // DROP main.outbox also deletes its attached TEMP triggers. Check the owner,
  // not reserved trigger names, before creating or copying either rebuild table.
  // TEMP metadata has no owner-schema column: same-name TEMP-owned triggers are
  // conservatively unsupported too; ordinary TEMP table/index shadows remain valid.
  if (
    db.prepare(`SELECT 1 FROM temp.sqlite_schema WHERE type = 'trigger'
      AND tbl_name = 'hosted_team_approval_delivery_outbox' COLLATE NOCASE LIMIT 1`).get()
  ) {
    throw new Error('internal-storage-v24-approval-temp-trigger');
  }
  // Adapt only the retained v24 statements at execution time. Both the rebuild
  // table and the old outbox may be shadowed, so qualify DDL, INSERT and SELECT.
  // SQLite derives the INDEX owner and FK parent schema from the qualified
  // object; those identifiers must remain unqualified.
  for (const statement of HOSTED_TEAM_APPROVAL_DELIVERY_RECONCILIATION_STORAGE_MIGRATION_STATEMENTS) {
    if (statement.startsWith('ALTER TABLE hosted_team_approval_delivery_outbox_v24')) {
      // RENAME reparses unrelated main indexes with TEMP-first table lookup.
      // A legitimate TEMP parent shadow can therefore invalidate that parse.
      // Materialize the final table from the same retained definition instead;
      // the surrounding migration transaction keeps both copies atomic.
      // Retained RENAME stores the final identifier quoted in sqlite_schema.
      db.exec(
        HOSTED_TEAM_APPROVAL_DELIVERY_RECONCILIATION_STORAGE_MIGRATION_STATEMENTS[0].replace(
          'CREATE TABLE hosted_team_approval_delivery_outbox_v24',
          'CREATE TABLE main."hosted_team_approval_delivery_outbox"'
        )
      );
      db.exec(`INSERT INTO main.hosted_team_approval_delivery_outbox
        SELECT * FROM main.hosted_team_approval_delivery_outbox_v24`);
      db.exec('DROP TABLE main.hosted_team_approval_delivery_outbox_v24');
      continue;
    }
    db.exec(
      statement
        .replace(/^(CREATE TABLE|INSERT INTO|DROP TABLE|CREATE INDEX) /, '$1 main.')
        .replace(
          /(\sFROM )hosted_team_approval_delivery_outbox$/,
          '$1main.hosted_team_approval_delivery_outbox'
        )
    );
  }
}
