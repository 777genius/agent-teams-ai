import { BackendSelectingMemberWorkSyncReportJournal } from '../infrastructure/BackendSelectingMemberWorkSyncReportJournal';
import { BackendSelectingMemberWorkSyncStore } from '../infrastructure/BackendSelectingMemberWorkSyncStore';
import {
  buildPendingReportIntentId,
  JsonMemberWorkSyncStore,
} from '../infrastructure/JsonMemberWorkSyncStore';
import { createJsonPreparedStatusBackend } from '../infrastructure/memberWorkSyncPreparedStatusBackend';
import { MemberWorkSyncSqliteImporter } from '../infrastructure/MemberWorkSyncSqliteImporter';
import { MemberWorkSyncStatusAuthority } from '../infrastructure/MemberWorkSyncStatusAuthority';
import { SqliteMemberWorkSyncStore } from '../infrastructure/SqliteMemberWorkSyncStore';

import type { MemberWorkSyncLoggerPort } from '../../core/application';
import type { HmacMemberWorkSyncReportTokenAdapter } from '../infrastructure/HmacMemberWorkSyncReportTokenAdapter';
import type { MemberWorkSyncStorePaths } from '../infrastructure/MemberWorkSyncStorePaths';
import type { QuiescingMemberWorkSyncAuditJournal } from '../infrastructure/QuiescingMemberWorkSyncAuditJournal';
import type { InternalStorageMemberWorkSyncBackend } from '@features/internal-storage/main';

export function createMemberWorkSyncPersistence(input: {
  storePaths: MemberWorkSyncStorePaths;
  auditJournal: QuiescingMemberWorkSyncAuditJournal;
  lifecycleIdentity: ConstructorParameters<typeof HmacMemberWorkSyncReportTokenAdapter>[1];
  internalStorageBackend?: InternalStorageMemberWorkSyncBackend | null;
  logger?: MemberWorkSyncLoggerPort;
}) {
  const jsonStore = new JsonMemberWorkSyncStore(input.storePaths, {
    auditJournal: input.auditJournal,
    logger: input.logger,
  });
  const jsonJournal = jsonStore.createReportJournal();
  if (!input.internalStorageBackend) {
    return {
      jsonStore,
      store: jsonStore,
      reportJournal: jsonJournal,
      authority: new MemberWorkSyncStatusAuthority({
        identity: input.lifecycleIdentity,
        withPreparedBackend: (identity, operation) =>
          operation(createJsonPreparedStatusBackend(identity.teamName, jsonStore)),
      }),
    };
  }
  const sqliteStore = new SqliteMemberWorkSyncStore({
    gateway: input.internalStorageBackend.gateway,
    importer: new MemberWorkSyncSqliteImporter({
      gateway: input.internalStorageBackend.gateway,
      jsonStore,
      logger: input.logger,
    }),
    buildReportIntentId: buildPendingReportIntentId,
  });
  const store = new BackendSelectingMemberWorkSyncStore(
    input.internalStorageBackend.selector,
    sqliteStore,
    jsonStore,
    {
      gateway: input.internalStorageBackend.gateway,
      paths: input.storePaths,
      fallbackRequiresReplica: input.internalStorageBackend.fallbackRequiresReplica ?? false,
      logger: input.logger,
    }
  );
  return {
    jsonStore,
    store,
    reportJournal: new BackendSelectingMemberWorkSyncReportJournal(
      input.internalStorageBackend.selector,
      sqliteStore.createReportJournal(),
      jsonJournal,
      store
    ),
    authority: new MemberWorkSyncStatusAuthority({
      identity: input.lifecycleIdentity,
      withPreparedBackend: (identity, operation) => store.withPreparedBackend(identity, operation),
    }),
  };
}
