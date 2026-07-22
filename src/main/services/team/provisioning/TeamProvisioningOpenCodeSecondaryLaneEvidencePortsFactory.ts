import { getTeamsBasePath as getDefaultTeamsBasePath } from '@main/utils/pathDecoder';

import {
  inspectOpenCodeRuntimeLaneStorage as defaultInspectOpenCodeRuntimeLaneStorage,
  upsertOpenCodeRuntimeLaneIndexEntry as defaultUpsertOpenCodeRuntimeLaneIndexEntry,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import { type GuardCommittedOpenCodeSecondaryLaneEvidencePorts } from './TeamProvisioningLaunchStateReconciliation';

export interface TeamProvisioningOpenCodeSecondaryLaneEvidenceServiceHost {
  commitOpenCodeRuntimeAdapterLaunchSessionEvidence: GuardCommittedOpenCodeSecondaryLaneEvidencePorts['commitOpenCodeRuntimeAdapterLaunchSessionEvidence'];
}

export interface TeamProvisioningOpenCodeSecondaryLaneEvidencePortsFactoryDeps {
  getTeamsBasePath?: () => string;
  inspectOpenCodeRuntimeLaneStorage?: typeof defaultInspectOpenCodeRuntimeLaneStorage;
  upsertOpenCodeRuntimeLaneIndexEntry?: typeof defaultUpsertOpenCodeRuntimeLaneIndexEntry;
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
    logWarn: (message) => deps.logWarn(message),
  };
}
