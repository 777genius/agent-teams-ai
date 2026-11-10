import { ClaudeMultimodelBridgeService } from '../../runtime/ClaudeMultimodelBridgeService';
import { canonicalizeAgentTeamsToolName } from '../agentTeamsToolNames';
import { ClaudeBinaryResolver } from '../ClaudeBinaryResolver';

import type {
  OpenCodeRuntimeTranscriptLogMessage,
  OpenCodeRuntimeTranscriptLogToolCall,
} from '../../runtime/ClaudeMultimodelBridgeService';
import type { BoardTaskActivityRecord } from '../taskLogs/activity/BoardTaskActivityRecord';
import type { TeamTaskStallExactRow } from './TeamTaskStallTypes';
import type { ParsedMessage } from '@main/types';
import type { TeamProviderId, TeamTask } from '@shared/types';

const OPENCODE_STALL_TRANSCRIPT_LIMIT = 500;

const TASK_STALL_MARKER_TOOL_NAMES = new Set<string>([
  'task_start',
  'task_add_comment',
  'task_set_status',
  'task_complete',
  'review_start',
  'review_request',
  'review_approve',
  'review_request_changes',
]);

const TASK_REFERENCE_KEYS = new Set<string>([
  'taskid',
  'task_id',
  'targetid',
  'targettaskid',
  'target_task_id',
  'canonicalid',
  'canonical_id',
  'displayid',
  'display_id',
]);

const TEAM_REFERENCE_KEYS = new Set<string>(['team', 'teamid', 'team_id', 'teamname', 'team_name']);

interface BinaryResolverLike {
  resolve(): Promise<string | null>;
}

interface RuntimeBridgeLike {
  getOpenCodeTranscript(
    binaryPath: string,
    params: {
      teamId: string;
      memberName: string;
      limit?: number;
    }
  ): Promise<Awaited<ReturnType<ClaudeMultimodelBridgeService['getOpenCodeTranscript']>>>;
}

export interface OpenCodeTaskStallEvidence {
  recordsByTaskId: Map<string, BoardTaskActivityRecord[]>;
  exactRowsByFilePath: Map<string, TeamTaskStallExactRow[]>;
}

function emptyEvidence(): OpenCodeTaskStallEvidence {
  return {
    recordsByTaskId: new Map(),
    exactRowsByFilePath: new Map(),
  };
}

function normalizeMemberNameKey(name: string | undefined): string | null {
  const normalized = name?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function normalizeTaskRef(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const normalized = String(value).trim().replace(/^#/, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function buildTaskRefSet(task: TeamTask): Set<string> {
  return new Set(
    [task.id, task.displayId]
      .map(normalizeTaskRef)
      .filter((value): value is string => value !== null)
  );
}

function collectNormalizedRefs(value: unknown, depth = 0): Set<string> {
  const refs = new Set<string>();
  if (depth > 4 || value === null || value === undefined) {
    return refs;
  }

  const normalized = normalizeTaskRef(value);
  if (normalized) {
    refs.add(normalized);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      for (const ref of collectNormalizedRefs(item, depth + 1)) {
        refs.add(ref);
      }
    }
    return refs;
  }

  if (typeof value === 'object') {
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      for (const ref of collectNormalizedRefs(nestedValue, depth + 1)) {
        refs.add(ref);
      }
    }
  }

  return refs;
}

function collectExplicitRefsForKeys(value: unknown, keys: Set<string>, depth = 0): Set<string> {
  const refs = new Set<string>();
  if (depth > 4 || value === null || value === undefined) {
    return refs;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      for (const ref of collectExplicitRefsForKeys(item, keys, depth + 1)) {
        refs.add(ref);
      }
    }
    return refs;
  }

  if (typeof value !== 'object') {
    return refs;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key.toLowerCase())) {
      for (const ref of collectNormalizedRefs(nestedValue)) {
        refs.add(ref);
      }
      continue;
    }

    for (const ref of collectExplicitRefsForKeys(nestedValue, keys, depth + 1)) {
      refs.add(ref);
    }
  }

  return refs;
}

function refsIntersect(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

function valueReferencesTask(value: unknown, taskRefs: Set<string>, depth = 0): boolean {
  if (depth > 4 || value === null || value === undefined || taskRefs.size === 0) {
    return false;
  }

  const normalized = normalizeTaskRef(value);
  if (normalized && taskRefs.has(normalized)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((item) => valueReferencesTask(item, taskRefs, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, nestedValue]) => {
      const normalizedKey = key.toLowerCase();
      if (TASK_REFERENCE_KEYS.has(normalizedKey)) {
        return valueReferencesTask(nestedValue, taskRefs, depth + 1);
      }
      return depth < 2 && valueReferencesTask(nestedValue, taskRefs, depth + 1);
    });
  }

  return false;
}

function markerInputReferencesTaskInTeam(
  input: unknown,
  teamName: string,
  taskRefs: Set<string>
): boolean {
  const normalizedTeamName = normalizeTaskRef(teamName);
  const explicitTeamRefs = collectExplicitRefsForKeys(input, TEAM_REFERENCE_KEYS);
  if (
    normalizedTeamName &&
    explicitTeamRefs.size > 0 &&
    !explicitTeamRefs.has(normalizedTeamName)
  ) {
    return false;
  }

  const explicitTaskRefs = collectExplicitRefsForKeys(input, TASK_REFERENCE_KEYS);
  if (explicitTaskRefs.size > 0) {
    return refsIntersect(explicitTaskRefs, taskRefs);
  }

  return valueReferencesTask(input, taskRefs);
}

function buildSyntheticFilePath(teamName: string, owner: string): string {
  return `opencode-runtime:${teamName}:${normalizeMemberNameKey(owner) ?? owner}`;
}

function toParsedMessage(message: OpenCodeRuntimeTranscriptLogMessage): ParsedMessage | null {
  const timestamp = new Date(message.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }

  return {
    uuid: message.uuid,
    parentUuid: message.parentUuid,
    type: message.type,
    timestamp,
    role: message.role,
    content: typeof message.content === 'string' ? message.content : [],
    model: message.model,
    agentName: message.agentName,
    isSidechain: true,
    isMeta: message.isMeta,
    sessionId: message.sessionId,
    toolCalls: message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.input,
      isTask: toolCall.isTask,
      ...(toolCall.taskDescription ? { taskDescription: toolCall.taskDescription } : {}),
      ...(toolCall.taskSubagentType ? { taskSubagentType: toolCall.taskSubagentType } : {}),
    })),
    toolResults: message.toolResults.map((toolResult) => ({
      toolUseId: toolResult.toolUseId,
      content: toolResult.content,
      isError: toolResult.isError,
    })),
    ...(message.sourceToolUseID ? { sourceToolUseID: message.sourceToolUseID } : {}),
    ...(message.sourceToolAssistantUUID
      ? { sourceToolAssistantUUID: message.sourceToolAssistantUUID }
      : {}),
    ...(message.subtype ? { subtype: message.subtype } : {}),
    ...(message.level ? { level: message.level } : {}),
  };
}

function toExactRow(
  message: OpenCodeRuntimeTranscriptLogMessage,
  filePath: string,
  sourceOrder: number
): TeamTaskStallExactRow | null {
  const parsedMessage = toParsedMessage(message);
  if (!parsedMessage) {
    return null;
  }

  return {
    filePath,
    sourceOrder,
    messageUuid: parsedMessage.uuid,
    timestamp: parsedMessage.timestamp.toISOString(),
    parsedMessage,
    ...(message.sourceToolUseID ? { sourceToolUseId: message.sourceToolUseID } : {}),
    ...(message.sourceToolAssistantUUID
      ? { sourceToolAssistantUuid: message.sourceToolAssistantUUID }
      : {}),
    ...(message.subtype === 'turn_duration' || message.subtype === 'init'
      ? { systemSubtype: message.subtype }
      : {}),
    toolUseIds: parsedMessage.toolCalls.map((toolCall) => toolCall.id),
    toolResultIds: parsedMessage.toolResults.map((toolResult) => toolResult.toolUseId),
  };
}

function buildTaskRef(task: TeamTask, teamName: string): BoardTaskActivityRecord['task'] {
  return {
    locator: {
      ref: task.id,
      refKind: 'canonical',
      canonicalId: task.id,
    },
    resolution: 'resolved',
    taskRef: {
      taskId: task.id,
      displayId: task.displayId ?? task.id.slice(0, 8),
      teamName,
    },
  };
}

function buildActionCategory(
  toolName: string
): NonNullable<BoardTaskActivityRecord['action']>['category'] {
  switch (toolName) {
    case 'task_add_comment':
      return 'comment';
    case 'review_start':
    case 'review_request':
    case 'review_approve':
    case 'review_request_changes':
      return 'review';
    case 'task_set_owner':
      return 'assignment';
    default:
      return 'status';
  }
}

function extractCommentId(input: Record<string, unknown>): string | undefined {
  const commentId = input.commentId ?? input.comment_id;
  return typeof commentId === 'string' && commentId.trim().length > 0
    ? commentId.trim()
    : undefined;
}

function buildRecord(args: {
  teamName: string;
  task: TeamTask;
  owner: string;
  sessionId: string;
  message: OpenCodeRuntimeTranscriptLogMessage;
  toolCall: OpenCodeRuntimeTranscriptLogToolCall;
  sourceOrder: number;
  filePath: string;
  canonicalToolName: string;
}): BoardTaskActivityRecord {
  const taskRef = buildTaskRef(args.task, args.teamName);
  const commentId = extractCommentId(args.toolCall.input);
  return {
    id: `opencode-stall:${args.teamName}:${args.task.id}:${args.message.uuid}:${args.toolCall.id}`,
    timestamp: new Date(args.message.timestamp).toISOString(),
    task: taskRef,
    linkKind: 'board_action',
    targetRole: 'subject',
    actor: {
      memberName: args.owner,
      role: 'member',
      sessionId: args.sessionId,
      isSidechain: true,
    },
    actorContext: {
      relation: 'same_task',
      activeTask: taskRef,
      activePhase: args.task.reviewState === 'review' ? 'review' : 'work',
    },
    action: {
      canonicalToolName: args.canonicalToolName,
      toolUseId: args.toolCall.id,
      category: buildActionCategory(args.canonicalToolName),
      ...(commentId ? { details: { commentId } } : {}),
    },
    source: {
      messageUuid: args.message.uuid,
      filePath: args.filePath,
      toolUseId: args.toolCall.id,
      sourceOrder: args.sourceOrder,
    },
  };
}

function collectTaskRecords(args: {
  teamName: string;
  task: TeamTask;
  owner: string;
  sessionId: string;
  filePath: string;
  messages: OpenCodeRuntimeTranscriptLogMessage[];
}): BoardTaskActivityRecord[] {
  const taskRefs = buildTaskRefSet(args.task);
  if (taskRefs.size === 0) {
    return [];
  }

  const records: BoardTaskActivityRecord[] = [];
  for (let index = 0; index < args.messages.length; index += 1) {
    const message = args.messages[index];
    if (!message) {
      continue;
    }

    for (const toolCall of message.toolCalls) {
      const canonicalToolName = canonicalizeAgentTeamsToolName(toolCall.name ?? '')
        .trim()
        .toLowerCase();
      if (!TASK_STALL_MARKER_TOOL_NAMES.has(canonicalToolName)) {
        continue;
      }
      if (!markerInputReferencesTaskInTeam(toolCall.input, args.teamName, taskRefs)) {
        continue;
      }

      records.push(
        buildRecord({
          teamName: args.teamName,
          task: args.task,
          owner: args.owner,
          sessionId: args.sessionId,
          message,
          toolCall,
          sourceOrder: index + 1,
          filePath: args.filePath,
          canonicalToolName,
        })
      );
    }
  }

  return records;
}

function groupOpenCodeTasksByOwner(
  tasks: TeamTask[],
  providerByMemberName: Map<string, TeamProviderId>
): Map<string, TeamTask[]> {
  const grouped = new Map<string, TeamTask[]>();
  for (const task of tasks) {
    const owner = task.owner?.trim();
    if (!owner) {
      continue;
    }
    const provider = providerByMemberName.get(normalizeMemberNameKey(owner) ?? '');
    if (provider !== 'opencode') {
      continue;
    }

    const existing = grouped.get(owner) ?? [];
    existing.push(task);
    grouped.set(owner, existing);
  }
  return grouped;
}

export class OpenCodeTaskStallEvidenceSource {
  constructor(
    private readonly runtimeBridge: RuntimeBridgeLike = new ClaudeMultimodelBridgeService(),
    private readonly binaryResolver: BinaryResolverLike = ClaudeBinaryResolver
  ) {}

  async readEvidence(args: {
    teamName: string;
    tasks: TeamTask[];
    providerByMemberName: Map<string, TeamProviderId>;
  }): Promise<OpenCodeTaskStallEvidence> {
    const tasksByOwner = groupOpenCodeTasksByOwner(args.tasks, args.providerByMemberName);
    if (tasksByOwner.size === 0) {
      return emptyEvidence();
    }

    const binaryPath = await this.binaryResolver.resolve();
    if (!binaryPath) {
      return emptyEvidence();
    }

    const evidence = emptyEvidence();
    for (const [owner, tasks] of tasksByOwner.entries()) {
      const transcript = await this.runtimeBridge
        .getOpenCodeTranscript(binaryPath, {
          teamId: args.teamName,
          memberName: owner,
          limit: OPENCODE_STALL_TRANSCRIPT_LIMIT,
        })
        .catch(() => null);
      const messages = transcript?.logProjection?.messages ?? [];
      if (messages.length === 0) {
        continue;
      }

      const filePath = buildSyntheticFilePath(args.teamName, owner);
      const exactRows = messages
        .map((message, index) => toExactRow(message, filePath, index + 1))
        .filter((row): row is TeamTaskStallExactRow => row !== null);
      if (exactRows.length > 0) {
        evidence.exactRowsByFilePath.set(filePath, exactRows);
      }

      const sessionId = transcript?.sessionId ?? messages[0]?.sessionId ?? filePath;
      for (const task of tasks) {
        const records = collectTaskRecords({
          teamName: args.teamName,
          task,
          owner,
          sessionId,
          filePath,
          messages,
        });
        if (records.length > 0) {
          evidence.recordsByTaskId.set(task.id, records);
        }
      }
    }

    return evidence;
  }
}
