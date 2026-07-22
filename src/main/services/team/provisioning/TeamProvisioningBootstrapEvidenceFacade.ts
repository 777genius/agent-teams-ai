import { getTeamsBasePath as getDefaultTeamsBasePath } from '@main/utils/pathDecoder';

import {
  applyBootstrapTranscriptEvidenceOverlay as applyBootstrapTranscriptEvidenceOverlayHelper,
  applyProcessBootstrapTransportOverlay as applyProcessBootstrapTransportOverlayHelper,
  type BootstrapRuntimeMemberLike,
  type BootstrapTranscriptOutcome,
  findBootstrapRuntimeProofObservedAt as findBootstrapRuntimeProofObservedAtHelper,
  type ParsedBootstrapTranscriptTailCacheEntry,
} from './TeamProvisioningBootstrapTranscript';
import {
  type TeamProvisioningBootstrapTranscriptFacade,
  type TeamProvisioningBootstrapTranscriptMemberLogsPort,
} from './TeamProvisioningBootstrapTranscriptFacade';
import { getPersistedLaunchMemberNames } from './TeamProvisioningLaunchStateProjection';
import {
  applyOpenCodeSecondaryEvidenceOverlay as applyOpenCodeSecondaryEvidenceOverlayHelper,
  type OpenCodeSecondaryEvidenceOverlayParams,
  type OpenCodeSecondaryEvidenceOverlayPorts,
} from './TeamProvisioningLaunchStateReconciliation';
import {
  createDefaultOpenCodeRuntimeBootstrapEvidencePorts,
  type OpenCodeRuntimeBootstrapEvidencePorts,
} from './TeamProvisioningOpenCodeBootstrapEvidence';
import { createTeamProvisioningOpenCodeSecondaryEvidenceOverlayPorts } from './TeamProvisioningOpenCodeSecondaryEvidenceOverlayPortsFactory';
import { mergeRuntimeDiagnostics } from './TeamProvisioningRuntimeMetadata';

import type { PersistedTeamLaunchMemberState, PersistedTeamLaunchSnapshot } from '@shared/types';

type BootstrapRuntimeProofMember = Pick<
  PersistedTeamLaunchMemberState,
  'firstSpawnAcceptedAt' | 'launchState' | 'hardFailureReason'
>;

export type TeamProvisioningProcessBootstrapTransportOverlayInput = Omit<
  Parameters<typeof applyProcessBootstrapTransportOverlayHelper>[0],
  'nowIso' | 'mergeRuntimeDiagnostics'
>;

export interface TeamProvisioningBootstrapEvidenceFacadeDeps {
  bootstrapTranscriptFacade: TeamProvisioningBootstrapTranscriptFacade;
  readPersistedRuntimeMembers(teamName: string): readonly BootstrapRuntimeMemberLike[];
  getTeamsBasePath?: () => string;
  nowIso(): string;
  warn(message: string): void;
  openCodeSecondaryEvidenceOverlayPorts?: OpenCodeSecondaryEvidenceOverlayPorts;
  createOpenCodeRuntimeBootstrapEvidencePorts?: (input: {
    teamsBasePath: string;
    warn(message: string): void;
  }) => OpenCodeRuntimeBootstrapEvidencePorts;
}

export interface TeamProvisioningBootstrapEvidenceFacadeServiceHost {
  bootstrapTranscriptFacade: TeamProvisioningBootstrapTranscriptFacade;
  readPersistedRuntimeMembers(teamName: string): readonly BootstrapRuntimeMemberLike[];
}

export interface TeamProvisioningBootstrapEvidenceFacadeServiceHostOptions {
  getTeamsBasePath?: () => string;
  nowIso(): string;
  warn(message: string): void;
}

export function createTeamProvisioningBootstrapEvidenceFacadeDepsFromService(
  service: TeamProvisioningBootstrapEvidenceFacadeServiceHost,
  options: TeamProvisioningBootstrapEvidenceFacadeServiceHostOptions
): TeamProvisioningBootstrapEvidenceFacadeDeps {
  return {
    bootstrapTranscriptFacade: service.bootstrapTranscriptFacade,
    readPersistedRuntimeMembers: (teamName) => service.readPersistedRuntimeMembers(teamName),
    getTeamsBasePath: options.getTeamsBasePath,
    nowIso: options.nowIso,
    warn: options.warn,
  };
}

export function createTeamProvisioningBootstrapEvidenceFacadeFromService(
  service: TeamProvisioningBootstrapEvidenceFacadeServiceHost,
  options: TeamProvisioningBootstrapEvidenceFacadeServiceHostOptions
): TeamProvisioningBootstrapEvidenceFacade {
  return new TeamProvisioningBootstrapEvidenceFacade(
    createTeamProvisioningBootstrapEvidenceFacadeDepsFromService(service, options)
  );
}

export class TeamProvisioningBootstrapEvidenceFacade {
  private readonly getTeamsBasePath: () => string;
  private readonly openCodeSecondaryEvidenceOverlayPorts: OpenCodeSecondaryEvidenceOverlayPorts;
  private readonly createOpenCodeRuntimeBootstrapEvidencePortsForInput: NonNullable<
    TeamProvisioningBootstrapEvidenceFacadeDeps['createOpenCodeRuntimeBootstrapEvidencePorts']
  >;

  constructor(private readonly deps: TeamProvisioningBootstrapEvidenceFacadeDeps) {
    this.getTeamsBasePath = deps.getTeamsBasePath ?? getDefaultTeamsBasePath;
    this.openCodeSecondaryEvidenceOverlayPorts =
      deps.openCodeSecondaryEvidenceOverlayPorts ??
      createTeamProvisioningOpenCodeSecondaryEvidenceOverlayPorts({
        getTeamsBasePath: this.getTeamsBasePath,
        nowIso: deps.nowIso,
      });
    this.createOpenCodeRuntimeBootstrapEvidencePortsForInput =
      deps.createOpenCodeRuntimeBootstrapEvidencePorts ??
      createDefaultOpenCodeRuntimeBootstrapEvidencePorts;
  }

  get parsedBootstrapTranscriptTailCache(): Map<string, ParsedBootstrapTranscriptTailCacheEntry> {
    return this.deps.bootstrapTranscriptFacade.parsedBootstrapTranscriptTailCache;
  }

  get memberLogsFinder(): TeamProvisioningBootstrapTranscriptMemberLogsPort {
    return this.deps.bootstrapTranscriptFacade.getMemberLogsFinderForCompatibility();
  }

  set memberLogsFinder(memberLogsFinder: TeamProvisioningBootstrapTranscriptMemberLogsPort) {
    this.deps.bootstrapTranscriptFacade.setMemberLogsFinderForCompatibility(memberLogsFinder);
  }

  createOpenCodeRuntimeBootstrapEvidencePorts(): OpenCodeRuntimeBootstrapEvidencePorts {
    return this.createOpenCodeRuntimeBootstrapEvidencePortsForInput({
      teamsBasePath: this.getTeamsBasePath(),
      warn: (message) => this.deps.warn(message),
    });
  }

  applyOpenCodeSecondaryEvidenceOverlay(
    params: OpenCodeSecondaryEvidenceOverlayParams
  ): Promise<PersistedTeamLaunchSnapshot> {
    return applyOpenCodeSecondaryEvidenceOverlayHelper(
      params,
      this.openCodeSecondaryEvidenceOverlayPorts
    );
  }

  findBootstrapRuntimeProofObservedAt(
    teamName: string,
    memberName: string,
    member: BootstrapRuntimeProofMember
  ): Promise<string | null> {
    return findBootstrapRuntimeProofObservedAtHelper({
      teamsBasePath: this.getTeamsBasePath(),
      teamName,
      memberName,
      member,
      runtimeMembers: this.deps.readPersistedRuntimeMembers(teamName),
    });
  }

  findBootstrapTranscriptFailureReason(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<string | null> {
    return this.deps.bootstrapTranscriptFacade.findBootstrapTranscriptFailureReason(
      teamName,
      memberName,
      sinceMs
    );
  }

  findBootstrapTranscriptOutcome(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome | null> {
    return this.deps.bootstrapTranscriptFacade.findBootstrapTranscriptOutcome(
      teamName,
      memberName,
      sinceMs
    );
  }

  readRecentBootstrapTranscriptOutcome(
    filePath: string,
    sinceMs: number | null,
    memberName: string,
    teamName: string,
    options: {
      allowAnonymousFailure?: boolean;
      contextMemberNames?: readonly string[];
    } = {}
  ): Promise<BootstrapTranscriptOutcome | null> {
    return this.deps.bootstrapTranscriptFacade.readRecentBootstrapTranscriptOutcome(
      filePath,
      sinceMs,
      memberName,
      teamName,
      options
    );
  }

  readBootstrapTranscriptOutcomesInProjectRoot(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome[]> {
    return this.deps.bootstrapTranscriptFacade.readBootstrapTranscriptOutcomesInProjectRoot(
      teamName,
      memberName,
      sinceMs
    );
  }

  applyProcessBootstrapTransportOverlay(
    input: TeamProvisioningProcessBootstrapTransportOverlayInput
  ): ReturnType<typeof applyProcessBootstrapTransportOverlayHelper> {
    return applyProcessBootstrapTransportOverlayHelper({
      ...input,
      nowIso: this.deps.nowIso,
      mergeRuntimeDiagnostics,
    });
  }

  applyBootstrapTranscriptEvidenceOverlay(
    snapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return applyBootstrapTranscriptEvidenceOverlayHelper({
      snapshot,
      expectedMembers: snapshot ? getPersistedLaunchMemberNames(snapshot) : [],
      findBootstrapRuntimeProofObservedAt: (teamName, memberName, member) =>
        this.findBootstrapRuntimeProofObservedAt(teamName, memberName, member),
      findBootstrapTranscriptOutcome: (teamName, memberName, sinceMs) =>
        this.findBootstrapTranscriptOutcome(teamName, memberName, sinceMs),
      nowIso: this.deps.nowIso,
    });
  }
}
