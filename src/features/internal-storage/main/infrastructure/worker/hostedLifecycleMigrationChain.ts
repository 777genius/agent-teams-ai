import {
  HOSTED_LIFECYCLE_CURRENT_AUTHORITY_MIGRATION,
  runHostedLifecycleCurrentAuthorityMigrationAdmission,
} from './hostedLifecycleCurrentAuthorityMigration';
import {
  HOSTED_LIFECYCLE_RUN_ALIAS_MIGRATION,
  runHostedLifecycleRunAliasMigrationAdmission,
} from './hostedLifecycleRunAliasMigration';
import {
  HOSTED_LIFECYCLE_RUN_RESERVATION_MIGRATION,
  runHostedLifecycleRunReservationMigrationAdmission,
} from './hostedLifecycleRunReservationMigration';
import {
  HOSTED_PROMOTION_ROSTER_BINDING_MIGRATION,
  runHostedPromotionRosterBindingMigrationAdmission,
} from './hostedPromotionRosterBindingMigration';

import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;

export const HOSTED_LIFECYCLE_MIGRATIONS = [
  HOSTED_PROMOTION_ROSTER_BINDING_MIGRATION,
  HOSTED_LIFECYCLE_RUN_RESERVATION_MIGRATION,
  HOSTED_LIFECYCLE_RUN_ALIAS_MIGRATION,
  HOSTED_LIFECYCLE_CURRENT_AUTHORITY_MIGRATION,
] as const;

/** Admit every retained exact schema prefix before any later migration writes. */
export function admitRetainedHostedLifecycleSchema(db: Database, current: number): void {
  if (current >= 32)
    db.transaction(() => runHostedPromotionRosterBindingMigrationAdmission(db, true))();
  if (current >= 33)
    db.transaction(() => runHostedLifecycleRunReservationMigrationAdmission(db, true))();
  if (current >= 34) db.transaction(() => runHostedLifecycleRunAliasMigrationAdmission(db, true))();
  if (current >= 35)
    db.transaction(() => runHostedLifecycleCurrentAuthorityMigrationAdmission(db, true))();
}

/** The first admission creates the canonical objects; replay requires their exact shape. */
export function applyHostedLifecycleMigration(db: Database, version: number): boolean {
  switch (version) {
    case 32:
      runHostedPromotionRosterBindingMigrationAdmission(db);
      return true;
    case 33:
      runHostedLifecycleRunReservationMigrationAdmission(db);
      return true;
    case 34:
      runHostedLifecycleRunAliasMigrationAdmission(db);
      return true;
    case 35:
      runHostedLifecycleCurrentAuthorityMigrationAdmission(db);
      return true;
    default:
      return false;
  }
}
