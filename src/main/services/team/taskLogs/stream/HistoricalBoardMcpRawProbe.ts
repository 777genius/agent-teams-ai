import { getTaskDisplayId } from '@shared/utils/taskIdentity';
import { createReadStream } from 'fs';
import * as readline from 'readline';

import type { TeamTask } from '@shared/types';

const RAW_PROBE_CONCURRENCY = process.platform === 'win32' ? 4 : 8;
const BOARD_MCP_MARKERS = [
  'mcp__agent-teams__task_',
  'mcp__agent-teams__review_',
  'mcp__agent_teams__task_',
  'mcp__agent_teams__review_',
  'agent-teams_task_',
  'agent-teams_review_',
  'agent_teams_task_',
  'agent_teams_review_',
  '"task_start"',
  '"task_complete"',
  '"task_add_comment"',
  '"task_set_status"',
  '"review_start"',
  '"review_request"',
  '"review_approve"',
  '"review_request_changes"',
];

export interface HistoricalBoardMcpRawProbeInput {
  task: TeamTask;
  transcriptFiles: readonly string[];
}

export interface HistoricalBoardMcpRawProbeResult {
  filePaths: string[];
  scannedFileCount: number;
  hitCount: number;
  elapsedMs: number;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await fn(items[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeReference(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/^#/, '').toLowerCase();
  return normalized ? normalized : null;
}

function buildRawTaskReferences(task: TeamTask): string[] {
  const refs = new Set<string>();
  for (const value of [task.id, getTaskDisplayId(task)]) {
    const normalized = normalizeReference(value);
    if (!normalized) {
      continue;
    }
    refs.add(normalized);
    refs.add(`#${normalized}`);
  }
  return [...refs].sort((left, right) => left.localeCompare(right));
}

function textHasBoardMcpMarker(lowerText: string): boolean {
  return BOARD_MCP_MARKERS.some((marker) => lowerText.includes(marker));
}

function textReferencesTask(lowerText: string, taskRefs: readonly string[]): boolean {
  return taskRefs.some((taskRef) => lowerText.includes(taskRef));
}

async function fileHasTaskBoardMcpCandidate(
  filePath: string,
  taskRefs: readonly string[]
): Promise<boolean> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let hasTaskRef = false;
  let hasBoardMarker = false;
  try {
    for await (const line of rl) {
      const lowerLine = line.toLowerCase();
      hasTaskRef = hasTaskRef || textReferencesTask(lowerLine, taskRefs);
      hasBoardMarker = hasBoardMarker || textHasBoardMcpMarker(lowerLine);
      if (hasTaskRef && hasBoardMarker) {
        return true;
      }
    }
    return false;
  } finally {
    rl.close();
    stream.destroy();
  }
}

export class HistoricalBoardMcpRawProbe {
  async findCandidateFiles(
    input: HistoricalBoardMcpRawProbeInput
  ): Promise<HistoricalBoardMcpRawProbeResult> {
    const startedAt = Date.now();
    const uniqueFiles = [...new Set(input.transcriptFiles)].sort((left, right) =>
      left.localeCompare(right)
    );
    const taskRefs = buildRawTaskReferences(input.task);
    if (uniqueFiles.length === 0 || taskRefs.length === 0) {
      return {
        filePaths: [],
        scannedFileCount: uniqueFiles.length,
        hitCount: 0,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const hits = await mapLimit(uniqueFiles, RAW_PROBE_CONCURRENCY, async (filePath) => {
      try {
        return (await fileHasTaskBoardMcpCandidate(filePath, taskRefs)) ? filePath : null;
      } catch {
        return null;
      }
    });

    const filePaths = hits.filter((filePath): filePath is string => filePath !== null);
    return {
      filePaths,
      scannedFileCount: uniqueFiles.length,
      hitCount: filePaths.length,
      elapsedMs: Date.now() - startedAt,
    };
  }
}
