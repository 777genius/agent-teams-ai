import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isMeaningfulBootstrapCheckInMessage } from '@shared/utils/inboxNoise';
import * as fs from 'fs';
import * as path from 'path';

import {
  choosePreferredLaunchSnapshot,
  readBootstrapLaunchSnapshot,
} from '../TeamBootstrapStateReader';

import {
  applyBootstrapTranscriptEvidenceOverlay,
  applyProcessBootstrapTransportOverlay,
  type BootstrapRuntimeMemberLike,
  cleanConfirmedBootstrapRuntimeDiagnostics,
  hasBootstrapTranscriptLaunchReconcileOutcome,
  needsBootstrapAcceptanceReconcile,
  needsConfirmedBootstrapDiagnosticReconcile,
  readLeadInboxMessagesForLaunchReconcile,
  readProcessBootstrapTransportSummary,
} from './TeamProvisioningBootstrapTranscript';
import {
  createDefaultLaunchReconcileConfigMembers,
  parseLaunchReconcileConfigMembers,
  type ReconcilePersistedLaunchMemberPorts,
} from './TeamProvisioningLaunchReconcileReporting';
import { getPersistedLaunchMemberNames } from './TeamProvisioningLaunchStateProjection';
import {
  hasMixedSecondaryLaunchReconcileHeartbeat,
  selectLatestMixedSecondaryLaunchReconcileMessage,
} from './TeamProvisioningMixedSecondaryLaunchReconciliation';
import {
  type PersistedLaunchReconciliationResult,
  type ReconcilePersistedLaunchStatePorts,
  reconcilePersistedLaunchStateWithPorts,
} from './TeamProvisioningPersistedLaunchReconciliation';
import { mergeRuntimeDiagnostics } from './TeamProvisioningRuntimeMetadata';

import type { PersistedTeamLaunchSnapshot, TeamMember } from '@shared/types';

const TEAM_JSON_READ_TIMEOUT_MS = 5_000;
const TEAM_CONFIG_MAX_BYTES = 10 * 1024 * 1024;
const TEAM_INBOX_MAX_BYTES = 2 * 1024 * 1024;

export interface TeamProvisioningPersistedLaunchReconcilePortsInput extends Pick<
  ReconcilePersistedLaunchStatePorts,
  | 'recoverStaleMixedSecondaryLaunchSnapshot'
  | 'applyOpenCodeSecondaryEvidenceOverlay'
  | 'applyOpenCodeSecondaryBootstrapStallOverlay'
  | 'writeLaunchStateSnapshot'
  | 'clearPersistedLaunchState'
  | 'getLiveTeamAgentRuntimeMetadata'
> {
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  readMembersMeta(teamName: string): Promise<readonly TeamMember[]>;
  readPersistedRuntimeMembers(teamName: string): readonly BootstrapRuntimeMemberLike[];
  resolveExpectedLaunchMemberName(
    expectedMembers: readonly string[] | undefined,
    candidateName: string
  ): string | null;
  findBootstrapRuntimeProofObservedAt: ReconcilePersistedLaunchMemberPorts['findBootstrapRuntimeProofObservedAt'];
  findBootstrapTranscriptOutcome: ReconcilePersistedLaunchMemberPorts['findBootstrapTranscriptOutcome'];
}

function nowIso(): string {
  return new Date().toISOString();
}

async function tryReadRegularFileUtf8(
  filePath: string,
  opts: { timeoutMs: number; maxBytes: number }
): Promise<string | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }

  if (!stat.isFile() || stat.size > opts.maxBytes) {
    return null;
  }

  try {
    return await readFileUtf8WithTimeout(filePath, opts.timeoutMs);
  } catch (error) {
    if (error instanceof FileReadTimeoutError) {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

export function createTeamProvisioningPersistedLaunchReconcilePorts(
  input: TeamProvisioningPersistedLaunchReconcilePortsInput
): ReconcilePersistedLaunchStatePorts {
  return {
    readBootstrapLaunchSnapshot,
    readLaunchState: input.readLaunchState,
    readMembersMeta: input.readMembersMeta,
    recoverStaleMixedSecondaryLaunchSnapshot: input.recoverStaleMixedSecondaryLaunchSnapshot,
    applyOpenCodeSecondaryEvidenceOverlay: input.applyOpenCodeSecondaryEvidenceOverlay,
    applyOpenCodeSecondaryBootstrapStallOverlay: input.applyOpenCodeSecondaryBootstrapStallOverlay,
    writeLaunchStateSnapshot: input.writeLaunchStateSnapshot,
    clearPersistedLaunchState: input.clearPersistedLaunchState,
    applyBootstrapTranscriptEvidenceOverlay: (snapshot) =>
      applyBootstrapTranscriptEvidenceOverlay({
        snapshot,
        expectedMembers: snapshot ? getPersistedLaunchMemberNames(snapshot) : [],
        findBootstrapRuntimeProofObservedAt: (teamName, memberName, member) =>
          input.findBootstrapRuntimeProofObservedAt(teamName, memberName, member),
        findBootstrapTranscriptOutcome: (teamName, memberName, sinceMs) =>
          input.findBootstrapTranscriptOutcome(teamName, memberName, sinceMs),
        nowIso,
      }),
    needsBootstrapAcceptanceReconcile: (snapshot, bootstrapSnapshot) =>
      needsBootstrapAcceptanceReconcile({
        snapshot,
        bootstrapSnapshot,
        expectedMembers: getPersistedLaunchMemberNames(snapshot),
      }),
    needsConfirmedBootstrapDiagnosticReconcile: needsConfirmedBootstrapDiagnosticReconcile,
    cleanConfirmedBootstrapRuntimeDiagnostics: (snapshot) =>
      cleanConfirmedBootstrapRuntimeDiagnostics({
        snapshot,
        expectedMembers: snapshot ? getPersistedLaunchMemberNames(snapshot) : [],
        nowIso,
      }),
    hasBootstrapTranscriptLaunchReconcileOutcome: (snapshot) =>
      hasBootstrapTranscriptLaunchReconcileOutcome({
        snapshot,
        expectedMembers: getPersistedLaunchMemberNames(snapshot),
        findBootstrapRuntimeProofObservedAt: (teamName, memberName, member) =>
          input.findBootstrapRuntimeProofObservedAt(teamName, memberName, member),
        findBootstrapTranscriptOutcome: (teamName, memberName, sinceMs) =>
          input.findBootstrapTranscriptOutcome(teamName, memberName, sinceMs),
      }),
    choosePreferredLaunchSnapshot,
    createDefaultLaunchReconcileConfigMembers,
    parseLaunchReconcileConfigMembers,
    getTeamsBasePath,
    pathJoin: (...parts) => path.join(...parts),
    readRegularFileUtf8: tryReadRegularFileUtf8,
    teamJsonReadTimeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
    teamConfigMaxBytes: TEAM_CONFIG_MAX_BYTES,
    readLeadInboxMessagesForLaunchReconcile: (teamName, leadName) =>
      readLeadInboxMessagesForLaunchReconcile({
        teamName,
        leadName,
        teamsBasePath: getTeamsBasePath(),
        readRegularFileUtf8: tryReadRegularFileUtf8,
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_INBOX_MAX_BYTES,
      }),
    hasLeadInboxLaunchReconcileHeartbeat: (snapshot, messages) =>
      hasMixedSecondaryLaunchReconcileHeartbeat({
        snapshot,
        messages,
        expectedMembers: getPersistedLaunchMemberNames(snapshot),
        ports: {
          resolveExpectedLaunchMemberName: input.resolveExpectedLaunchMemberName,
          isMeaningfulBootstrapCheckInMessage,
        },
      }),
    getLiveTeamAgentRuntimeMetadata: input.getLiveTeamAgentRuntimeMetadata,
    getPersistedLaunchMemberNames,
    selectLatestLeadInboxLaunchReconcileMessage: ({
      messages,
      expectedMembers,
      expected,
      firstSpawnAcceptedAt,
    }) =>
      selectLatestMixedSecondaryLaunchReconcileMessage({
        messages,
        expectedMembers,
        expected,
        firstSpawnAcceptedAt,
        ports: {
          resolveExpectedLaunchMemberName: input.resolveExpectedLaunchMemberName,
          isMeaningfulBootstrapCheckInMessage,
        },
      }),
    findBootstrapRuntimeProofObservedAt: input.findBootstrapRuntimeProofObservedAt,
    findBootstrapTranscriptOutcome: input.findBootstrapTranscriptOutcome,
    readProcessBootstrapTransportSummary: (summaryInput) =>
      readProcessBootstrapTransportSummary({
        ...summaryInput,
        teamsBasePath: getTeamsBasePath(),
        runtimeMembers: input.readPersistedRuntimeMembers(summaryInput.teamName),
      }),
    applyProcessBootstrapTransportOverlay: (overlayInput) =>
      applyProcessBootstrapTransportOverlay({
        ...overlayInput,
        nowIso,
        mergeRuntimeDiagnostics,
      }),
    nowIso,
    nowMs: () => Date.now(),
  };
}

export function reconcilePersistedLaunchStateWithTeamProvisioningPorts(
  teamName: string,
  input: TeamProvisioningPersistedLaunchReconcilePortsInput
): Promise<PersistedLaunchReconciliationResult> {
  return reconcilePersistedLaunchStateWithPorts(
    teamName,
    createTeamProvisioningPersistedLaunchReconcilePorts(input)
  );
}
