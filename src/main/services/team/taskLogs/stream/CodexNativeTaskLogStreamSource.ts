import { getTaskDisplayId } from '@shared/utils/taskIdentity';
import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import { TeamConfigReader } from '../../TeamConfigReader';
import { TeamMembersMetaStore } from '../../TeamMembersMetaStore';
import { TeamTaskReader } from '../../TeamTaskReader';
import { BoardTaskExactLogChunkBuilder } from '../exact/BoardTaskExactLogChunkBuilder';
import { isCodexNativeTraceFallbackEnabled } from '../exact/featureGates';

import { CodexNativeTraceProjector } from './CodexNativeTraceProjector';
import { CodexNativeTraceReader } from './CodexNativeTraceReader';

import type {
  BoardTaskLogActor,
  BoardTaskLogParticipant,
  BoardTaskLogSegment,
  BoardTaskLogStreamResponse,
  TeamProviderId,
  TeamTask,
} from '@shared/types';

function normalizeMemberName(value: string): string {
  return value.trim().toLowerCase();
}

function buildParticipantKey(memberName: string): string {
  return `member:${normalizeMemberName(memberName)}`;
}

function buildParticipant(memberName: string): BoardTaskLogParticipant {
  return {
    key: buildParticipantKey(memberName),
    label: memberName,
    role: 'member',
    isLead: false,
    isSidechain: false,
  };
}

function buildActor(memberName: string, sessionId: string): BoardTaskLogActor {
  return {
    memberName,
    role: 'member',
    sessionId,
    isSidechain: false,
  };
}

function resolveExplicitProviderId(member: {
  providerId?: unknown;
  provider?: unknown;
}): ReturnType<typeof normalizeOptionalTeamProviderId> {
  return (
    normalizeOptionalTeamProviderId(member.providerId) ??
    normalizeOptionalTeamProviderId(member.provider)
  );
}

function inferProviderIdFromMemberModel(member: { model?: string } | undefined) {
  return inferTeamProviderIdFromModel(member?.model);
}

function inferProviderIdFromBackend(providerBackendId: unknown): TeamProviderId | undefined {
  const normalized = typeof providerBackendId === 'string' ? providerBackendId.trim() : '';
  if (normalized === 'codex-native') {
    return 'codex';
  }
  if (normalized === 'opencode-cli') {
    return 'opencode';
  }
  return undefined;
}

export class CodexNativeTaskLogStreamSource {
  constructor(
    private readonly taskReader: TeamTaskReader = new TeamTaskReader(),
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore(),
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    private readonly traceReader: CodexNativeTraceReader = new CodexNativeTraceReader(),
    private readonly projector: CodexNativeTraceProjector = new CodexNativeTraceProjector(),
    private readonly chunkBuilder: BoardTaskExactLogChunkBuilder = new BoardTaskExactLogChunkBuilder()
  ) {}

  private readConfigForObservation(teamName: string) {
    return typeof this.configReader.getConfigSnapshot === 'function'
      ? this.configReader.getConfigSnapshot(teamName)
      : this.configReader.getConfig(teamName);
  }

  async getTaskLogStream(
    teamName: string,
    taskId: string,
    options: { excludeNativeToolSignatures?: ReadonlySet<string> } = {}
  ): Promise<BoardTaskLogStreamResponse | null> {
    if (!isCodexNativeTraceFallbackEnabled()) {
      return null;
    }

    const task = await this.resolveTask(teamName, taskId);
    if (!task) {
      return null;
    }
    const ownerName = task.owner?.trim();
    if (!ownerName) {
      return null;
    }
    if (!(await this.isCodexOwner(teamName, ownerName))) {
      return null;
    }

    const displayId = getTaskDisplayId(task);
    const candidateTaskIds = [
      ...new Set([task.id, displayId, task.id.slice(0, 8)].filter(Boolean)),
    ];
    const runs = await this.traceReader.readTaskRuns({
      teamName,
      taskIds: candidateTaskIds,
      includeIncoming: task.status === 'in_progress',
    });
    if (runs.length === 0) {
      return null;
    }

    const excludedSignatures = options.excludeNativeToolSignatures ?? new Set<string>();
    const messages = this.projector.project(runs, {
      excludeSignatures: excludedSignatures,
    });
    if (messages.length === 0) {
      return null;
    }

    const chunks = this.chunkBuilder.buildBundleChunks(messages);
    if (chunks.length === 0) {
      return null;
    }

    const participant = buildParticipant(ownerName);
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];
    if (!firstMessage || !lastMessage) {
      return null;
    }

    const nativeToolCount = messages.filter((message) => message.toolCalls.length > 0).length;
    const totalNativeToolCount =
      excludedSignatures.size > 0
        ? this.projector.project(runs).filter((message) => message.toolCalls.length > 0).length
        : nativeToolCount;
    const dedupedNativeToolCount = Math.max(0, totalNativeToolCount - nativeToolCount);

    const segment: BoardTaskLogSegment = {
      id: `codex-native:${teamName}:${task.id}:${normalizeMemberName(ownerName)}`,
      participantKey: participant.key,
      actor: buildActor(ownerName, runs[0]?.runId ?? firstMessage.sessionId),
      startTimestamp: firstMessage.timestamp.toISOString(),
      endTimestamp: lastMessage.timestamp.toISOString(),
      chunks,
    };

    return {
      participants: [participant],
      defaultFilter: participant.key,
      segments: [segment],
      source: 'codex_native_trace_fallback',
      runtimeProjection: {
        provider: 'codex_native',
        mode: 'trace',
        attributionRecordCount: 0,
        projectedMessageCount: messages.length,
        nativeToolCount,
        fallbackReason: 'codex_native_trace',
        traceFileCount: new Set(runs.map((run) => run.filePath)).size,
        traceRunCount: runs.length,
        dedupedNativeToolCount,
      },
    };
  }

  private async resolveTask(teamName: string, taskId: string): Promise<TeamTask | null> {
    const [activeTasks, deletedTasks] = await Promise.all([
      this.taskReader.getTasks(teamName).catch(() => []),
      this.taskReader.getDeletedTasks(teamName).catch(() => []),
    ]);
    const normalizedRef = taskId.trim().replace(/^#/, '').toLowerCase();
    return (
      [...activeTasks, ...deletedTasks].find((candidate) => {
        const displayId = getTaskDisplayId(candidate);
        return [candidate.id, displayId, candidate.id.slice(0, 8)]
          .map((value) => value.trim().replace(/^#/, '').toLowerCase())
          .includes(normalizedRef);
      }) ?? null
    );
  }

  private async isCodexOwner(teamName: string, ownerName: string): Promise<boolean> {
    const normalizedOwner = normalizeMemberName(ownerName);
    const [metaMembers, config] = await Promise.all([
      this.membersMetaStore.getMembers(teamName).catch(() => []),
      this.readConfigForObservation(teamName).catch(() => null),
    ]);
    const configMember = (config?.members ?? []).find(
      (candidate) => normalizeMemberName(candidate.name) === normalizedOwner
    );
    const metaMember = metaMembers.find(
      (candidate) => normalizeMemberName(candidate.name) === normalizedOwner
    );
    const providerId =
      resolveExplicitProviderId(metaMember ?? {}) ??
      resolveExplicitProviderId(configMember ?? {}) ??
      inferProviderIdFromBackend(configMember?.providerBackendId) ??
      inferProviderIdFromMemberModel(configMember) ??
      inferProviderIdFromBackend(metaMember?.providerBackendId) ??
      inferProviderIdFromMemberModel(metaMember);
    return providerId === 'codex';
  }
}
