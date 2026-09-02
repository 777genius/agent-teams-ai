import { getTeamsBasePath as getDefaultTeamsBasePath } from '@main/utils/pathDecoder';

import {
  inspectOpenCodeRuntimeLaneStorage as defaultInspectOpenCodeRuntimeLaneStorage,
  readCommittedOpenCodeBootstrapSessionEvidence as defaultReadCommittedOpenCodeBootstrapSessionEvidence,
  upsertOpenCodeRuntimeLaneIndexEntry as defaultUpsertOpenCodeRuntimeLaneIndexEntry,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import { type GuardCommittedOpenCodeSecondaryLaneEvidencePorts } from './TeamProvisioningLaunchStateReconciliation';
import { findDeliverableOpenCodeRuntimeBootstrapSessionEvidenceInCommittedEvidence } from './TeamProvisioningOpenCodeBootstrapEvidence';

export interface TeamProvisioningOpenCodeSecondaryLaneEvidenceServiceHost {
  commitOpenCodeRuntimeAdapterLaunchSessionEvidence: GuardCommittedOpenCodeSecondaryLaneEvidencePorts['commitOpenCodeRuntimeAdapterLaunchSessionEvidence'];
}

export interface TeamProvisioningOpenCodeSecondaryLaneEvidencePortsFactoryDeps {
  getTeamsBasePath?: () => string;
  inspectOpenCodeRuntimeLaneStorage?: typeof defaultInspectOpenCodeRuntimeLaneStorage;
  upsertOpenCodeRuntimeLaneIndexEntry?: typeof defaultUpsertOpenCodeRuntimeLaneIndexEntry;
  readCommittedBootstrapSessionEvidence?: typeof defaultReadCommittedOpenCodeBootstrapSessionEvidence;
  logWarn: GuardCommittedOpenCodeSecondaryLaneEvidencePorts['logWarn'];
}

export function createTeamProvisioningOpenCodeSecondaryLaneEvidencePortsFromService(
  service: TeamProvisioningOpenCodeSecondaryLaneEvidenceServiceHost,
  deps: TeamProvisioningOpenCodeSecondaryLaneEvidencePortsFactoryDeps
): GuardCommittedOpenCodeSecondaryLaneEvidencePorts {
  const getTeamsBasePath = deps.getTeamsBasePath ?? getDefaultTeamsBasePath;
  const inspectOpenCodeRuntimeLaneStorage =
    deps.inspectOpenCodeRuntimeLaneStorage ?? defaultInspectOpenCodeRuntimeLaneStorage;
  const upsertOpenCodeRuntimeLaneIndexEntry =
    deps.upsertOpenCodeRuntimeLaneIndexEntry ?? defaultUpsertOpenCodeRuntimeLaneIndexEntry;
  const readCommittedBootstrapSessionEvidence =
    deps.readCommittedBootstrapSessionEvidence ??
    defaultReadCommittedOpenCodeBootstrapSessionEvidence;

  return {
    commitOpenCodeRuntimeAdapterLaunchSessionEvidence: (input) =>
      service.commitOpenCodeRuntimeAdapterLaunchSessionEvidence(input),
    inspectOpenCodeRuntimeLaneStorage: ({ teamName, laneId }) =>
      inspectOpenCodeRuntimeLaneStorage({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId,
      }),
    upsertOpenCodeRuntimeLaneIndexEntry: ({ teamName, laneId, state, diagnostics }) =>
      upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId,
        state,
        diagnostics,
      }),
    // Per-member, not per-lane: the lane flag is true as soon as ONE member
    // commits, which is how a committed teammate hid a lead with no record.
    hasCommittedOpenCodeLaneMemberSessionEvidence: async ({
      teamName,
      laneId,
      runId,
      memberName,
    }) =>
      findDeliverableOpenCodeRuntimeBootstrapSessionEvidenceInCommittedEvidence(
        await readCommittedBootstrapSessionEvidence({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId,
        }),
        { teamName, laneId, runId, memberName }
      ) != null,
    logWarn: (message) => deps.logWarn(message),
  };
}
