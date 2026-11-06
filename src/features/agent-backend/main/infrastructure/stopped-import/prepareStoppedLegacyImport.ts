import {
  exportStoppedTeam,
  FileStoppedSnapshotResolver,
} from '@agent-teams/legacy-agent-host/stopped-team-import';

import {
  createLegacyStoppedTeamSource,
  LegacyStoppedImportHold,
} from './createLegacyStoppedTeamSource';

import type {
  CapturedLegacyStoppedSource,
  LegacyStoppedSourceOwners,
} from './createLegacyStoppedTeamSource';
import type {
  StoppedSnapshotAuthority,
  StoppedTeamImportRequest,
} from '@agent-teams/legacy-agent-host/stopped-team-import';

/** Shell supplies the captured source/target. No source or destination path is accepted from IPC. */
export async function prepareStoppedLegacyImport(options: {
  source: CapturedLegacyStoppedSource;
  owners: LegacyStoppedSourceOwners;
  target: StoppedSnapshotAuthority;
  destinationTeamName: string;
}): Promise<StoppedTeamImportRequest> {
  const source = { ...options.source, roots: structuredClone(options.source.roots) },
    target = { ...options.target, contextIds: [...options.target.contextIds] },
    teamName = options.destinationTeamName;
  if (!source.isCurrent() || !target.contextIds.includes(source.contextId))
    throw new LegacyStoppedImportHold('source-changed');
  target.assertCurrent();
  const original = createLegacyStoppedTeamSource(source, options.owners);
  let sourceHold: LegacyStoppedImportHold | undefined;
  const remember = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof LegacyStoppedImportHold) sourceHold = error;
      throw error;
    }
  };
  const snapshot = await exportStoppedTeam({
    ...original,
    describe: () => remember(() => original.describe()),
    fenced: (read) => remember(() => original.fenced(read)),
  }).catch((error) => {
    throw sourceHold ?? error;
  });
  if (!source.isCurrent()) throw new LegacyStoppedImportHold('source-changed');
  target.assertCurrent();
  const request = {
    contextId: source.contextId,
    sourceId: source.sourceId,
    snapshotDigest: snapshot.digest,
    teamName,
  };
  new FileStoppedSnapshotResolver(target).stage(request, snapshot);
  return request;
}
