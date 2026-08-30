/**
 * Per-member launch/runtime diagnostics for the HTTP sidecar.
 *
 * The renderer builds the MemberDetailDialog view from two snapshots:
 * `getMemberSpawnStatuses()` and `getTeamAgentRuntimeSnapshot()`, plus the
 * member runtime advisory carried on the team view snapshot. This module only
 * merges those already-projected snapshots per member; the classification work
 * stays in the services that produce them.
 */

import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { boundedDiagnosticString } from '@shared/utils/diagnosticsRedaction';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { isLeadMember } from '@shared/utils/leadDetection';
import { isRuntimeAdvisoryCardError } from '@shared/utils/memberRuntimeAdvisoryClassification';
import {
  hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext,
  isBootstrapConfirmedProvisionedButNotAliveFailure,
} from '@shared/utils/teamLaunchFailureReason';

import type { HttpServices } from './index';
import type {
  MemberLaunchState,
  MemberRuntimeAdvisory,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeLivenessKind,
  TeamAgentRuntimeSnapshot,
  TeamGetDataOptions,
  TeamMemberSnapshot,
  TeamProviderBackendId,
  TeamProviderId,
  TeamViewSnapshot,
} from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

export interface TeamMemberDiagnosticsEntry {
  memberName: string;
  isLead: boolean;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  laneId?: string;
  laneKind?: 'primary' | 'secondary';
  model?: string;
  runtimeModel?: string;
  memberCardError?: string;
  diagnostics: string[];
  /** Set once the member was removed from the roster mid-run; the entry is a ghost. */
  removedAt?: number;
  spawnStatus?: MemberSpawnStatus;
  launchState?: MemberLaunchState;
  livenessKind?: TeamAgentRuntimeLivenessKind;
  livenessSource?: MemberSpawnLivenessSource;
  alive?: boolean;
  restartable?: boolean;
  runtimeAlive?: boolean;
  bootstrapConfirmed?: boolean;
  bootstrapStalled?: boolean;
  agentToolAccepted?: boolean;
  hardFailure?: boolean;
  hardFailureReason?: string;
  error?: string;
  runtimeDiagnostic?: string;
  runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  runtimeAdvisoryKind?: MemberRuntimeAdvisory['kind'];
  runtimeAdvisoryReasonCode?: MemberRuntimeAdvisory['reasonCode'];
  runtimeAdvisoryObservedAt?: string;
  runtimeAdvisoryMessage?: string;
  rssBytes?: number;
  cpuPercent?: number;
  pid?: number;
  runtimePid?: number;
  runtimeSessionId?: string;
  processCommand?: string;
  cwd?: string;
  pendingPermissionRequestIds?: string[];
  firstSpawnAcceptedAt?: string;
  lastHeartbeatAt?: string;
  livenessLastCheckedAt?: string;
  runtimeLastSeenAt?: string;
  spawnUpdatedAt?: string;
  runtimeUpdatedAt?: string;
}

export interface TeamMemberDiagnosticsResponse {
  teamName: string;
  generatedAt: string;
  runId: string | null;
  spawnSource?: MemberSpawnStatusesSnapshot['source'];
  teamLaunchState?: MemberSpawnStatusesSnapshot['teamLaunchState'];
  launchPhase?: MemberSpawnStatusesSnapshot['launchPhase'];
  spawnUpdatedAt?: string;
  runtimeUpdatedAt: string;
  members: TeamMemberDiagnosticsEntry[];
}

/**
 * Every string this route emits is redacted and length-bounded exactly like the
 * member dialog projection: the HTTP port is unauthenticated and its payloads
 * are persisted by external monitors.
 */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.map((value) => boundedDiagnosticString(value)).find(Boolean);
}

function errorSeverityDiagnostic(source: {
  runtimeDiagnostic?: string;
  runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
}): string | undefined {
  return source.runtimeDiagnosticSeverity === 'error' ? source.runtimeDiagnostic : undefined;
}

/**
 * The member card suppresses the first spawn failure once the member healed into
 * a bootstrap-confirmed provisioned-but-not-alive state without unsafe runtime
 * evidence (`memberLaunchDiagnostics.ts`); a healed member must not keep
 * reporting that failure over HTTP either.
 */
function hasHealedSpawnFailure(
  spawnEntry: MemberSpawnStatusEntry | undefined,
  runtimeEntry: TeamAgentRuntimeEntry | undefined
): boolean {
  return (
    isBootstrapConfirmedProvisionedButNotAliveFailure(spawnEntry) &&
    !hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext(spawnEntry, runtimeEntry)
  );
}

function resolveMemberCardError(input: {
  spawnEntry: MemberSpawnStatusEntry | undefined;
  runtimeEntry: TeamAgentRuntimeEntry | undefined;
  advisory: MemberRuntimeAdvisory | undefined;
  providerId: TeamProviderId | undefined;
}): string | undefined {
  const { spawnEntry, runtimeEntry, advisory, providerId } = input;
  const healedSpawnFailure = hasHealedSpawnFailure(spawnEntry, runtimeEntry);
  return firstNonEmpty(
    healedSpawnFailure ? undefined : spawnEntry?.error,
    healedSpawnFailure ? undefined : spawnEntry?.hardFailureReason,
    errorSeverityDiagnostic(spawnEntry ?? {}),
    errorSeverityDiagnostic(runtimeEntry ?? {}),
    isRuntimeAdvisoryCardError(advisory, providerId) ? advisory?.message : undefined
  );
}

function collectDiagnostics(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const bounded = boundedDiagnosticString(value);
    if (bounded) {
      seen.add(bounded);
    }
  }
  return [...seen];
}

function collectMemberNames(input: {
  memberSnapshots: TeamMemberSnapshot[];
  spawnSnapshot: MemberSpawnStatusesSnapshot;
  runtimeSnapshot: TeamAgentRuntimeSnapshot;
}): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (name: string | undefined): void => {
    const trimmed = name?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      names.push(trimmed);
    }
  };
  // Removed members stay in the roster snapshot with `removedAt` set; they are
  // seeded only when the spawn/runtime snapshots still know about them.
  input.memberSnapshots
    .filter((member) => member.removedAt == null)
    .forEach((member) => push(member.name));
  input.spawnSnapshot.expectedMembers?.forEach(push);
  Object.keys(input.spawnSnapshot.statuses ?? {}).forEach(push);
  Object.keys(input.runtimeSnapshot.members ?? {}).forEach(push);
  return names;
}

function buildEntry(input: {
  memberName: string;
  memberSnapshot: TeamMemberSnapshot | undefined;
  spawnEntry: MemberSpawnStatusEntry | undefined;
  runtimeEntry: TeamAgentRuntimeEntry | undefined;
}): TeamMemberDiagnosticsEntry {
  const { memberName, memberSnapshot, spawnEntry, runtimeEntry } = input;
  const advisory = memberSnapshot?.runtimeAdvisory;
  const providerId = runtimeEntry?.providerId ?? memberSnapshot?.providerId;
  const memberCardError = resolveMemberCardError({
    spawnEntry,
    runtimeEntry,
    advisory,
    providerId,
  });
  return {
    memberName,
    isLead: isLeadMember(memberSnapshot ?? { name: memberName }),
    providerId,
    providerBackendId: runtimeEntry?.providerBackendId ?? memberSnapshot?.providerBackendId,
    laneId: runtimeEntry?.laneId ?? memberSnapshot?.laneId,
    laneKind: runtimeEntry?.laneKind ?? memberSnapshot?.laneKind,
    model: memberSnapshot?.model,
    runtimeModel: runtimeEntry?.runtimeModel ?? spawnEntry?.runtimeModel,
    memberCardError,
    removedAt: memberSnapshot?.removedAt,
    diagnostics: collectDiagnostics([
      memberCardError,
      spawnEntry?.runtimeDiagnostic,
      runtimeEntry?.runtimeDiagnostic,
      advisory?.message,
      spawnEntry?.hardFailureReason,
      spawnEntry?.error,
      ...(runtimeEntry?.diagnostics ?? []),
    ]),
    spawnStatus: spawnEntry?.status,
    launchState: spawnEntry?.launchState,
    livenessKind: spawnEntry?.livenessKind ?? runtimeEntry?.livenessKind,
    livenessSource: spawnEntry?.livenessSource,
    alive: runtimeEntry?.alive,
    restartable: runtimeEntry?.restartable,
    runtimeAlive: spawnEntry?.runtimeAlive,
    bootstrapConfirmed: spawnEntry?.bootstrapConfirmed,
    bootstrapStalled: spawnEntry?.bootstrapStalled,
    agentToolAccepted: spawnEntry?.agentToolAccepted,
    hardFailure: spawnEntry?.hardFailure,
    hardFailureReason: boundedDiagnosticString(spawnEntry?.hardFailureReason),
    error: boundedDiagnosticString(spawnEntry?.error),
    runtimeDiagnostic: boundedDiagnosticString(
      spawnEntry?.runtimeDiagnostic ?? runtimeEntry?.runtimeDiagnostic
    ),
    runtimeDiagnosticSeverity:
      spawnEntry?.runtimeDiagnosticSeverity ?? runtimeEntry?.runtimeDiagnosticSeverity,
    runtimeAdvisoryKind: advisory?.kind,
    runtimeAdvisoryReasonCode: advisory?.reasonCode,
    runtimeAdvisoryObservedAt: boundedDiagnosticString(advisory?.observedAt),
    runtimeAdvisoryMessage: boundedDiagnosticString(advisory?.message),
    rssBytes: runtimeEntry?.rssBytes,
    cpuPercent: runtimeEntry?.cpuPercent,
    pid: runtimeEntry?.pid,
    runtimePid: runtimeEntry?.runtimePid,
    runtimeSessionId: boundedDiagnosticString(runtimeEntry?.runtimeSessionId),
    processCommand: boundedDiagnosticString(runtimeEntry?.processCommand),
    cwd: boundedDiagnosticString(runtimeEntry?.cwd ?? memberSnapshot?.cwd),
    pendingPermissionRequestIds: spawnEntry?.pendingPermissionRequestIds,
    firstSpawnAcceptedAt: spawnEntry?.firstSpawnAcceptedAt,
    lastHeartbeatAt: spawnEntry?.lastHeartbeatAt,
    livenessLastCheckedAt: spawnEntry?.livenessLastCheckedAt,
    runtimeLastSeenAt: runtimeEntry?.runtimeLastSeenAt,
    spawnUpdatedAt: spawnEntry?.updatedAt,
    runtimeUpdatedAt: runtimeEntry?.updatedAt,
  };
}

export function buildTeamMemberDiagnosticsResponse(input: {
  teamName: string;
  spawnSnapshot: MemberSpawnStatusesSnapshot;
  runtimeSnapshot: TeamAgentRuntimeSnapshot;
  memberSnapshots?: TeamMemberSnapshot[];
  generatedAt?: string;
}): TeamMemberDiagnosticsResponse {
  const memberSnapshots = input.memberSnapshots ?? [];
  const snapshotsByName = new Map(memberSnapshots.map((member) => [member.name, member]));
  const memberNames = collectMemberNames({
    memberSnapshots,
    spawnSnapshot: input.spawnSnapshot,
    runtimeSnapshot: input.runtimeSnapshot,
  });
  return {
    teamName: input.teamName,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    runId: input.runtimeSnapshot.runId ?? input.spawnSnapshot.runId,
    spawnSource: input.spawnSnapshot.source,
    teamLaunchState: input.spawnSnapshot.teamLaunchState,
    launchPhase: input.spawnSnapshot.launchPhase,
    spawnUpdatedAt: input.spawnSnapshot.updatedAt,
    runtimeUpdatedAt: input.runtimeSnapshot.updatedAt,
    members: memberNames.map((memberName) =>
      buildEntry({
        memberName,
        memberSnapshot: snapshotsByName.get(memberName),
        spawnEntry: input.spawnSnapshot.statuses?.[memberName],
        runtimeEntry: input.runtimeSnapshot.members?.[memberName],
      })
    ),
  };
}

/**
 * The route reads only advisory/config fields, so it opts out of the member
 * git-branch enrichment that dominates the cost of a full team snapshot.
 */
interface TeamMemberDiagnosticsTeamDataReader {
  getTeamData(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewSnapshot>;
}

/**
 * Advisories live on the team view snapshot, which is optional in HTTP-only
 * modes. A missing roster must not fail the spawn/runtime diagnostics, but an
 * unknown team still has to reach the shared 404 mapping instead of answering
 * 200 with an empty member list.
 */
async function readMemberSnapshots(
  teamDataApi: TeamMemberDiagnosticsTeamDataReader | undefined,
  teamName: string,
  isTeamNotFoundError: (error: unknown) => boolean
): Promise<TeamMemberSnapshot[]> {
  try {
    return (
      (await teamDataApi?.getTeamData(teamName, { includeMemberBranches: false }))?.members ?? []
    );
  } catch (error) {
    if (isTeamNotFoundError(error)) {
      throw error;
    }
    return [];
  }
}

/** Error handling shared with the neighboring routes in `./teams`. */
export interface TeamMemberDiagnosticsRouteDeps {
  logger: { error(message: string, detail: string): void };
  shouldLogError(error: unknown): boolean;
  getStatusCode(error: unknown): number;
  getResponseErrorMessage(error: unknown): string;
  createFeatureUnavailableError(message: string): Error;
  isTeamNotFoundError: (error: unknown) => boolean;
}

export function registerTeamMemberDiagnosticsRoute(
  app: FastifyInstance,
  services: HttpServices,
  deps: TeamMemberDiagnosticsRouteDeps
): void {
  app.get<{ Params: { teamName: string } }>(
    '/api/teams/:teamName/members/diagnostics',
    async (request, reply) => {
      try {
        const validatedTeamName = validateTeamName(request.params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }
        const teamName = validatedTeamName.value!;
        const diagnosticsApi = services.teamApis?.memberDiagnostics;
        if (!diagnosticsApi) {
          throw deps.createFeatureUnavailableError(
            'Team member diagnostics are not available in this mode'
          );
        }
        const [spawnSnapshot, runtimeSnapshot, memberSnapshots] = await Promise.all([
          diagnosticsApi.getMemberSpawnStatuses(teamName),
          diagnosticsApi.getTeamAgentRuntimeSnapshot(teamName),
          readMemberSnapshots(services.teamDataApi, teamName, deps.isTeamNotFoundError),
        ]);
        return reply.send(
          buildTeamMemberDiagnosticsResponse({
            teamName,
            spawnSnapshot,
            runtimeSnapshot,
            memberSnapshots,
          })
        );
      } catch (error) {
        if (deps.shouldLogError(error)) {
          deps.logger.error(
            `Error in GET /api/teams/${request.params.teamName}/members/diagnostics:`,
            getErrorMessage(error)
          );
        }
        return reply
          .status(deps.getStatusCode(error))
          .send({ error: deps.getResponseErrorMessage(error) });
      }
    }
  );
}
