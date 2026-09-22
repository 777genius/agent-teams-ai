import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs/promises';
import * as path from 'path';

const TRACE_ROOT_SEGMENT = path.join('.member-work-sync', 'runtime-hooks', 'codex-native-traces');

export interface CodexNativeTraceProjection {
  kind: 'tool_start' | 'tool_result' | 'message' | 'meta';
  toolSource?: 'mcp' | 'native';
  rawItemType?: string;
  itemId?: string;
  toolName?: string;
  status?: string;
  input?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  text?: string;
}

export interface CodexNativeTraceEvent {
  sourceOrder: number;
  receivedAt: string;
  projection: CodexNativeTraceProjection | null;
}

export interface CodexNativeTraceRun {
  filePath: string;
  runId: string;
  teamName: string | null;
  taskId: string | null;
  ownerName: string | null;
  cwd: string | null;
  startedAt: string | null;
  mtimeMs: number;
  size: number;
  events: CodexNativeTraceEvent[];
  partial: boolean;
}

interface TraceFileCandidate {
  filePath: string;
  mtimeMs: number;
  size: number;
  partial: boolean;
}

function safeSegment(value: string): string {
  const encoded = encodeURIComponent(value);
  return encoded.length > 0 && encoded.length <= 160
    ? encoded
    : `segment-${Buffer.from(value).toString('base64url').slice(0, 80)}`;
}

function tracePathSegment(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? safeSegment(trimmed) : null;
}

function isString(value: string | null): value is string {
  return typeof value === 'string';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readRawString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeIdentity(value: string | null): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

function readProjection(value: unknown): CodexNativeTraceProjection | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const kind = readString(record, 'kind');
  if (kind !== 'tool_start' && kind !== 'tool_result' && kind !== 'message' && kind !== 'meta') {
    return null;
  }
  const toolSource = readString(record, 'toolSource');
  return {
    kind,
    ...(toolSource === 'mcp' || toolSource === 'native' ? { toolSource } : {}),
    ...(readString(record, 'rawItemType')
      ? { rawItemType: readString(record, 'rawItemType')! }
      : {}),
    ...(readString(record, 'itemId') ? { itemId: readString(record, 'itemId')! } : {}),
    ...(readString(record, 'toolName') ? { toolName: readString(record, 'toolName')! } : {}),
    ...(readString(record, 'status') ? { status: readString(record, 'status')! } : {}),
    ...(asRecord(record.input) ? { input: asRecord(record.input)! } : {}),
    ...(Object.prototype.hasOwnProperty.call(record, 'result') ? { result: record.result } : {}),
    ...(typeof record.isError === 'boolean' ? { isError: record.isError } : {}),
    ...(readString(record, 'text') ? { text: readString(record, 'text')! } : {}),
  };
}

function readProjectionFromRaw(value: unknown): CodexNativeTraceProjection | null {
  const event = asRecord(value);
  const item = asRecord(event?.item);
  const eventType = readString(event ?? {}, 'type');
  const itemType = readString(item ?? {}, 'type');
  const itemId = readString(item ?? {}, 'id');
  if (!item || !itemId || (eventType !== 'item.started' && eventType !== 'item.completed')) {
    return null;
  }
  if (itemType === 'command_execution') {
    const command = readString(item, 'command') ?? '';
    const status =
      readString(item, 'status') ?? (eventType === 'item.started' ? 'in_progress' : 'unknown');
    const exitCode = readNumber(item, 'exit_code') ?? readNumber(item, 'exitCode');
    const output =
      readRawString(item, 'aggregated_output') ??
      readRawString(item, 'output') ??
      readRawString(item, 'stderr') ??
      '';
    return {
      kind: eventType === 'item.started' ? 'tool_start' : 'tool_result',
      toolSource: 'native',
      rawItemType: 'command_execution',
      itemId,
      toolName: 'Bash',
      status,
      input: { command },
      ...(eventType === 'item.completed'
        ? {
            result: {
              content: output,
              stdout:
                readRawString(item, 'aggregated_output') ?? readRawString(item, 'output') ?? '',
              stderr: readRawString(item, 'stderr') ?? '',
              exitCode,
            },
            isError:
              status === 'failed' || status === 'declined' || (exitCode !== null && exitCode !== 0),
          }
        : {}),
    };
  }
  if (itemType === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const firstChange = changes.map(asRecord).find((change) => typeof change?.path === 'string');
    return {
      kind: eventType === 'item.started' ? 'tool_start' : 'tool_result',
      toolSource: 'native',
      rawItemType: 'file_change',
      itemId,
      toolName: 'Edit',
      status:
        readString(item, 'status') ?? (eventType === 'item.started' ? 'in_progress' : 'unknown'),
      input: {
        file_path: typeof firstChange?.path === 'string' ? firstChange.path : '',
        changes,
      },
      ...(eventType === 'item.completed'
        ? {
            result: {
              content: [
                'File changes:',
                ...changes.map((change) => {
                  const row = asRecord(change);
                  return `- ${row?.path ?? '(unknown path)'} (${row?.kind ?? 'update'})`;
                }),
              ].join('\n'),
              changes,
            },
            isError: readString(item, 'status') === 'failed',
          }
        : {}),
    };
  }
  return null;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class CodexNativeTraceReader {
  constructor(private readonly teamsBasePath: string = getTeamsBasePath()) {}

  getTraceRoot(): string {
    return path.join(this.teamsBasePath, TRACE_ROOT_SEGMENT);
  }

  async readTaskRuns(params: {
    teamName: string;
    taskIds: string[];
    includeIncoming?: boolean;
  }): Promise<CodexNativeTraceRun[]> {
    const root = this.getTraceRoot();
    const rootResolved = path.resolve(root);
    const teamSegments = [...new Set([tracePathSegment(params.teamName)].filter(isString))];
    const taskSegments = [...new Set(params.taskIds.map(tracePathSegment).filter(isString))];
    const candidates: TraceFileCandidate[] = [];

    for (const teamSegment of teamSegments) {
      for (const taskSegment of taskSegments) {
        candidates.push(
          ...(await this.listTraceFiles(
            path.join(root, 'processed', teamSegment, taskSegment),
            false
          ))
        );
        if (params.includeIncoming) {
          candidates.push(
            ...(await this.listTraceFiles(
              path.join(root, 'incoming', teamSegment, taskSegment),
              true
            ))
          );
        }
      }
    }

    const uniqueCandidates = new Map<string, TraceFileCandidate>();
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate.filePath);
      if (!isPathInside(rootResolved, resolved)) {
        continue;
      }
      uniqueCandidates.set(resolved, candidate);
    }

    const parsedRuns = await Promise.all(
      [...uniqueCandidates.values()]
        .sort((left, right) => right.mtimeMs - left.mtimeMs)
        .slice(0, 10)
        .map((candidate) => this.readRun(candidate).catch(() => null))
    );
    const expectedTeamName = normalizeIdentity(params.teamName);
    const expectedTaskIds = new Set(
      params.taskIds
        .map((taskId) => normalizeIdentity(taskId))
        .filter((taskId): taskId is string => taskId !== null)
    );
    const runsById = new Map<string, CodexNativeTraceRun>();

    for (const run of parsedRuns) {
      if (!run) {
        continue;
      }
      const runTeamName = normalizeIdentity(run.teamName);
      if (runTeamName && expectedTeamName && runTeamName !== expectedTeamName) {
        continue;
      }
      const runTaskId = normalizeIdentity(run.taskId);
      if (runTaskId && expectedTaskIds.size > 0 && !expectedTaskIds.has(runTaskId)) {
        continue;
      }
      const key = `${runTeamName ?? expectedTeamName ?? 'unknown-team'}::${runTaskId ?? 'unknown-task'}::${run.runId}`;
      const existing = runsById.get(key);
      if (
        !existing ||
        (existing.partial && !run.partial) ||
        (existing.partial === run.partial && run.mtimeMs > existing.mtimeMs)
      ) {
        runsById.set(key, run);
      }
    }

    return [...runsById.values()].sort((left, right) => {
      const leftTime = Date.parse(left.startedAt ?? '');
      const rightTime = Date.parse(right.startedAt ?? '');
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.filePath.localeCompare(right.filePath);
    });
  }

  private async listTraceFiles(dir: string, partial: boolean): Promise<TraceFileCandidate[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const rows = await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.tmp'))
        )
        .map(async (entry) => {
          const filePath = path.join(dir, entry.name);
          const stat = await fs.stat(filePath).catch(() => null);
          return stat?.isFile()
            ? {
                filePath,
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                partial: partial || entry.name.endsWith('.tmp'),
              }
            : null;
        })
    );
    return rows.filter((row): row is TraceFileCandidate => row !== null);
  }

  private async readRun(candidate: TraceFileCandidate): Promise<CodexNativeTraceRun | null> {
    const raw = await fs.readFile(candidate.filePath, 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (raw === null) {
      return null;
    }
    const lines = raw.split(/\r?\n/);
    let header: Record<string, unknown> | null = null;
    const events: CodexNativeTraceEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        if (candidate.partial && index === lines.length - 1) {
          continue;
        }
        continue;
      }
      if (parsed.recordType === 'codex_native_trace_header') {
        header = parsed;
        continue;
      }
      if (parsed.recordType !== 'codex_native_stdout_event') {
        continue;
      }
      const sourceOrder =
        typeof parsed.sourceOrder === 'number' ? parsed.sourceOrder : events.length + 1;
      events.push({
        sourceOrder,
        receivedAt: readString(parsed, 'receivedAt') ?? new Date(candidate.mtimeMs).toISOString(),
        projection: readProjection(parsed.projection) ?? readProjectionFromRaw(parsed.raw),
      });
    }

    if (!header) {
      return null;
    }

    return {
      filePath: candidate.filePath,
      runId:
        readString(header, 'runId') ??
        path.basename(candidate.filePath).replace(/\.jsonl(?:\.tmp)?$/, ''),
      teamName: readString(header, 'teamName'),
      taskId: readString(header, 'taskId'),
      ownerName: readString(header, 'ownerName'),
      cwd: readString(header, 'cwd'),
      startedAt: readString(header, 'startedAt'),
      mtimeMs: candidate.mtimeMs,
      size: candidate.size,
      events: events.sort((left, right) => left.sourceOrder - right.sourceOrder),
      partial: candidate.partial,
    };
  }
}
