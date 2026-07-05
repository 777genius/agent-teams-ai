import {
  getOpenCodeRuntimeRunTombstonesPath,
  readCommittedOpenCodeBootstrapSessionEvidence,
  readOpenCodeRuntimeLaneIndex,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  createRuntimeRunTombstoneStore,
  type RuntimeEvidenceKind,
  type RuntimeRunTombstoneStore,
} from '../opencode/store/RuntimeRunTombstoneStore';

import type { OpenCodeSecondaryEvidenceOverlayPorts } from './TeamProvisioningLaunchStateReconciliation';

const OPENCODE_BOOTSTRAP_CHECKIN_TOMBSTONE_EVIDENCE_KIND =
  'bootstrap_checkin' satisfies RuntimeEvidenceKind;

export interface TeamProvisioningOpenCodeSecondaryEvidenceOverlayPortDependencies {
  getTeamsBasePath(): string;
  nowIso(): string;
  readLaneIndex?: typeof readOpenCodeRuntimeLaneIndex;
  readCommittedBootstrapSessionEvidence?: typeof readCommittedOpenCodeBootstrapSessionEvidence;
  getRuntimeRunTombstonesPath?: typeof getOpenCodeRuntimeRunTombstonesPath;
  createRuntimeRunTombstoneStore?: typeof createRuntimeRunTombstoneStore;
}

export function createTeamProvisioningOpenCodeSecondaryEvidenceOverlayPorts(
  dependencies: TeamProvisioningOpenCodeSecondaryEvidenceOverlayPortDependencies
): OpenCodeSecondaryEvidenceOverlayPorts {
  const readLaneIndexDependency = dependencies.readLaneIndex ?? readOpenCodeRuntimeLaneIndex;
  const readCommittedBootstrapSessionEvidenceDependency =
    dependencies.readCommittedBootstrapSessionEvidence ??
    readCommittedOpenCodeBootstrapSessionEvidence;
  const getRuntimeRunTombstonesPathDependency =
    dependencies.getRuntimeRunTombstonesPath ?? getOpenCodeRuntimeRunTombstonesPath;
  const createRuntimeRunTombstoneStoreDependency =
    dependencies.createRuntimeRunTombstoneStore ?? createRuntimeRunTombstoneStore;

  return {
    readLaneIndex: (teamName) => readLaneIndexDependency(dependencies.getTeamsBasePath(), teamName),
    readCommittedBootstrapSessionEvidence: ({ teamName, laneId }) =>
      readCommittedBootstrapSessionEvidenceDependency({
        teamsBasePath: dependencies.getTeamsBasePath(),
        teamName,
        laneId,
      }),
    hasBootstrapCheckinTombstone: async ({ teamName, laneId, runId }) => {
      const tombstoneStore: RuntimeRunTombstoneStore = createRuntimeRunTombstoneStoreDependency({
        filePath: getRuntimeRunTombstonesPathDependency(
          dependencies.getTeamsBasePath(),
          teamName,
          laneId
        ),
      });
      const tombstone = await tombstoneStore
        .find({
          teamName,
          runId,
          evidenceKind: OPENCODE_BOOTSTRAP_CHECKIN_TOMBSTONE_EVIDENCE_KIND,
        })
        .catch(() => null);
      return Boolean(tombstone);
    },
    nowIso: dependencies.nowIso,
  };
}
