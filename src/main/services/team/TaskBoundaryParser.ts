import { createLogger } from '@shared/utils/logger';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import * as readline from 'readline';

import {
  canonicalizeAgentTeamsToolName,
  isAgentTeamsTaskBoundaryToolName,
} from './agentTeamsToolNames';

import type {
  TaskBoundariesResult,
  TaskBoundary,
  TaskChangeScope,
  TaskScopeConfidence,
} from '@shared/types';

const logger = createLogger('Service:TaskBoundaryParser');

type TaskBoundaryEvent = 'start' | 'complete' | null;

/** Файл-модифицирующие инструменты, которые включаем в scope.toolUseIds */
const FILE_MODIFYING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Кеш-запись: данные + mtime файла + время протухания */
interface BoundaryCacheEntry {
  data: TaskBoundariesResult;
  mtime: number;
  expiresAt: number;
}

/** Информация о tool_use блоке собранная при парсинге */
interface ToolUseInfo {
  toolUseId: string;
  toolName: string;
  filePath?: string;
}

type DetectedMechanism = 'TaskUpdate' | 'mcp' | 'none';

function extractTaskId(input: Record<string, unknown>): string {
  const rawTaskId = input.taskId ?? input.task_id;
  if (typeof rawTaskId === 'string') return rawTaskId;
  if (typeof rawTaskId === 'number') return String(rawTaskId);
  return '';
}

function pickDetectedMechanism(
  current: DetectedMechanism,
  next: Exclude<DetectedMechanism, 'none'>
): DetectedMechanism {
  const priority = {
    none: 0,
    TaskUpdate: 1,
    mcp: 2,
  } as const;
  return priority[next] > priority[current] ? next : current;
}

export class TaskBoundaryParser {
  private cache = new Map<string, BoundaryCacheEntry>();
  private readonly cacheTtl = 60 * 1000; // 60s

  /** Парсинг JSONL файла для обнаружения границ задач */
  async parseBoundaries(filePath: string): Promise<TaskBoundariesResult> {
    // 1. Проверяем кеш (TTL + mtime)
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch (err) {
      logger.debug(`Cannot stat file ${filePath}: ${String(err)}`);
      return { boundaries: [], scopes: [], isSingleTaskSession: true, detectedMechanism: 'none' };
    }

    const cached = this.cache.get(filePath);
    if (cached?.mtime === fileStat.mtimeMs && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    // 2. Стриминг JSONL
    const boundaries: TaskBoundary[] = [];
    const allToolUsesByLine = new Map<number, ToolUseInfo[]>();
    let lineNumber = 0;
    let detectedMechanism: DetectedMechanism = 'none';

    try {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        lineNumber++;
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const entry = JSON.parse(trimmed) as Record<string, unknown>;
          const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : '';

          const content = this.extractContent(entry);
          if (!Array.isArray(content)) continue;

          // Собираем ВСЕ tool_use блоки для scope tracking
          for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            const b = block as Record<string, unknown>;
            if (b.type !== 'tool_use') continue;
            const rawName = typeof b.name === 'string' ? b.name : '';
            const toolName = canonicalizeAgentTeamsToolName(rawName);
            const toolUseId = typeof b.id === 'string' ? b.id : '';
            const input = b.input as Record<string, unknown> | undefined;
            const fp = typeof input?.file_path === 'string' ? input.file_path : undefined;
            if (!allToolUsesByLine.has(lineNumber)) allToolUsesByLine.set(lineNumber, []);
            allToolUsesByLine.get(lineNumber)!.push({ toolUseId, toolName, filePath: fp });
          }

          // Prefer structured task markers for modern runtime sessions.
          const taskUpdateBounds = this.extractTaskUpdateBoundaries(content, lineNumber, timestamp);
          if (taskUpdateBounds.length > 0) {
            detectedMechanism = pickDetectedMechanism(detectedMechanism, 'TaskUpdate');
            boundaries.push(...taskUpdateBounds);
            continue;
          }

          const mcpBounds = this.extractMcpTaskBoundaries(content, lineNumber, timestamp);
          if (mcpBounds.length > 0) {
            detectedMechanism = pickDetectedMechanism(detectedMechanism, 'mcp');
            boundaries.push(...mcpBounds);
            continue;
          }
        } catch {
          // Пропускаем невалидные строки
        }
      }

      rl.close();
      stream.destroy();
    } catch (err) {
      logger.debug(`Error reading file ${filePath}: ${String(err)}`);
    }

    // 3. Вычисляем scopes
    const scopes = this.computeScopes(boundaries, allToolUsesByLine, lineNumber);
    const uniqueTaskIds = new Set(boundaries.map((b) => b.taskId));
    const isSingleTaskSession = uniqueTaskIds.size <= 1;

    const result: TaskBoundariesResult = {
      boundaries,
      scopes,
      isSingleTaskSession,
      detectedMechanism,
    };
    this.cache.set(filePath, {
      data: result,
      mtime: fileStat.mtimeMs,
      expiresAt: Date.now() + this.cacheTtl,
    });
    return result;
  }

  /** Получить scope для конкретной задачи */
  async getTaskScope(filePath: string, taskId: string): Promise<TaskChangeScope | null> {
    const result = await this.parseBoundaries(filePath);
    return result.scopes.find((s) => s.taskId === taskId) ?? null;
  }

  /** Очистить кеш (для тестов) */
  clearCache(): void {
    this.cache.clear();
  }

  // ── Приватные методы ──

  /** Извлечь content array из JSONL entry (оба формата: subagent и main) */
  private extractContent(entry: Record<string, unknown>): unknown[] | null {
    const message = entry.message as Record<string, unknown> | undefined;
    if (message && Array.isArray(message.content)) return message.content as unknown[];
    if (Array.isArray(entry.content)) return entry.content as unknown[];
    return null;
  }

  /**
   * Найти TaskUpdate/proxy_TaskUpdate tool_use блоки.
   * status: in_progress → start, completed → complete
   */
  private extractTaskUpdateBoundaries(
    content: unknown[],
    lineNumber: number,
    timestamp: string
  ): TaskBoundary[] {
    const results: TaskBoundary[] = [];

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_use') continue;

      const rawName = typeof b.name === 'string' ? b.name : '';
      const toolName = rawName.replace(/^proxy_/, '');
      if (toolName !== 'TaskUpdate') continue;

      const input = b.input as Record<string, unknown> | undefined;
      if (!input) continue;

      const taskId = extractTaskId(input);
      if (!taskId) continue;

      const status = typeof input.status === 'string' ? input.status : '';
      let event: TaskBoundaryEvent = null;
      if (status === 'in_progress') event = 'start';
      else if (status === 'completed') event = 'complete';

      if (event) {
        const toolUseId = typeof b.id === 'string' ? b.id : undefined;
        results.push({
          taskId,
          event,
          lineNumber,
          timestamp,
          mechanism: 'TaskUpdate',
          toolUseId,
        });
      }
    }

    return results;
  }

  /**
   * Find MCP task tools that mark task boundaries.
   */
  private extractMcpTaskBoundaries(
    content: unknown[],
    lineNumber: number,
    timestamp: string
  ): TaskBoundary[] {
    const results: TaskBoundary[] = [];

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_use') continue;

      const rawName = typeof b.name === 'string' ? b.name : '';
      const toolName = canonicalizeAgentTeamsToolName(rawName);
      if (!isAgentTeamsTaskBoundaryToolName(toolName)) continue;

      const input = b.input as Record<string, unknown> | undefined;
      if (!input) continue;

      const taskId = extractTaskId(input);
      if (!taskId) continue;

      let event: TaskBoundaryEvent = null;
      if (toolName === 'task_start') event = 'start';
      else if (toolName === 'task_complete') event = 'complete';
      else {
        const status = typeof input.status === 'string' ? input.status : '';
        if (status === 'in_progress') event = 'start';
        else if (status === 'completed') event = 'complete';
      }

      if (event) {
        const toolUseId = typeof b.id === 'string' ? b.id : undefined;
        results.push({
          taskId,
          event,
          lineNumber,
          timestamp,
          mechanism: 'mcp',
          toolUseId,
        });
      }
    }

    return results;
  }

  /**
   * Вычислить scopes для каждой задачи на основе границ.
   *
   * Tier 1 (high): обе границы (start + complete)
   * Tier 2 (medium): только start (end = конец файла)
   * Tier 3 (low): только complete (start = начало файла)
   * Tier 4 (fallback): нет границ (весь файл)
   */
  private computeScopes(
    boundaries: TaskBoundary[],
    allToolUsesByLine: Map<number, ToolUseInfo[]>,
    totalLines: number
  ): TaskChangeScope[] {
    // Группируем по taskId
    const byTask = new Map<string, TaskBoundary[]>();
    for (const b of boundaries) {
      if (!byTask.has(b.taskId)) byTask.set(b.taskId, []);
      byTask.get(b.taskId)!.push(b);
    }

    const scopes: TaskChangeScope[] = [];

    for (const [taskId, taskBoundaries] of byTask) {
      const starts = taskBoundaries.filter((b) => b.event === 'start');
      const completes = taskBoundaries.filter((b) => b.event === 'complete');

      const hasStart = starts.length > 0;
      const hasComplete = completes.length > 0;

      // Определяем границы строк
      let startLine: number;
      let endLine: number;
      let startTimestamp: string;
      let endTimestamp: string;
      let confidence: TaskScopeConfidence;

      if (hasStart && hasComplete) {
        // Tier 1: обе границы
        const firstStart = starts.reduce(
          (a, b) => (a.lineNumber < b.lineNumber ? a : b),
          starts[0]
        );
        const lastComplete = completes.reduce(
          (a, b) => (a.lineNumber > b.lineNumber ? a : b),
          completes[0]
        );
        startLine = firstStart.lineNumber;
        endLine = lastComplete.lineNumber;
        startTimestamp = firstStart.timestamp;
        endTimestamp = lastComplete.timestamp;
        confidence = { tier: 1, label: 'high', reason: 'Both start and complete markers found' };
      } else if (hasStart) {
        // Tier 2: только start
        const firstStart = starts.reduce(
          (a, b) => (a.lineNumber < b.lineNumber ? a : b),
          starts[0]
        );
        startLine = firstStart.lineNumber;
        endLine = totalLines;
        startTimestamp = firstStart.timestamp;
        endTimestamp = '';
        confidence = {
          tier: 2,
          label: 'medium',
          reason: 'Only start marker found, end assumed at file end',
        };
      } else {
        // Tier 3: только complete
        const lastComplete = completes.reduce(
          (a, b) => (a.lineNumber > b.lineNumber ? a : b),
          completes[0]
        );
        startLine = 1;
        endLine = lastComplete.lineNumber;
        startTimestamp = '';
        endTimestamp = lastComplete.timestamp;
        confidence = {
          tier: 3,
          label: 'low',
          reason: 'Only complete marker found, start assumed at file beginning',
        };
      }

      // Собираем tool_use IDs в диапазоне [startLine, endLine], только файл-модифицирующие
      const toolUseIds: string[] = [];
      const filePaths = new Set<string>();

      for (const [line, tools] of allToolUsesByLine) {
        if (line < startLine || line > endLine) continue;
        for (const tool of tools) {
          if (FILE_MODIFYING_TOOLS.has(tool.toolName) && tool.toolUseId) {
            toolUseIds.push(tool.toolUseId);
            if (tool.filePath) filePaths.add(tool.filePath);
          }
        }
      }

      scopes.push({
        taskId,
        memberName: '', // будет заполнен вызывающим кодом
        startLine,
        endLine,
        startTimestamp,
        endTimestamp,
        toolUseIds,
        filePaths: [...filePaths],
        confidence,
      });
    }

    return scopes;
  }
}
