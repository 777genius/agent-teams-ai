import { readCommittedOpenCodeBootstrapSessionEvidence } from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { readTeamLaunchFreshness } from '@main/services/team/TeamLaunchFreshness';
import {
  TeamLaunchStateStore,
  withTeamLaunchStatePublicationLock,
} from '@main/services/team/TeamLaunchStateStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { OPENCODE_NATIVE_HISTORY_UNAVAILABLE_WARNING } from './memberLogStreamSourceUtils';

import type { MemberLogStreamWarning } from '../../../../contracts';

export type OpenCodeMemberTranscriptBinding =
  | {
      kind: 'bound';
      mode: 'active' | 'stopped';
      runId: string;
      laneId: string;
      sessionId: string;
      cacheKey: string;
    }
  | {
      kind: 'unavailable';
      reason: 'inactive' | 'missing' | 'conflicting' | 'unreadable' | 'ambiguous';
      cacheKey: string;
    };
export interface OpenCodeTranscriptMember {
  teamName: string;
  memberName: string;
  laneId?: string;
}
export interface OpenCodeTranscriptBindingReader {
  read(input: OpenCodeTranscriptMember): Promise<OpenCodeMemberTranscriptBinding>;
  isCurrent(
    input: OpenCodeTranscriptMember,
    binding: OpenCodeMemberTranscriptBinding
  ): Promise<boolean>;
}

export function unavailableOpenCodeTranscriptWarning(
  binding?: OpenCodeMemberTranscriptBinding
): MemberLogStreamWarning {
  return binding?.kind === 'unavailable' && binding.reason === 'ambiguous'
    ? {
        code: 'opencode_ambiguous_lane',
        message: 'OpenCode runtime session has conflicting lane bindings.',
      }
    : OPENCODE_NATIVE_HISTORY_UNAVAILABLE_WARNING;
}

/** Exact app-owned identity only. The runtime's full-binding dispatcher owns V1/V2 selection. */
interface BindingReaderDependencies {
  readEvidence: typeof readCommittedOpenCodeBootstrapSessionEvidence;
  readFreshness: typeof readTeamLaunchFreshness;
  stateStore: Pick<TeamLaunchStateStore, 'readResult'>;
  teamsBasePath: () => string;
}

export class OpenCodeMemberTranscriptBindingReader implements OpenCodeTranscriptBindingReader {
  constructor(
    private readonly deps: BindingReaderDependencies = {
      readEvidence: readCommittedOpenCodeBootstrapSessionEvidence,
      readFreshness: readTeamLaunchFreshness,
      stateStore: new TeamLaunchStateStore(),
      teamsBasePath: getTeamsBasePath,
    }
  ) {}

  async read(input: OpenCodeTranscriptMember): Promise<OpenCodeMemberTranscriptBinding> {
    const unavailable = (
      reason: Extract<OpenCodeMemberTranscriptBinding, { kind: 'unavailable' }>['reason'],
      stamp = ''
    ): OpenCodeMemberTranscriptBinding => ({
      kind: 'unavailable',
      reason,
      cacheKey: JSON.stringify([reason, stamp]),
    });
    if (!input.laneId) return unavailable('missing');
    try {
      return await withTeamLaunchStatePublicationLock(
        input.teamName,
        async (): Promise<OpenCodeMemberTranscriptBinding> => {
          const freshness = await this.deps.readFreshness(input.teamName);
          const stamp = JSON.stringify(freshness);
          if (freshness?.kind === 'stop') {
            const matches = (freshness.transcriptBindings ?? []).filter(
              (record) => record.memberName === input.memberName && record.laneId === input.laneId
            );
            if (matches.length !== 1)
              return unavailable(matches.length > 1 ? 'ambiguous' : 'inactive', stamp);
            const record = matches[0]!;
            return {
              kind: 'bound',
              mode: 'stopped',
              runId: record.runId,
              laneId: record.laneId,
              sessionId: record.sessionId,
              cacheKey: JSON.stringify([stamp, record]),
            };
          }
          const publication = await this.deps.stateStore.readResult(input.teamName);
          if (publication.status === 'unreadable') return unavailable('unreadable', stamp);
          if (publication.status !== 'snapshot') return unavailable('missing', stamp);
          if (
            freshness?.kind !== 'launch' ||
            publication.snapshot.publicationRunId !== freshness.runId
          )
            return unavailable('conflicting', stamp);
          const evidence = await this.deps.readEvidence({
            teamsBasePath: this.deps.teamsBasePath(),
            teamName: input.teamName,
            laneId: input.laneId!,
          });
          if (!evidence.committed || evidence.state !== 'healthy')
            return unavailable('unreadable', stamp);
          const matches = evidence.sessions.filter(
            (record) =>
              record.teamName === input.teamName &&
              record.memberName === input.memberName &&
              record.laneId === input.laneId &&
              record.runId === evidence.activeRunId
          );
          if (matches.length !== 1)
            return unavailable(matches.length > 1 ? 'ambiguous' : 'missing', stamp);
          const record = matches[0]!;
          if (!record.runId || !record.id) return unavailable('missing', stamp);
          const candidate = record.appManagedBootstrapCandidate;
          const member = publication.snapshot.members[input.memberName];
          if (
            (record.source === 'app_managed_bootstrap' && !candidate) ||
            (candidate &&
              (candidate.teamName !== input.teamName ||
                candidate.memberName !== input.memberName ||
                candidate.laneId !== record.laneId ||
                candidate.runId !== record.runId ||
                candidate.runtimeSessionId !== record.id)) ||
            (member &&
              (member.name !== input.memberName ||
                (member.providerId !== undefined && member.providerId !== 'opencode') ||
                (member.appManagedBootstrapCandidate &&
                  (member.appManagedBootstrapCandidate.teamName !== input.teamName ||
                    member.appManagedBootstrapCandidate.memberName !== input.memberName ||
                    member.appManagedBootstrapCandidate.laneId !== record.laneId ||
                    member.appManagedBootstrapCandidate.runId !== record.runId ||
                    member.appManagedBootstrapCandidate.runtimeSessionId !== record.id)) ||
                (member.laneId && member.laneId !== record.laneId) ||
                (member.runtimeRunId && member.runtimeRunId !== record.runId) ||
                (member.runtimeSessionId && member.runtimeSessionId !== record.id)))
          )
            return unavailable('conflicting', stamp);
          return {
            kind: 'bound',
            mode: 'active',
            runId: record.runId,
            laneId: record.laneId,
            sessionId: record.id,
            cacheKey: JSON.stringify([stamp, record.runId, record.laneId, record.id]),
          };
        }
      );
    } catch {
      return unavailable('unreadable');
    }
  }

  async isCurrent(
    input: OpenCodeTranscriptMember,
    binding: OpenCodeMemberTranscriptBinding
  ): Promise<boolean> {
    return (await this.read(input)).cacheKey === binding.cacheKey;
  }
}
