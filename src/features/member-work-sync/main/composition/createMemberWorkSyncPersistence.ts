import { AsyncLocalStorage } from 'node:async_hooks';

import { MemberWorkSyncTeamQuiescedError } from '../../core/application';
import { BackendSelectingMemberWorkSyncReportJournal } from '../infrastructure/BackendSelectingMemberWorkSyncReportJournal';
import { BackendSelectingMemberWorkSyncStore } from '../infrastructure/BackendSelectingMemberWorkSyncStore';
import { internalStorageInterruption } from '../infrastructure/internalStorageInterruption';
import { createAlwaysCurrentJsonMemberWorkSyncPurgeLifecycle } from '../infrastructure/JsonMemberWorkSyncActiveStatePurger';
import {
  buildPendingReportIntentId,
  JsonMemberWorkSyncStore,
} from '../infrastructure/JsonMemberWorkSyncStore';
import { createJsonPreparedStatusBackend } from '../infrastructure/memberWorkSyncPreparedStatusBackend';
import { MemberWorkSyncSqliteImporter } from '../infrastructure/MemberWorkSyncSqliteImporter';
import { MemberWorkSyncStatusAuthority } from '../infrastructure/MemberWorkSyncStatusAuthority';
import { SqliteMemberWorkSyncStore } from '../infrastructure/SqliteMemberWorkSyncStore';

import { createMemberWorkSyncRestoreParticipant } from './createMemberWorkSyncRestoreParticipant';

import type { MemberWorkSyncLoggerPort } from '../../core/application';
import type { HmacMemberWorkSyncReportTokenAdapter } from '../infrastructure/HmacMemberWorkSyncReportTokenAdapter';
import type { MemberWorkSyncStorePaths } from '../infrastructure/MemberWorkSyncStorePaths';
import type { QuiescingMemberWorkSyncAuditJournal } from '../infrastructure/QuiescingMemberWorkSyncAuditJournal';
import type { LegacySourceWriteAdmissionPolicy } from '@agent-teams/legacy-agent-host/lifecycle';
import type { InternalStorageMemberWorkSyncBackend } from '@features/internal-storage/main';

export function createMemberWorkSyncPersistence(input: {
  sourceWriteAdmission?: LegacySourceWriteAdmissionPolicy;
  storePaths: MemberWorkSyncStorePaths;
  auditJournal: QuiescingMemberWorkSyncAuditJournal;
  lifecycleIdentity: ConstructorParameters<typeof HmacMemberWorkSyncReportTokenAdapter>[1];
  internalStorageBackend?: InternalStorageMemberWorkSyncBackend | null;
  logger?: MemberWorkSyncLoggerPort;
}) {
  // Only the existing restore/purge owners receive these finite callbacks. This is
  // local storage access, never an ordinary admission or a facade capability.
  const lifecycle = new AsyncLocalStorage<{
    teamName: string;
    active: boolean;
    assertOwnerCurrent?: () => void;
  }>();
  const sourcePublication = input.sourceWriteAdmission
    ? {
        current(teamName: string) {
          const owner = lifecycle.getStore();
          if (!owner) return input.sourceWriteAdmission!.current(teamName);
          if (!owner.active || owner.teamName !== teamName)
            throw new Error('Lifecycle storage owner expired or differs');
          owner.assertOwnerCurrent?.();
          return undefined;
        },
      }
    : undefined;
  const underOwner = async <T>(
    teamName: string,
    assertOwnerCurrent: (() => void) | undefined,
    operation: () => Promise<T>
  ): Promise<T> => {
    assertOwnerCurrent?.();
    const inherited = lifecycle.getStore();
    if (inherited) throw new Error('Lifecycle storage entry cannot be nested');
    const owner = { teamName, active: true, assertOwnerCurrent };
    let retiring = false;
    try {
      return await lifecycle.run(owner, operation);
    } catch (error) {
      const interrupted = internalStorageInterruption(error);
      if (interrupted) {
        retiring = true;
        void Promise.allSettled([interrupted.settled]).then(() => {
          owner.active = false;
        });
      }
      throw error;
    } finally {
      if (!retiring) owner.active = false;
    }
  };
  const withLifecycleOwners = <
    T extends {
      store: JsonMemberWorkSyncStore | BackendSelectingMemberWorkSyncStore;
      jsonStore: JsonMemberWorkSyncStore;
    },
  >(
    persistence: T
  ) => {
    const capturePurgeTeam = (teamName: string, identityId?: string) => {
      const original = input.sourceWriteAdmission?.capture(teamName);
      return () =>
        underOwner(teamName, original?.assertOwnerCurrent, () =>
          persistence.store instanceof BackendSelectingMemberWorkSyncStore
            ? persistence.store.purgeTeam(teamName, identityId)
            : persistence.jsonStore.purgeActiveState(
                teamName,
                createAlwaysCurrentJsonMemberWorkSyncPurgeLifecycle()
              )
        );
    };
    return {
      ...persistence,
      capturePurgeTeam,
      purgeTeam: (teamName: string, identityId?: string) =>
        capturePurgeTeam(teamName, identityId)(),
      restoreParticipant(tokens: HmacMemberWorkSyncReportTokenAdapter) {
        const actual = createMemberWorkSyncRestoreParticipant(
          persistence.store,
          tokens,
          input.storePaths
        );
        return {
          async prepare(request: Parameters<typeof actual.prepare>[0]) {
            const captured = { ...request };
            const original = input.sourceWriteAdmission?.capture(captured.teamName);
            if (original?.kind === 'read-only')
              throw new MemberWorkSyncTeamQuiescedError(captured.teamName);
            const read = () => actual.prepare(captured);
            const prepared = await (original ? original.run(read) : read());
            return {
              importAndVerify: () =>
                underOwner(captured.teamName, original?.assertOwnerCurrent, () =>
                  prepared.importAndVerify()
                ),
            };
          },
        };
      },
    };
  };
  const jsonStore = new JsonMemberWorkSyncStore(input.storePaths, {
    auditJournal: input.auditJournal,
    sourceWriteAdmission: sourcePublication,
    logger: input.logger,
  });
  const jsonJournal = jsonStore.createReportJournal();
  if (!input.internalStorageBackend) {
    return withLifecycleOwners({
      jsonStore,
      store: jsonStore,
      reportJournal: jsonJournal,
      authority: new MemberWorkSyncStatusAuthority({
        interruption: internalStorageInterruption,
        identity: input.lifecycleIdentity,
        withPreparedBackend: (identity, operation) =>
          operation(createJsonPreparedStatusBackend(identity.teamName, jsonStore)),
      }),
    });
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
      sourceWriteAdmission: sourcePublication,
      gateway: input.internalStorageBackend.gateway,
      paths: input.storePaths,
      fallbackRequiresReplica: input.internalStorageBackend.fallbackRequiresReplica ?? false,
      logger: input.logger,
    }
  );
  return withLifecycleOwners({
    jsonStore,
    store,
    reportJournal: new BackendSelectingMemberWorkSyncReportJournal(
      input.internalStorageBackend.selector,
      sqliteStore.createReportJournal(),
      jsonJournal,
      store
    ),
    authority: new MemberWorkSyncStatusAuthority({
      interruption: internalStorageInterruption,
      identity: input.lifecycleIdentity,
      withPreparedBackend: (identity, operation) => store.withPreparedBackend(identity, operation),
    }),
  });
}
