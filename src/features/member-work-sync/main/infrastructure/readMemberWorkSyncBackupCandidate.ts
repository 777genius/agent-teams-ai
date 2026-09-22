import { readFile } from 'node:fs/promises';

import { InternalStorageJsonReplica } from '@features/internal-storage/main';

import { isMemberWorkSyncStoreSnapshot, JsonMemberWorkSyncStore } from './JsonMemberWorkSyncStore';
import { validateMemberWorkSyncAuthoritySnapshot } from './memberWorkSyncAuthorityPreparation';
import { mergeDomainSnapshots } from './memberWorkSyncDomainSnapshotMerge';
import { preflightMemberWorkSyncStatusSources } from './memberWorkSyncStatusPreflight';
import { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';
import {
  normalizeTokenSecretTeam,
  parseMemberWorkSyncTokenSecret,
  validateBackupTokenSecret,
} from './memberWorkSyncTokenSecret';

import type { MemberWorkSyncStoreSnapshot } from './JsonMemberWorkSyncStore';

/** Caller holds backup ownership; this reader never repairs or archives source files. */
export async function readMemberWorkSyncBackupCandidate(input: {
  backupTeamsRoot: string;
  teamName: string;
  incarnation: string;
  /** Internal live restore preflight only; backup sources always use strict identity. */
  secretReadPolicy?: 'backup' | 'live-restore';
}): Promise<{
  identity: { teamName: string; incarnation: string };
  history: MemberWorkSyncStoreSnapshot;
  replica: Awaited<
    ReturnType<
      InternalStorageJsonReplica<MemberWorkSyncStoreSnapshot>['readForAuthorityPreparation']
    >
  >;
  secretJson: string | null;
}> {
  const { teamName, incarnation } = input;
  if (
    !teamName.trim() ||
    teamName !== teamName.trim() ||
    /[\\/\0]/.test(teamName) ||
    teamName === '.' ||
    teamName === '..' ||
    !incarnation.trim()
  ) {
    throw new Error('Invalid backup candidate identity');
  }
  const identity = { teamName, incarnation };
  const paths = new MemberWorkSyncStorePaths(input.backupTeamsRoot);
  await preflightMemberWorkSyncStatusSources({ paths, identity });
  const replicaReader = new InternalStorageJsonReplica<MemberWorkSyncStoreSnapshot>(
    (name) => paths.getSqliteFallbackReplicaPath(name),
    isMemberWorkSyncStoreSnapshot
  );
  const replica = await replicaReader.readForAuthorityPreparation(teamName, incarnation);
  const replicaSnapshot =
    replica.state === 'clean'
      ? replica.snapshot
      : replica.state === 'dirty'
        ? replica.candidate
        : null;
  if (replicaSnapshot) validateMemberWorkSyncAuthoritySnapshot(identity, replicaSnapshot);
  const store = new JsonMemberWorkSyncStore(paths, { strictIndexReads: true });
  const active = await store.readSnapshotForImport(teamName);
  const archived = await store.readArchivedSnapshotForImport(teamName);
  for (const snapshot of [active, archived]) {
    if (snapshot) validateMemberWorkSyncAuthoritySnapshot(identity, snapshot);
  }
  const empty: MemberWorkSyncStoreSnapshot = {
    statuses: [],
    reportIntents: [],
    outboxItems: [],
    metricEvents: [],
    filesToArchive: [],
  };
  const history = { ...mergeDomainSnapshots(archived ?? empty, active), filesToArchive: [] };
  // Preserve bytes separately: the secret is not represented by the domain snapshot.
  let secretJson: string | null = null;
  try {
    secretJson = await readFile(paths.getReportTokenSecretPath(teamName), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (secretJson !== null) {
    if (input.secretReadPolicy === 'live-restore') {
      const secret = parseMemberWorkSyncTokenSecret(secretJson);
      if (secret.schemaVersion === 2 && secret.teamName !== normalizeTokenSecretTeam(teamName))
        throw new Error('Report token secret team mismatch');
    } else validateBackupTokenSecret(secretJson, identity);
  }
  const source =
    replica.state === 'clean'
      ? { ...replica, snapshot: { ...replica.snapshot, filesToArchive: [] } }
      : replica.state === 'dirty'
        ? {
            ...replica,
            candidate: replica.candidate ? { ...replica.candidate, filesToArchive: [] } : null,
          }
        : replica;
  return { identity, history, replica: source, secretJson };
}
