# Phase 3: Per-Task Change Scoping

## Цель
Точно определять какие файловые изменения принадлежат конкретной задаче (task). Текущий `findLogsForTask()` использует keyword search (~60% reliability). Phase 3 добавляет структурный парсинг `TaskUpdate` tool_use блоков для 95%+ reliability.

## Зависимости (npm)
Нет новых npm зависимостей. Используем только существующие: readline, fs/promises.

---

## Backend

### 1. Типы: `src/shared/types/review.ts` (MODIFY — дополнения к Phase 1+2)

```typescript
/** Обнаруженная граница задачи в JSONL */
export interface TaskBoundary {
  taskId: string;
  event: 'start' | 'complete';
  /** Номер строки в JSONL файле (для debug) */
  lineNumber: number;
  /** ISO timestamp из JSONL entry */
  timestamp: string;
  /** Каким механизмом обнаружено */
  mechanism: 'TaskUpdate' | 'teamctl';
  /** tool_use id (для link к конкретному блоку) */
  toolUseId?: string;
}

/** Scope изменений для одной задачи */
export interface TaskChangeScope {
  taskId: string;
  /** Имя участника (owner) */
  memberName: string;
  /** Начало scope (строка JSONL или timestamp) */
  startLine: number;
  endLine: number;
  startTimestamp: string;
  endTimestamp: string;
  /** Все tool_use.id в пределах scope */
  toolUseIds: string[];
  /** Файлы затронутые в scope */
  filePaths: string[];
  /** Уровень уверенности */
  confidence: TaskScopeConfidence;
}

/** Детализированный уровень уверенности */
export interface TaskScopeConfidence {
  tier: 1 | 2 | 3 | 4;
  label: 'high' | 'medium' | 'low' | 'fallback';
  reason: string;
}

/** Результат парсинга всех границ задач из JSONL файла */
export interface TaskBoundariesResult {
  /** Все найденные границы, отсортированные по lineNumber */
  boundaries: TaskBoundary[];
  /** Scopes per task */
  scopes: TaskChangeScope[];
  /** True если сессия работала только с одной задачей */
  isSingleTaskSession: boolean;
  /** Механизм обнаружения (один на сессию — никогда не смешиваются!) */
  detectedMechanism: 'TaskUpdate' | 'teamctl' | 'none';
}

/** Расширенный TaskChangeSet с confidence деталями.
 *  TaskChangeSet определён в Phase 1 (review.ts) — backwards compatible extension.
 *  Все Phase 1 поля (teamName, taskId, files, confidence, computedAt) сохраняются.
 */
export interface TaskChangeSetV2 extends TaskChangeSet {
  scope: TaskChangeScope;
  /** Предупреждения для UI */
  warnings: string[];
}
```

### 2. Сервис: `src/main/services/team/TaskBoundaryParser.ts` (NEW)

**Задача**: Парсить JSONL файлы субагентов для извлечения `TaskUpdate` и `teamctl` маркеров задач.

**Ключевой факт**: Механизмы НИКОГДА не смешиваются в одной сессии (0 из 351 проверенных). Это означает один pass по JSONL для определения механизма + extraction.

```typescript
import { createReadStream } from 'fs';
import * as readline from 'readline';

export class TaskBoundaryParser {
  private cache = new Map<string, { data: TaskBoundariesResult; mtime: number; expiresAt: number }>();
  private readonly CACHE_TTL = 60 * 1000; // 1 мин (не 3 — JSONL файлы меняются часто при активной работе)

  /**
   * Парсит JSONL файл и извлекает все TaskUpdate/teamctl маркеры.
   *
   * Один проход по файлу, O(n) по количеству строк.
   */
  async parseBoundaries(filePath: string): Promise<TaskBoundariesResult>;

  /**
   * Определяет scope изменений для конкретной задачи.
   *
   * Алгоритм:
   * 1. Найти все TaskBoundary для taskId
   * 2. Start boundary = TaskUpdate(in_progress) или teamctl(start)
   * 3. End boundary = TaskUpdate(completed) или teamctl(complete)
   * 4. Scope = все tool_use между start.lineNumber и end.lineNumber
   * 5. Если single-task session: scope = весь файл
   */
  async getTaskScope(filePath: string, taskId: string): Promise<TaskChangeScope | null>;
}
```

**Парсинг TaskUpdate (Mechanism A — 86% сессий):**

```typescript
// В assistant entry ищем tool_use блоки
// entry.message.content = ContentBlock[]
// где ContentBlock = { type: 'tool_use', name: 'TaskUpdate' | 'proxy_TaskUpdate', input: {...} }

private extractTaskUpdateBoundaries(
  content: unknown[],
  lineNumber: number,
  timestamp: string
): TaskBoundary[] {
  const boundaries: TaskBoundary[] = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;

    if (b.type !== 'tool_use') continue;

    // Strip proxy_ prefix (паттерн из MemberStatsComputer)
    const rawName = typeof b.name === 'string' ? b.name : '';
    const toolName = rawName.replace(/^proxy_/, '');

    if (toolName !== 'TaskUpdate') continue;

    const input = b.input as Record<string, unknown> | undefined;
    if (!input) continue;

    const taskId = String(input.taskId ?? input.task_id ?? '');
    const status = String(input.status ?? '');

    if (!taskId) continue;

    // Map status → event
    let event: 'start' | 'complete' | null = null;
    if (status === 'in_progress') event = 'start';
    if (status === 'completed') event = 'complete';

    if (event) {
      boundaries.push({
        taskId,
        event,
        lineNumber,
        timestamp,
        mechanism: 'TaskUpdate',
        toolUseId: typeof b.id === 'string' ? b.id : undefined,
      });
    }
  }

  return boundaries;
}
```

**Парсинг teamctl Bash (Mechanism B — 12.5% сессий):**

```typescript
// В assistant entry ищем tool_use с name='Bash' или 'proxy_Bash'
// input.command содержит teamctl вызов

private readonly TEAMCTL_REGEX = /task\s+(start|complete|set-status)\s+(\d+)/;

private extractTeamctlBoundaries(
  content: unknown[],
  lineNumber: number,
  timestamp: string
): TaskBoundary[] {
  const boundaries: TaskBoundary[] = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_use') continue;

    const rawName = typeof b.name === 'string' ? b.name : '';
    const toolName = rawName.replace(/^proxy_/, '');

    if (toolName !== 'Bash') continue;

    const input = b.input as Record<string, unknown> | undefined;
    const command = typeof input?.command === 'string' ? input.command : '';

    if (!command.includes('teamctl')) continue;

    const match = command.match(this.TEAMCTL_REGEX);
    if (!match) continue;

    const [, action, taskId] = match;
    let event: 'start' | 'complete' | null = null;
    if (action === 'start') event = 'start';
    if (action === 'complete') event = 'complete';
    // set-status может быть start или complete — нужно дополнительно парсить аргумент
    if (action === 'set-status') {
      if (command.includes('in_progress')) event = 'start';
      if (command.includes('completed')) event = 'complete';
    }

    if (event) {
      boundaries.push({
        taskId,
        event,
        lineNumber,
        timestamp,
        mechanism: 'teamctl',
        toolUseId: typeof b.id === 'string' ? b.id : undefined,
      });
    }
  }

  return boundaries;
}
```

**Основной проход парсинга:**

```typescript
async parseBoundaries(filePath: string): Promise<TaskBoundariesResult> {
  // Check cache (S2 fix: проверяем И TTL И mtime файла)
  const stat = await import('fs/promises').then(f => f.stat(filePath));
  const cached = this.cache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const boundaries: TaskBoundary[] = [];
  const allToolUsesByLine = new Map<number, { toolUseId: string; toolName: string; filePath?: string }[]>();
  let lineNumber = 0;
  let detectedMechanism: 'TaskUpdate' | 'teamctl' | 'none' = 'none';

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    lineNumber++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : '';

      // Extract content array
      const content = this.extractContent(entry);
      if (!Array.isArray(content)) continue;

      // Collect ALL tool_use blocks (for scope tracking)
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_use') continue;

        const rawName = typeof b.name === 'string' ? b.name : '';
        const toolName = rawName.replace(/^proxy_/, '');
        const toolUseId = typeof b.id === 'string' ? b.id : '';
        const input = b.input as Record<string, unknown> | undefined;
        const fp = typeof input?.file_path === 'string' ? input.file_path : undefined;

        if (!allToolUsesByLine.has(lineNumber)) allToolUsesByLine.set(lineNumber, []);
        allToolUsesByLine.get(lineNumber)!.push({ toolUseId, toolName, filePath: fp });
      }

      // Try TaskUpdate extraction
      const taskUpdateBounds = this.extractTaskUpdateBoundaries(content, lineNumber, timestamp);
      if (taskUpdateBounds.length > 0) {
        detectedMechanism = 'TaskUpdate';
        boundaries.push(...taskUpdateBounds);
        continue; // Skip teamctl check (never mixed)
      }

      // Try teamctl extraction
      const teamctlBounds = this.extractTeamctlBoundaries(content, lineNumber, timestamp);
      if (teamctlBounds.length > 0) {
        detectedMechanism = 'teamctl';
        boundaries.push(...teamctlBounds);
      }
    } catch {
      // Skip malformed lines
    }
  }

  rl.close();
  stream.destroy();

  // Determine scopes from boundaries
  const scopes = this.computeScopes(boundaries, allToolUsesByLine, lineNumber);
  const uniqueTaskIds = new Set(boundaries.map(b => b.taskId));
  const isSingleTaskSession = uniqueTaskIds.size <= 1;

  const result: TaskBoundariesResult = {
    boundaries,
    scopes,
    isSingleTaskSession,
    detectedMechanism,
  };

  this.cache.set(filePath, { data: result, mtime: stat.mtimeMs, expiresAt: Date.now() + this.CACHE_TTL });
  return result;
}
```

**Вычисление scopes:**

```typescript
private computeScopes(
  boundaries: TaskBoundary[],
  allToolUses: Map<number, { toolUseId: string; toolName: string; filePath?: string }[]>,
  totalLines: number
): TaskChangeScope[] {
  // Группируем по taskId
  const byTask = new Map<string, TaskBoundary[]>();
  for (const b of boundaries) {
    if (!byTask.has(b.taskId)) byTask.set(b.taskId, []);
    byTask.get(b.taskId)!.push(b);
  }

  const scopes: TaskChangeScope[] = [];

  for (const [taskId, taskBounds] of byTask) {
    const starts = taskBounds.filter(b => b.event === 'start').sort((a, b) => a.lineNumber - b.lineNumber);
    const ends = taskBounds.filter(b => b.event === 'complete').sort((a, b) => a.lineNumber - b.lineNumber);

    let startLine: number;
    let endLine: number;
    let confidence: TaskScopeConfidence;

    if (starts.length > 0 && ends.length > 0) {
      // Tier 1: Оба маркера найдены
      startLine = starts[0].lineNumber;
      endLine = ends[ends.length - 1].lineNumber;
      confidence = {
        tier: 1,
        label: 'high',
        reason: `Found ${starts.length} start + ${ends.length} complete markers via ${starts[0].mechanism}`,
      };
    } else if (starts.length > 0) {
      // Tier 2: Только start (задача ещё не завершена или маркер потерян)
      startLine = starts[0].lineNumber;
      endLine = totalLines;
      confidence = {
        tier: 2,
        label: 'medium',
        reason: `Found start marker but no completion. Using end of file.`,
      };
    } else if (ends.length > 0) {
      // Tier 3: Только end (start потерян)
      startLine = 1;
      endLine = ends[ends.length - 1].lineNumber;
      confidence = {
        tier: 3,
        label: 'low',
        reason: `Found completion marker but no start. Using beginning of file.`,
      };
    } else {
      // Tier 4: Нет маркеров (не должно случаться если boundaries найдены)
      continue;
    }

    // Collect tool_use IDs in range
    const toolUseIds: string[] = [];
    const filePaths = new Set<string>();

    for (const [line, tools] of allToolUses) {
      if (line >= startLine && line <= endLine) {
        for (const t of tools) {
          // Только file-modifying tools
          if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(t.toolName)) {
            toolUseIds.push(t.toolUseId);
            if (t.filePath) filePaths.add(t.filePath);
          }
        }
      }
    }

    scopes.push({
      taskId,
      memberName: '', // Заполняется вызывающим кодом из member attribution
      startLine,
      endLine,
      startTimestamp: starts[0]?.timestamp ?? ends[0]?.timestamp ?? '',
      endTimestamp: ends[ends.length - 1]?.timestamp ?? starts[starts.length - 1]?.timestamp ?? '',
      toolUseIds,
      filePaths: [...filePaths],
      confidence,
    });
  }

  return scopes;
}
```

**extractContent helper (паттерн из MemberStatsComputer + FIXED для всех JSONL форматов):**

```typescript
// JSONL файлы содержат СМЕШАННЫЕ форматы entries:
// 1. Subagent assistant: entry.message.content = ContentBlock[]
// 2. Main assistant: entry.content = ContentBlock[]
// 3. tool_result entries: entry.content = string | ContentBlock[]
// 4. Meta entries (file-history-snapshot): нет content с tool_use
//
// TaskUpdate блоки находятся ТОЛЬКО в assistant entries (1, 2),
// поэтому проверяем оба формата.

private extractContent(entry: Record<string, unknown>): unknown[] | null {
  // Subagent format: entry.message.content
  const message = entry.message as Record<string, unknown> | undefined;
  if (message && Array.isArray(message.content)) {
    return message.content;
  }
  // Main format: entry.content (array)
  if (Array.isArray(entry.content)) {
    return entry.content;
  }
  return null;
}
```

### 3. Модификация: `src/main/services/team/ChangeExtractorService.ts` (MODIFY)

Phase 1 создал `getTaskChanges()` с keyword-based scoping. Phase 3 заменяет на structure-based.

**CRITICAL FIX (C6+C7): `MemberLogSummary` НЕ имеет поля `filePath`!**

Реальный тип `MemberLogSummary` — это union `MemberSubagentLogSummary | MemberLeadSessionLogSummary`.
Базовые поля: `kind`, `sessionId`, `projectId`, `description`, `memberName` (string | null), `startTime`, `durationMs`, `messageCount`, `isOngoing`.
**НЕТ поля `filePath`!**

Также метод `getAllSessionLogs()` **НЕ существует** в `TeamMemberLogsFinder`.

**Решение**: Ввести внутренний тип `LogFileRef` и новый метод `resolveLogPaths()`:

```typescript
/** Внутренний тип — НЕ экспортируется из модуля */
interface LogFileRef {
  filePath: string;
  memberName: string;  // always string (fallback: 'unknown')
}

/**
 * Конвертирует MemberLogSummary → LogFileRef.
 * Используем существующий findMemberLogPaths() для получения файловых путей.
 */
private async resolveLogFileRefs(
  teamName: string,
  logs: MemberLogSummary[]
): Promise<LogFileRef[]> {
  const refs: LogFileRef[] = [];
  // Группируем по memberName для batch resolve
  const byMember = new Map<string, MemberLogSummary[]>();
  for (const log of logs) {
    const name = log.memberName ?? 'unknown';
    if (!byMember.has(name)) byMember.set(name, []);
    byMember.get(name)!.push(log);
  }

  for (const [memberName, memberLogs] of byMember) {
    const paths = await this.logsFinder.findMemberLogPaths(teamName, memberName);
    // Match paths to logs by sessionId
    for (const log of memberLogs) {
      const matchedPath = paths.find(p =>
        log.kind === 'subagent'
          ? p.includes(log.sessionId) && p.includes(log.subagentId)
          : p.includes(log.sessionId) && p.endsWith('.jsonl')
      );
      if (matchedPath) {
        refs.push({ filePath: matchedPath, memberName });
      }
    }
  }
  return refs;
}
```

**Constructor (Phase 3 добавляет TaskBoundaryParser зависимость):**

```typescript
export class ChangeExtractorService {
  private cache = new Map<string, { data: AgentChangeSet; expiresAt: number }>();
  private readonly CACHE_TTL = 60 * 1000; // 1 мин (совпадает с TaskBoundaryParser)

  constructor(
    private readonly logsFinder: TeamMemberLogsFinder,
    private readonly boundaryParser: TaskBoundaryParser  // Phase 3 addition
  ) {}

  // ... Phase 1 methods (getAgentChanges, getChangeStats) remain unchanged ...
}
```

**Методы extractFilteredChanges и extractAllChanges (используют LogFileRef, НЕ MemberLogSummary):**

```typescript
/**
 * Извлечь изменения ТОЛЬКО для указанных tool_use IDs.
 * Парсит JSONL, находит Edit/Write/MultiEdit блоки, фильтрует по allowedIds.
 *
 * IMPORTANT: принимает LogFileRef[] (НЕ MemberLogSummary[]) — у MemberLogSummary нет filePath!
 */
private async extractFilteredChanges(
  logRefs: LogFileRef[],
  allowedToolUseIds: Set<string>
): Promise<FileChangeSummary[]> {
  const fileMap = new Map<string, FileChangeSummary>();
  const shouldFilter = allowedToolUseIds.size > 0;

  for (const ref of logRefs) {
    const stream = createReadStream(ref.filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue; // Пропускаем повреждённые строки
        }

        const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : '';

        // Извлекаем content (тот же паттерн что в parseBoundaries — extractContent)
        const message = entry.message as Record<string, unknown> | undefined;
        let content: unknown[] | null = null;
        if (message && Array.isArray(message.content)) {
          content = message.content;
        } else if (Array.isArray(entry.content)) {
          content = entry.content;
        }
        if (!content) continue;

        // Ищем tool_use блоки с file-modifying tools
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type !== 'tool_use') continue;

          const rawName = typeof b.name === 'string' ? b.name : '';
          const toolName = rawName.replace(/^proxy_/, '');

          // Только file-modifying tools
          if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) continue;

          const toolUseId = typeof b.id === 'string' ? b.id : '';

          // Фильтрация по allowedToolUseIds (если scope задан)
          if (shouldFilter && !allowedToolUseIds.has(toolUseId)) continue;

          const input = b.input as Record<string, unknown> | undefined;
          if (!input) continue;

          const filePath = typeof input.file_path === 'string' ? input.file_path : '';
          if (!filePath) continue;

          // Инициализируем FileChangeSummary если ещё нет
          if (!fileMap.has(filePath)) {
            fileMap.set(filePath, {
              filePath,
              relativePath: filePath.split('/').slice(-3).join('/'), // Последние 3 сегмента
              snippets: [],
              linesAdded: 0,
              linesRemoved: 0,
            });
          }
          const summary = fileMap.get(filePath)!;

          if (toolName === 'Edit') {
            const oldString = typeof input.old_string === 'string' ? input.old_string : '';
            const newString = typeof input.new_string === 'string' ? input.new_string : '';
            const replaceAll = input.replace_all === true;

            summary.snippets.push({
              toolUseId,
              toolName: 'Edit',
              oldString,
              newString,
              type: 'edit',
              timestamp,
              replaceAll,
            });

            // Подсчёт строк
            const addedLines = newString.split('\n').length;
            const removedLines = oldString.split('\n').length;
            summary.linesAdded += Math.max(0, addedLines - removedLines);
            summary.linesRemoved += Math.max(0, removedLines - addedLines);
          } else if (toolName === 'Write') {
            const content = typeof input.content === 'string' ? input.content : '';
            // Write: если файл уже встречался в fileMap — это update, иначе new
            const isNew = summary.snippets.length === 0;

            summary.snippets.push({
              toolUseId,
              toolName: 'Write',
              oldString: '',
              newString: content,
              type: isNew ? 'write-new' : 'write-update',
              timestamp,
              replaceAll: false,
            });

            summary.linesAdded += content.split('\n').length;
          } else if (toolName === 'MultiEdit') {
            const edits = Array.isArray(input.edits) ? input.edits : [];

            for (const edit of edits) {
              if (!edit || typeof edit !== 'object') continue;
              const e = edit as Record<string, unknown>;
              const oldString = typeof e.old_string === 'string' ? e.old_string : '';
              const newString = typeof e.new_string === 'string' ? e.new_string : '';

              summary.snippets.push({
                toolUseId,
                toolName: 'MultiEdit',
                oldString,
                newString,
                type: 'multi-edit',
                timestamp,
                replaceAll: false,
              });

              const addedLines = newString.split('\n').length;
              const removedLines = oldString.split('\n').length;
              summary.linesAdded += Math.max(0, addedLines - removedLines);
              summary.linesRemoved += Math.max(0, removedLines - addedLines);
            }
          }
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  return [...fileMap.values()];
}

/**
 * Извлечь ВСЕ изменения из одного JSONL файла (без фильтрации).
 * Используется для single-task sessions и Tier 4 fallback.
 */
private async extractAllChanges(filePath: string, memberName: string = 'unknown'): Promise<FileChangeSummary[]> {
  return this.extractFilteredChanges(
    [{ filePath, memberName }],
    new Set() // empty set + shouldFilter=false → accept all
  );
}
```

**Phase 3 (новая реализация getTaskChanges):**

```typescript
async getTaskChanges(teamName: string, taskId: string): Promise<TaskChangeSetV2> {
  // 1. Найти MemberLogSummary через logsFinder (реальный API)
  const logs = await this.logsFinder.findLogsForTask(teamName, taskId);

  // 2. Конвертировать в LogFileRef (MemberLogSummary НЕ имеет filePath!)
  const logRefs = await this.resolveLogFileRefs(teamName, logs);
  if (logRefs.length === 0) {
    return this.emptyTaskChangeSet(teamName, taskId);
  }

  // 3. Для каждого JSONL — парсить boundaries через TaskBoundaryParser
  const allScopes: TaskChangeScope[] = [];
  for (const ref of logRefs) {
    const boundaries = await this.boundaryParser.parseBoundaries(ref.filePath);
    const scope = boundaries.scopes.find(s => s.taskId === taskId);
    if (scope) {
      // CRITICAL: НЕ мутируем scope напрямую — он из кеша TaskBoundaryParser!
      // Мутация scope.memberName = ... портит кешированный объект при повторных вызовах.
      const scopeCopy = { ...scope, memberName: ref.memberName };
      allScopes.push(scopeCopy);
    }
  }

  // 4. Если нет structural scopes → fallback на single-task assumption
  if (allScopes.length === 0) {
    return this.fallbackSingleTaskScope(teamName, taskId, logRefs);
  }

  // 5. Фильтровать snippets по tool_use IDs из scope
  const allowedToolUseIds = new Set(allScopes.flatMap(s => s.toolUseIds));
  const files = await this.extractFilteredChanges(logRefs, allowedToolUseIds);

  // 5. Compute confidence (worst case across all scopes)
  const worstTier = Math.max(...allScopes.map(s => s.confidence.tier));

  const warnings: string[] = [];
  if (worstTier >= 3) {
    warnings.push('Some task boundaries could not be precisely determined.');
  }

  return {
    teamName,
    taskId,
    files,
    totalLinesAdded: files.reduce((sum, f) => sum + f.linesAdded, 0),
    totalLinesRemoved: files.reduce((sum, f) => sum + f.linesRemoved, 0),
    totalFiles: files.length,
    confidence: worstTier <= 1 ? 'high' : worstTier <= 2 ? 'medium' : 'low',
    computedAt: new Date().toISOString(),
    scope: allScopes[0], // Primary scope
    warnings,
  };
}
```

**Fallback для single-task sessions (86% случаев):**

```typescript
private async fallbackSingleTaskScope(
  teamName: string,
  taskId: string,
  logRefs: LogFileRef[]  // C6 fix: LogFileRef вместо MemberLogSummary
): Promise<TaskChangeSetV2> {
  // Проверяем: если agent работал только над одной задачей,
  // ВСЕ изменения в сессии = изменения этой задачи

  for (const ref of logRefs) {
    const boundaries = await this.boundaryParser.parseBoundaries(ref.filePath);

    if (boundaries.isSingleTaskSession) {
      // Весь файл = одна задача → extract все changes
      const files = await this.extractAllChanges(ref.filePath, ref.memberName);
      return {
        teamName,
        taskId,
        files,
        totalLinesAdded: files.reduce((sum, f) => sum + f.linesAdded, 0),
        totalLinesRemoved: files.reduce((sum, f) => sum + f.linesRemoved, 0),
        totalFiles: files.length,
        confidence: 'high',
        computedAt: new Date().toISOString(),
        scope: {
          taskId,
          memberName: ref.memberName,
          startLine: 1,
          endLine: Infinity,
          startTimestamp: '',
          endTimestamp: '',
          toolUseIds: [],
          filePaths: [],
          confidence: { tier: 1, label: 'high', reason: 'Single-task session (entire session = task)' },
        },
        warnings: [],
      };
    }
  }

  // No single-task session found → Tier 4 fallback
  const firstRef = logRefs[0];
  const files = firstRef ? await this.extractAllChanges(firstRef.filePath, firstRef.memberName) : [];
  return {
    teamName,
    taskId,
    files,
    totalLinesAdded: files.reduce((sum, f) => sum + f.linesAdded, 0),
    totalLinesRemoved: files.reduce((sum, f) => sum + f.linesRemoved, 0),
    totalFiles: files.length,
    confidence: 'low',
    computedAt: new Date().toISOString(),
    scope: {
      taskId,
      memberName: firstRef?.memberName ?? 'unknown',
      startLine: 1,
      endLine: Infinity,
      startTimestamp: '',
      endTimestamp: '',
      toolUseIds: [],
      filePaths: [],
      confidence: { tier: 4, label: 'fallback', reason: 'No task markers found. Showing all session changes.' },
    },
    warnings: ['Could not determine task boundaries. Showing all changes from this session.'],
  };
}

/** Empty result when no logs found at all */
private emptyTaskChangeSet(teamName: string, taskId: string): TaskChangeSetV2 {
  return {
    teamName, taskId, files: [],
    totalLinesAdded: 0, totalLinesRemoved: 0, totalFiles: 0,
    confidence: 'low', computedAt: new Date().toISOString(),
    scope: {
      taskId, memberName: 'unknown', startLine: 0, endLine: 0,
      startTimestamp: '', endTimestamp: '', toolUseIds: [], filePaths: [],
      confidence: { tier: 4, label: 'fallback', reason: 'No log files found for this task.' },
    },
    warnings: ['No log files found for this task.'],
  };
}
```

### 4. Модификация: `src/main/services/team/TeamMemberLogsFinder.ts` (MODIFY)

Добавляем новый метод для быстрого определения: есть ли TaskUpdate маркеры в файле.

```typescript
/**
 * Быстрая проверка: содержит ли JSONL файл TaskUpdate маркеры для задачи.
 * Быстрее чем полный parseBoundaries() — сканирует до первого совпадения.
 */
async hasTaskUpdateMarker(filePath: string, taskId: string): Promise<boolean> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  // H5 fix: экранируем taskId для безопасного использования в regex
  const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`"taskId"\\s*:\\s*"${escapedTaskId}"`);

  for await (const line of rl) {
    if (line.includes('TaskUpdate') && pattern.test(line)) {
      rl.close();
      stream.destroy();
      return true;
    }
    if (line.includes('teamctl') && line.includes(`task`) && line.includes(taskId)) {
      rl.close();
      stream.destroy();
      return true;
    }
  }

  rl.close();
  stream.destroy();
  return false;
}
```

**НЕ модифицируем `findLogsForTask()`** — он уже работает корректно через `fileMentionsTaskId()` (keyword search по JSONL). `hasTaskUpdateMarker()` может использоваться **параллельно** как fast-path проверка ДО полного парсинга, но НЕ заменяет `findLogsForTask()`.

**CRITICAL: `getAllSessionLogs()` НЕ существует!** Реальный `findLogsForTask()` (строки 110-197 TeamMemberLogsFinder.ts) уже итерирует по всем сессиям через `discoverProjectSessions()` и `fileMentionsTaskId()`. Метод возвращает `MemberLogSummary[]`.

`hasTaskUpdateMarker()` — это вспомогательный метод для `TaskBoundaryParser`, НЕ для замены findLogsForTask.

```typescript
// hasTaskUpdateMarker() может вызываться напрямую из TaskBoundaryParser или из renderer
// для быстрой проверки "поддерживает ли сессия structural scoping"
// Но findLogsForTask() НЕ МЕНЯЕТСЯ.
```

### 5. Обновление `src/main/index.ts` (MODIFY)

Phase 3 создаёт `TaskBoundaryParser` и передаёт в `ChangeExtractorService`:

```typescript
// В initializeIpcHandlers() или рядом с ним:
import { TaskBoundaryParser } from '@main/services/team/TaskBoundaryParser';

// Phase 1 было:
// const changeExtractor = new ChangeExtractorService(teamMemberLogsFinder);

// Phase 3 →:
const taskBoundaryParser = new TaskBoundaryParser();
const changeExtractor = new ChangeExtractorService(teamMemberLogsFinder, taskBoundaryParser);

// ReviewHandlerDeps не меняется (Phase 3 не добавляет новых deps в review.ts).
// TaskBoundaryParser используется ВНУТРИ ChangeExtractorService.
```

### 6. IPC (без изменений)

Phase 1 уже определил `REVIEW_GET_TASK_CHANGES`. Phase 3 не добавляет новых каналов — только улучшает backend точность.

### 6. Preload bridge и Store — обновление типов

Тип `TaskChangeSet` расширяется до `TaskChangeSetV2` (backwards compatible через extends).

**IMPORTANT: Обновить типы в 3 местах:**

1. **Preload bridge** (`src/preload/index.ts`): generic тип IPC-вызова обновить:
```typescript
// Phase 1:
getTaskChanges: (teamName: string, taskId: string) =>
  invokeIpcWithResult<TaskChangeSet>(REVIEW_GET_TASK_CHANGES, teamName, taskId),
// Phase 3 → заменить на:
getTaskChanges: (teamName: string, taskId: string) =>
  invokeIpcWithResult<TaskChangeSetV2>(REVIEW_GET_TASK_CHANGES, teamName, taskId),
```

2. **Store type** (`src/renderer/store/slices/changeReviewSlice.ts`):
```typescript
// Phase 2 тип:
activeChangeSet: AgentChangeSet | TaskChangeSet | null;
// Phase 3 → расширить:
activeChangeSet: AgentChangeSet | TaskChangeSet | TaskChangeSetV2 | null;
```

3. **ReviewAPI** (`src/shared/types/api.ts`): return type обновить:
```typescript
// Phase 1:
getTaskChanges: (teamName: string, taskId: string) => Promise<TaskChangeSet>;
// Phase 3 →:
getTaskChanges: (teamName: string, taskId: string) => Promise<TaskChangeSetV2>;
```

Все три изменения backwards compatible: `TaskChangeSetV2 extends TaskChangeSet`, поэтому все Phase 2 компоненты продолжают работать. Phase 3 компоненты используют `isTaskChangeSetV2()` type guard для доступа к `.scope` и `.warnings`.

---

## Frontend

### 7. Компоненты

#### `src/renderer/components/team/review/ConfidenceBadge.tsx` (NEW)

Показывает уровень уверенности в scope задачи.

```typescript
interface ConfidenceBadgeProps {
  confidence: TaskScopeConfidence;
  /** Показать tooltip с деталями */
  showTooltip?: boolean;
}

export function ConfidenceBadge({ confidence, showTooltip = true }: ConfidenceBadgeProps) {
  const colors = {
    1: 'bg-green-500/20 text-green-400 border-green-500/30',   // High
    2: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', // Medium
    3: 'bg-orange-500/20 text-orange-400 border-orange-500/30', // Low
    4: 'bg-red-500/20 text-red-400 border-red-500/30',          // Fallback
  };

  const labels = {
    1: 'High confidence',
    2: 'Medium confidence',
    3: 'Low confidence',
    4: 'Best effort',
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs border ${colors[confidence.tier]}`}
      title={showTooltip ? confidence.reason : undefined}
    >
      {labels[confidence.tier]}
    </span>
  );
}
```

#### `src/renderer/components/team/review/ScopeWarningBanner.tsx` (NEW)

Баннер предупреждений для low-confidence scopes.

```typescript
interface ScopeWarningBannerProps {
  warnings: string[];
  confidence: TaskScopeConfidence;
  onDismiss?: () => void;
}

export function ScopeWarningBanner({ warnings, confidence, onDismiss }: ScopeWarningBannerProps) {
  if (warnings.length === 0 && confidence.tier <= 2) return null;

  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm">
      <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
      <div className="flex-1">
        <p className="font-medium text-yellow-300">
          {confidence.tier >= 3
            ? 'Task boundary detection is approximate'
            : 'Note about these changes'}
        </p>
        {warnings.map((w, i) => (
          <p key={i} className="text-text-secondary mt-1">{w}</p>
        ))}
        <p className="text-text-muted mt-1 text-xs">
          Detection: {confidence.reason}
        </p>
      </div>
      {onDismiss && (
        <button onClick={onDismiss} className="text-text-muted hover:text-text">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
```

### 8. Модификация существующих компонентов

#### `ChangeReviewDialog.tsx` (MODIFY)

Добавляем scope information в header.

**Type guard (H2 fix — cross-phase compatibility):**
```typescript
// Phase 2 компоненты используют TaskChangeSet (Phase 1 тип).
// Phase 3 расширяет до TaskChangeSetV2 с полем .scope.
// ВСЕГДА проверять наличие .scope через 'in' guard:
function isTaskChangeSetV2(cs: TaskChangeSet): cs is TaskChangeSetV2 {
  return 'scope' in cs;
}
```

```typescript
// В header диалога (рядом с title)
{mode === 'task' && activeChangeSet && isTaskChangeSetV2(activeChangeSet) && (
  <div className="flex items-center gap-2">
    <ConfidenceBadge confidence={activeChangeSet.scope.confidence} />
    {activeChangeSet.warnings.length > 0 && (
      <ScopeWarningBanner
        warnings={activeChangeSet.warnings}
        confidence={activeChangeSet.scope.confidence}
      />
    )}
  </div>
)}
```

#### `KanbanTaskCard.tsx` (MODIFY)

Для задач в done/review/approved показываем confidence tier:

```typescript
// В footer карточки
{(columnId === 'done' || columnId === 'review' || columnId === 'approved') && (
  <div className="flex items-center gap-2 mt-2">
    <button
      onClick={(e) => {
        e.stopPropagation();
        onViewChanges?.(task.id);
      }}
      className="flex items-center gap-1 text-xs text-text-muted hover:text-text transition-colors"
    >
      <FileCode className="w-3.5 h-3.5" />
      View Changes
    </button>
    {/* ChangeStatsBadge уже из Phase 1 */}
    <ChangeStatsBadge stats={taskChangeStats} />
  </div>
)}
```

---

## Confidence Tiers — детальное описание

### Tier 1: High (95%+) — 86% сессий

**Условие**: Найдены оба маркера (start + end) ИЛИ single-task session.

**Сценарии:**
- `TaskUpdate(taskId=5, status=in_progress)` на строке 42 + `TaskUpdate(taskId=5, status=completed)` на строке 318
- Session имеет только 1 уникальный taskId → весь файл = одна задача

**Scope**: Строки [startLine, endLine] — все tool_use в этом диапазоне.

### Tier 2: Medium (90%) — ~8% сессий

**Условие**: Только start-маркер (задача ещё не завершена) ИЛИ batch completion.

**Сценарии:**
- Agent начал задачу 5, но crash/disconnect до completion
- Agent работает над 3 задачами последовательно, все complete в batch

**Scope**: [startLine, endOfFile] или [startLine, nextTaskStart].

### Tier 3: Low (80%) — ~4% сессий

**Условие**: Только end-маркер (start потерян).

**Сценарии:**
- Agent начал задачу до того как TeamCreate/TaskUpdate были доступны
- Начало было в другой сессии

**Scope**: [1, endLine] — от начала файла до completion marker.

### Tier 4: Fallback (70%) — ~2% сессий

**Условие**: Нет структурных маркеров. Используем keyword search + owner attribution.

**Сценарии:**
- Очень старые сессии без TaskUpdate support
- Agent использовал нестандартный workflow

**Scope**: Весь файл, с пометкой "best effort".

---

## Алгоритм multi-task sessions

Для сессий где agent работает над несколькими задачами последовательно:

```
JSONL Timeline:
  Line   1-30:   Setup, team init
  Line  31:      TaskUpdate(taskId=3, status=in_progress)    ← Task 3 START
  Line  32-150:  Edit, Write, Read operations for task 3
  Line 151:      TaskUpdate(taskId=3, status=completed)      ← Task 3 END
  Line 152:      TaskUpdate(taskId=7, status=in_progress)    ← Task 7 START
  Line 153-280:  Edit, Write operations for task 7
  Line 281:      TaskUpdate(taskId=7, status=completed)      ← Task 7 END
  Line 282-300:  Cleanup, idle
```

**Scope для Task 3**: Lines [31, 151] → tool_use IDs из строк 32-150
**Scope для Task 7**: Lines [152, 281] → tool_use IDs из строк 153-280

**Overlap handling**: Если границы перекрываются (редко), tool_use приписывается ближайшему start-маркеру.

---

## Файлы

| Файл | Тип | ~LOC |
|------|-----|---:|
| `src/shared/types/review.ts` | MODIFY | +80 |
| `src/main/services/team/TaskBoundaryParser.ts` | NEW | 350 |
| `src/main/services/team/ChangeExtractorService.ts` | MODIFY | +150 |
| `src/main/services/team/TeamMemberLogsFinder.ts` | MODIFY | +40 |
| `src/main/services/team/index.ts` | MODIFY | +1 |
| `src/main/index.ts` | MODIFY | +5 (см. ниже) |
| `src/preload/index.ts` | MODIFY | +1 (generic `<TaskChangeSetV2>`) |
| `src/shared/types/api.ts` | MODIFY | +1 (return type `TaskChangeSetV2`) |
| `src/renderer/store/slices/changeReviewSlice.ts` | MODIFY | +1 (union type) |
| `src/renderer/components/team/review/ConfidenceBadge.tsx` | NEW | 45 |
| `src/renderer/components/team/review/ScopeWarningBanner.tsx` | NEW | 50 |
| `src/renderer/components/team/review/ChangeReviewDialog.tsx` | MODIFY | +20 |
| `src/renderer/components/team/kanban/KanbanTaskCard.tsx` | MODIFY | +15 |
| **Итого** | 3 NEW + 9 MODIFY | ~760 |

---

## Edge Cases

1. **Задача работает в нескольких сессиях** — собираем scopes из всех JSONL файлов, merge tool_use IDs
2. **Один agent работает над 5+ задачами** — каждая задача имеет свой scope window, boundaries не перекрываются (confirmed на реальных данных)
3. **Agent делает TaskUpdate(in_progress) дважды подряд** — берём первый start, игнорируем повторный
4. **TaskUpdate(completed) без start** — Tier 3, scope от начала файла
5. **teamctl с set-status вместо start/complete** — парсим дополнительный аргумент (in_progress/completed)
6. **JSONL файл повреждён (обрезанные строки)** — try/catch skip, graceful degradation
7. **Очень длинные JSONL (>100MB)** — streaming readline, O(n) memory, no full-file load
8. **Numeric task IDs vs string** — всегда конвертируем в string для сравнения
9. **proxy_ prefix на tool names** — strip как в MemberStatsComputer (`.replace(/^proxy_/, '')`)
10. **tool_result с is_error: true** — пропускаем (Phase 1 rule), но boundary marker от tool_use всё равно учитываем

## Тестирование

- Unit test для `TaskBoundaryParser.parseBoundaries()` — mock JSONL с TaskUpdate markers
- Unit test для `TaskBoundaryParser.extractTeamctlBoundaries()` — различные teamctl formats
- Unit test для `computeScopes()` — single-task, multi-task, missing markers
- Unit test для Tier classification — все 4 тиера
- Unit test для `ChangeExtractorService.getTaskChanges()` — integration с boundary parser
- Unit test для `TeamMemberLogsFinder.hasTaskUpdateMarker()` — fast path detection
- Regression test: результаты Phase 3 должны быть superset Phase 1 (не потерять данные)
- Manual test с реальными сессиями из `~/.claude/projects/` — проверить Tier 1-4 distribution
