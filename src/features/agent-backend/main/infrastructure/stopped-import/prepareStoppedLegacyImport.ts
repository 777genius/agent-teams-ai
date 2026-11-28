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
  StoppedImportPrepareBoundary,
  StoppedImportPrepareObservation,
} from './createStoppedImportDiagnostic';
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
  observation?: StoppedImportPrepareObservation;
}): Promise<StoppedTeamImportRequest> {
  let boundary: StoppedImportPrepareBoundary = 'capture-inputs';
  let firstRefusal: StoppedImportPrepareBoundary | undefined;
  const mark = (next: StoppedImportPrepareBoundary): void => {
    boundary = next;
    try {
      if (options.observation) options.observation.boundary = next;
    } catch {
      // A frozen/private diagnostic slot cannot change the original operation.
    }
  };
  mark('capture-inputs');
  const source = { ...options.source, roots: structuredClone(options.source.roots) },
    target = { ...options.target, contextIds: [...options.target.contextIds] },
    teamName = options.destinationTeamName;
  mark('initial-source-guard');
  if (!source.isCurrent() || !target.contextIds.includes(source.contextId))
    throw new LegacyStoppedImportHold('source-changed');
  mark('initial-target-guard');
  target.assertCurrent();
  mark('source-construction');
  const original = createLegacyStoppedTeamSource(source, options.owners);
  let sourceHold: LegacyStoppedImportHold | undefined;
  const remember = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      const value = await read();
      mark('snapshot-export');
      return value;
    } catch (error) {
      firstRefusal ??= boundary;
      if (error instanceof LegacyStoppedImportHold) sourceHold = error;
      throw error;
    }
  };
  mark('snapshot-export');
  const snapshot = await exportStoppedTeam({
    ...original,
    describe: () => {
      mark('source-describe');
      return remember(() => original.describe());
    },
    fenced: (read) => {
      mark('source-fence-before-callback');
      return remember(() =>
        original.fenced(() => {
          mark('snapshot-export');
          return read();
        })
      );
    },
  }).catch((error) => {
    mark(firstRefusal ?? boundary);
    throw sourceHold ?? error;
  });
  mark('final-source-guard');
  if (!source.isCurrent()) throw new LegacyStoppedImportHold('source-changed');
  mark('final-target-guard');
  target.assertCurrent();
  const request = {
    contextId: source.contextId,
    sourceId: source.sourceId,
    snapshotDigest: snapshot.digest,
    teamName,
  };
  mark('snapshot-staging');
  new FileStoppedSnapshotResolver(target).stage(request, snapshot);
  return request;
}
