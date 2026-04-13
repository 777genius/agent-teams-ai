import { getTaskDisplayId, taskMatchesRef } from '@shared/utils/taskIdentity';

import { TeamTaskReader } from '../../TeamTaskReader';
import { BoardTaskActivityRecordSource } from '../activity/BoardTaskActivityRecordSource';
import { TeamTranscriptSourceLocator } from '../discovery/TeamTranscriptSourceLocator';
import { BoardTaskExactLogStrictParser } from '../exact/BoardTaskExactLogStrictParser';
import { BoardTaskLogStreamService } from '../stream/BoardTaskLogStreamService';

import type { BoardTaskActivityRecord } from '../activity/BoardTaskActivityRecord';
import type { ParsedMessage } from '@main/types';
import type { TaskWorkInterval, TeamTask } from '@shared/types';

const BOARD_MCP_TOOL_PREFIXES = ['mcp__agent-teams__', 'mcp__agent_teams__'] as const;
const MAX_EXAMPLES = 10;

export interface BoardTaskLogDiagnosticExample {
  timestamp: string;
  filePath: string;
  messageUuid: string;
  toolUseId?: string;
  toolName: string;
  isSidechain: boolean;
  agentId?: string;
}

export interface BoardTaskLogDiagnosticsReport {
  teamName: string;
  requestedTaskRef: string;
  task: {
    taskId: string;
    displayId: string;
    subject: string;
    status: TeamTask['status'];
    owner?: string;
    workIntervals: TaskWorkInterval[];
  };
  transcript: {
    fileCount: number;
    files: string[];
  };
  explicitRecords: {
    total: number;
    execution: number;
    lifecycle: number;
    boardAction: number;
    participants: string[];
    toolNames: string[];
  };
  intervalToolResults: {
    total: number;
    boardMcp: number;
    worker: {
      total: number;
      explicitLinked: number;
      missingExplicit: number;
      examples: BoardTaskLogDiagnosticExample[];
    };
  };
  stream: {
    participants: string[];
    defaultFilter: string;
    segmentCount: number;
    visibleToolNames: string[];
    emptyPayloadExamples: BoardTaskLogDiagnosticExample[];
  };
  diagnosis: string[];
}

function normalizeRequestedTaskRef(taskRef: string): string {
  return taskRef.trim().replace(/^#/, '');
}

function isBoardMcpToolName(toolName: string | undefined): boolean {
  if (!toolName) return false;
  const normalized = toolName.trim().toLowerCase();
  return BOARD_MCP_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isWithinWorkIntervals(timestamp: Date, intervals: TaskWorkInterval[]): boolean {
  if (!Number.isFinite(timestamp.getTime())) {
    return false;
  }
  if (intervals.length === 0) {
    return true;
  }

  const time = timestamp.getTime();
  return intervals.some((interval) => {
    const startedAt = Date.parse(interval.startedAt);
    if (!Number.isFinite(startedAt) || time < startedAt) {
      return false;
    }
    if (!interval.completedAt) {
      return true;
    }
    const completedAt = Date.parse(interval.completedAt);
    return !Number.isFinite(completedAt) || time <= completedAt;
  });
}

function pushUnique(values: string[], value: string | undefined): void {
  if (!value) return;
  if (!values.includes(value)) {
    values.push(value);
  }
}

function pushExample(
  examples: BoardTaskLogDiagnosticExample[],
  example: BoardTaskLogDiagnosticExample
): void {
  if (examples.length < MAX_EXAMPLES) {
    examples.push(example);
  }
}

function buildParticipantLabel(record: BoardTaskActivityRecord): string {
  if (record.actor.memberName) {
    return record.actor.memberName;
  }
  if (!record.actor.isSidechain || record.actor.role === 'lead') {
    return 'lead session';
  }
  if (record.actor.agentId) {
    return `member ${record.actor.agentId.slice(0, 8)}`;
  }
  return `member session ${record.actor.sessionId.slice(0, 8)}`;
}

function extractVisibleToolNames(
  stream: Awaited<ReturnType<BoardTaskLogStreamService['getTaskLogStream']>>
): string[] {
  const toolNames: string[] = [];
  for (const segment of stream.segments) {
    for (const chunk of segment.chunks) {
      for (const message of chunk.rawMessages) {
        for (const toolCall of message.toolCalls) {
          pushUnique(toolNames, toolCall.name);
        }
      }
    }
  }
  return toolNames;
}

function buildStreamToolNameMap(
  stream: Awaited<ReturnType<BoardTaskLogStreamService['getTaskLogStream']>>
): Map<string, string> {
  const toolNameByUseId = new Map<string, string>();
  for (const segment of stream.segments) {
    for (const chunk of segment.chunks) {
      for (const message of chunk.rawMessages) {
        for (const toolCall of message.toolCalls) {
          toolNameByUseId.set(toolCall.id, toolCall.name);
        }
      }
    }
  }
  return toolNameByUseId;
}

function isEmptyToolPayload(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string') {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

function collectEmptyPayloadExamples(
  stream: Awaited<ReturnType<BoardTaskLogStreamService['getTaskLogStream']>>
): BoardTaskLogDiagnosticExample[] {
  const examples: BoardTaskLogDiagnosticExample[] = [];
  const toolNameByUseId = buildStreamToolNameMap(stream);

  for (const segment of stream.segments) {
    for (const chunk of segment.chunks) {
      for (const message of chunk.rawMessages) {
        for (const toolResult of message.toolResults) {
          if (!isEmptyToolPayload(toolResult.content)) {
            continue;
          }
          pushExample(examples, {
            timestamp: message.timestamp.toISOString(),
            filePath: 'stream',
            messageUuid: message.uuid,
            toolUseId: toolResult.toolUseId,
            toolName: toolNameByUseId.get(toolResult.toolUseId) ?? 'unknown tool',
            isSidechain: message.isSidechain,
            ...(message.agentId ? { agentId: message.agentId } : {}),
          });
        }

        const toolUseResult = message.toolUseResult;
        if (!toolUseResult) {
          continue;
        }
        const toolUseId =
          typeof toolUseResult.toolUseId === 'string'
            ? toolUseResult.toolUseId
            : message.sourceToolUseID;
        const contentIsEmpty =
          (!('content' in toolUseResult) || isEmptyToolPayload(toolUseResult.content)) &&
          (!('message' in toolUseResult) || isEmptyToolPayload(toolUseResult.message));
        if (!contentIsEmpty) {
          continue;
        }

        pushExample(examples, {
          timestamp: message.timestamp.toISOString(),
          filePath: 'stream',
          messageUuid: message.uuid,
          ...(toolUseId ? { toolUseId } : {}),
          toolName: toolUseId ? (toolNameByUseId.get(toolUseId) ?? 'unknown tool') : 'unknown tool',
          isSidechain: message.isSidechain,
          ...(message.agentId ? { agentId: message.agentId } : {}),
        });
      }
    }
  }

  return examples;
}

function buildToolNameMap(parsedMessagesByFile: Map<string, ParsedMessage[]>): Map<string, string> {
  const toolNameByUseId = new Map<string, string>();
  for (const messages of parsedMessagesByFile.values()) {
    for (const message of messages) {
      for (const toolCall of message.toolCalls) {
        toolNameByUseId.set(toolCall.id, toolCall.name);
      }
    }
  }
  return toolNameByUseId;
}

export class BoardTaskLogDiagnosticsService {
  constructor(
    private readonly taskReader: TeamTaskReader = new TeamTaskReader(),
    private readonly transcriptSourceLocator: TeamTranscriptSourceLocator = new TeamTranscriptSourceLocator(),
    private readonly recordSource: BoardTaskActivityRecordSource = new BoardTaskActivityRecordSource(),
    private readonly strictParser: BoardTaskExactLogStrictParser = new BoardTaskExactLogStrictParser(),
    private readonly streamService: BoardTaskLogStreamService = new BoardTaskLogStreamService()
  ) {}

  async diagnose(teamName: string, taskRef: string): Promise<BoardTaskLogDiagnosticsReport> {
    const normalizedRef = normalizeRequestedTaskRef(taskRef);
    const [activeTasks, deletedTasks, transcriptFiles] = await Promise.all([
      this.taskReader.getTasks(teamName),
      this.taskReader.getDeletedTasks(teamName),
      this.transcriptSourceLocator.listTranscriptFiles(teamName),
    ]);

    const tasks = [...activeTasks, ...deletedTasks];
    const task = tasks.find((candidate) => taskMatchesRef(candidate, normalizedRef));
    if (!task) {
      throw new Error(`Task "${taskRef}" was not found in team "${teamName}"`);
    }

    const records = await this.recordSource.getTaskRecords(teamName, task.id);
    const parsedMessagesByFile = await this.strictParser.parseFiles(transcriptFiles);
    const stream = await this.streamService.getTaskLogStream(teamName, task.id);

    const toolNameByUseId = buildToolNameMap(parsedMessagesByFile);
    const explicitExecutionKeys = new Set(
      records
        .filter((record) => record.linkKind === 'execution')
        .map((record) => `${record.source.messageUuid}:${record.source.toolUseId ?? ''}`)
    );
    const workIntervals = Array.isArray(task.workIntervals) ? task.workIntervals : [];

    const explicitParticipants: string[] = [];
    const explicitToolNames: string[] = [];
    for (const record of records) {
      pushUnique(explicitParticipants, buildParticipantLabel(record));
      pushUnique(explicitToolNames, record.action?.canonicalToolName);
    }

    let intervalToolResultTotal = 0;
    let boardMcpToolResultTotal = 0;
    let workerToolResultTotal = 0;
    let explicitLinkedWorkerResultTotal = 0;
    let missingExplicitWorkerResultTotal = 0;
    const missingExplicitWorkerExamples: BoardTaskLogDiagnosticExample[] = [];

    for (const [filePath, messages] of parsedMessagesByFile.entries()) {
      for (const message of messages) {
        if (message.type !== 'user' || message.toolResults.length === 0) {
          continue;
        }
        if (!isWithinWorkIntervals(message.timestamp, workIntervals)) {
          continue;
        }

        for (const toolResult of message.toolResults) {
          intervalToolResultTotal += 1;
          const toolName = toolNameByUseId.get(toolResult.toolUseId) ?? 'unknown tool';
          if (isBoardMcpToolName(toolName)) {
            boardMcpToolResultTotal += 1;
            continue;
          }

          workerToolResultTotal += 1;
          const explicitKey = `${message.uuid}:${toolResult.toolUseId}`;
          if (explicitExecutionKeys.has(explicitKey)) {
            explicitLinkedWorkerResultTotal += 1;
            continue;
          }

          missingExplicitWorkerResultTotal += 1;
          pushExample(missingExplicitWorkerExamples, {
            timestamp: message.timestamp.toISOString(),
            filePath,
            messageUuid: message.uuid,
            toolUseId: toolResult.toolUseId,
            toolName,
            isSidechain: message.isSidechain,
            ...(message.agentId ? { agentId: message.agentId } : {}),
          });
        }
      }
    }

    const diagnosis: string[] = [];
    if (transcriptFiles.length === 0) {
      diagnosis.push('No transcript files were found for this team.');
    }
    if (records.length === 0) {
      diagnosis.push('No explicit task-linked activity records were found for this task.');
    }
    if (missingExplicitWorkerResultTotal > 0) {
      diagnosis.push(
        `Only board MCP actions are explicit for part of this task history. Found ${missingExplicitWorkerResultTotal} worker tool result(s) inside task work intervals without boardTaskLinks, so Task Log Stream cannot safely include them.`
      );
    }
    if (
      missingExplicitWorkerResultTotal > 0 &&
      extractVisibleToolNames(stream).every((toolName) => isBoardMcpToolName(toolName))
    ) {
      diagnosis.push(
        'Current stream visibility matches the data gap: the visible tools are MCP board actions, while worker tools exist in transcript but are unlinked.'
      );
    }

    const emptyPayloadExamples = collectEmptyPayloadExamples(stream);
    if (emptyPayloadExamples.length > 0) {
      diagnosis.push(
        `Found ${emptyPayloadExamples.length} tool result payload(s) with empty rendered content in the current stream. This explains empty success/output blocks.`
      );
    }
    if (diagnosis.length === 0) {
      diagnosis.push('No obvious task-log data gap was detected by diagnostics.');
    }

    return {
      teamName,
      requestedTaskRef: taskRef,
      task: {
        taskId: task.id,
        displayId: getTaskDisplayId(task),
        subject: task.subject,
        status: task.status,
        ...(task.owner ? { owner: task.owner } : {}),
        workIntervals,
      },
      transcript: {
        fileCount: transcriptFiles.length,
        files: transcriptFiles,
      },
      explicitRecords: {
        total: records.length,
        execution: records.filter((record) => record.linkKind === 'execution').length,
        lifecycle: records.filter((record) => record.linkKind === 'lifecycle').length,
        boardAction: records.filter((record) => record.linkKind === 'board_action').length,
        participants: explicitParticipants,
        toolNames: explicitToolNames,
      },
      intervalToolResults: {
        total: intervalToolResultTotal,
        boardMcp: boardMcpToolResultTotal,
        worker: {
          total: workerToolResultTotal,
          explicitLinked: explicitLinkedWorkerResultTotal,
          missingExplicit: missingExplicitWorkerResultTotal,
          examples: missingExplicitWorkerExamples,
        },
      },
      stream: {
        participants: stream.participants.map((participant) => participant.label),
        defaultFilter: stream.defaultFilter,
        segmentCount: stream.segments.length,
        visibleToolNames: extractVisibleToolNames(stream),
        emptyPayloadExamples,
      },
      diagnosis,
    };
  }
}
