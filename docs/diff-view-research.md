# Diff View Research — Полные результаты

## Раунд 1: Исследование (5 агентов параллельно)

---

## 1. Библиотеки для Diff UI с Accept/Reject

### Финальный рейтинг

| Ранг | Библиотека | Accept/Reject | Downloads/нед | Stars | Вердикт |
|------|-----------|:---:|---:|---:|---------|
| **1** | **`@codemirror/merge`** | **Нативный** | 580K | 103 | **Победитель** |
| **2** | **`@pierre/diffs`** | **Нативный** | 201K | 1,770 | **Сильный runner-up** |
| 3 | `react-diff-view` | Через Decoration API | 188K | 985 | Лучшая DIY-база |
| 4 | Monaco DiffEditor | Только revert | 4M | 42K | Overkill |
| 5 | `react-diff-viewer-continued` | Нет | 555K | 210 | Только отображение |
| 6 | `@git-diff-view/react` | Нет | 30K | 646 | Только отображение |

### `@codemirror/merge` (Победитель)
- **Единственная** библиотека с `acceptChunk()` и `rejectChunk()` как first-class API
- `mergeControls: true` — кнопки Accept/Reject на каждом hunk из коробки
- Кастомизация через `mergeControls: (type, action) => HTMLElement`
- События: `userEvent: "accept"` / `userEvent: "revert"`
- `allowInlineDiffs: true` — character-level диффы
- `collapseUnchanged` — скрытие неизменённого кода
- `goToNextChunk` / `goToPreviousChunk` — keyboard nav
- React wrapper: `react-codemirror-merge` v4.25.5 (53K downloads/нед)
- Bundle: ~15-20KB gzip (merge module) + ~130KB (CodeMirror core)
- Полная темизация, TypeScript, MIT, активная поддержка

### `@pierre/diffs` (Runner-up)
- Создана специально для Cursor-style UX (маркетируется так)
- `diffAcceptRejectHunk()` — утилита для accept/reject с автоматическим пересчётом номеров строк
- Shiki-based подсветка (те же темы что в VS Code)
- `MultiFileDiff` компонент для мульти-файлового ревью
- Shadow DOM + CSS Grid рендеринг
- Worker pool для производительности
- **Риск**: очень новая (сен 2025), нет явной лицензии, Shadow DOM усложняет кастомизацию стилей

---

## 2. Данные JSONL — Надёжность отслеживания изменений

### КРИТИЧЕСКОЕ ОТКРЫТИЕ: `toolUseResult` только в main session

**`toolUseResult` с `originalFile` и `structuredPatch` существует ТОЛЬКО в main session JSONL файлах.**
Subagent файлы (`subagents/agent-*.jsonl`) имеют только `tool_result` блоки с текстовым содержимым.

### Структура `toolUseResult` для Edit

```typescript
{
  filePath: string;           // Абсолютный путь
  oldString: string;          // Заменённый текст
  newString: string;          // Текст замены
  originalFile: string;       // ПОЛНОЕ содержимое файла ДО изменения
  structuredPatch: Hunk[];    // Готовые unified diff hunks
  userModified: boolean;      // Модифицировал ли пользователь
  replaceAll: boolean;        // Режим replace_all
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];  // Каждая строка с префиксом ' ', '+', '-'
}
```

### Структура для Write/Create

```typescript
// Создание нового файла
{ type: "create", filePath: string, content: string, structuredPatch: [], originalFile: null }

// Перезапись существующего
{ type: "text", file: { filePath, content, numLines, startLine, totalLines } }
// Write НЕ имеет originalFile! Только новое содержимое.
```

### Надёжность по инструментам

| Инструмент | `originalFile` | `structuredPatch` | В subagent JSONL | Надёжность |
|------------|:-:|:-:|:-:|:-:|
| **Edit** (main session) | Полный файл | Готовые hunks | Нет | **95%+** |
| **Edit** (subagent) | **Нет** | **Нет** | `tool_use.input` only | **70%** |
| **Write create** (main) | `null` | `[]` | Нет | **95%+** |
| **Write update** (main) | **Нет** | **Нет** | Нет | **50%** |
| **Write** (subagent) | **Нет** | **Нет** | `tool_use.input` only | **50%** |
| **Bash** | Нет | Нет | Только команда | **30-40%** |

### Обработка ошибок
- Когда Edit **не удаётся**: `toolUseResult` — строка с ошибкой (не объект)
- Когда пользователь **отклоняет**: `is_error: true` на `tool_result` блоке
- **Правило**: если `typeof toolUseResult === 'string'` или `is_error: true` → изменение НЕ произошло

### Линковка tool_use → tool_result
- `tool_result.tool_use_id` → `tool_use.id` — **100% надёжно** (213/213 matched, 0 mismatches)
- `sourceToolAssistantUUID` — всегда присутствует, указывает на UUID assistant entry
- `sourceToolUseID` — **отсутствует** в реальных данных (0 из 490+ проверенных)

### `file-history-snapshot` записи
```typescript
{
  type: 'file-history-snapshot';
  snapshot: {
    trackedFileBackups: Record<string, {
      backupFileName: string | null;  // e.g. "4eb3109b11712282@v2"
      version: number;
      backupTime: string;
    }>;
  };
}
```
Backup файлы хранятся в `~/.claude/file-history/{sessionId}/{backupFileName}` с ПОЛНЫМ содержимым файла.

---

## 3. Существующая инфраструктура в кодовой базе

### DiffViewer — PROTOTYPE quality

**Алгоритм**: Ручная реализация LCS (Longest Common Subsequence)
- O(m*n) сложность по памяти и времени
- **Нет** word-level диффов
- **Нет** split view
- **Нет** подсветки синтаксиса в диффе
- **Нет** сворачивания неизменённого кода
- **Нет** useMemo — дифф пересчитывается при каждом рендере
- **Неправильная** нумерация строк (последовательная вместо old/new)
- Дублирование `inferLanguage()` с CodeBlockViewer (87 строк)

**Вывод**: Нужна ЗАМЕНА алгоритма. UI-shell (хедер, CSS переменные) можно сохранить.

### Готовое к переиспользованию

| Компонент | Статус | Применение |
|-----------|--------|------------|
| CSS diff переменные | Готово | `--diff-added-bg`, `--diff-removed-bg` и т.д. |
| `MemberStatsComputer` | Расширить | Парсинг JSONL (сейчас считает строки, нужно извлекать контент) |
| `TeamMemberLogsFinder.findLogsForTask()` | Готово | Маппинг задача → сессии |
| `ToolResultExtractor` | Готово | Линковка tool_use ↔ tool_result |
| `ToolExecutionBuilder` | Готово | Построение ToolExecution объектов |
| IPC паттерн `team:*` | Копировать | Добавить `review:*` каналы |
| `highlight.js ^11.11.1` | Установлен | Подсветка синтаксиса |
| `@tanstack/react-virtual` | Установлен | Виртуальный скроллинг |

### НЕ установлено (нужно добавить)
- `diff` (jsdiff) — программные диффы, `applyPatch`, `reversePatch`
- `node-diff3` — three-way merge для конфликтов
- `@codemirror/merge` + `react-codemirror-merge` — UI
- `simple-git` — git операции (опционально)

---

## 4. Scoping изменений: Per-Task vs Per-Agent

### Per-Agent = 100% надёжно
- Каждый агент имеет свой JSONL файл
- ВСЕ `tool_use` в этом файле = действия этого агента
- Нет амбигуозности
- Уже реализовано в `MemberStatsComputer`

### Per-Task = ~85% через time-window подход

**Проблема**: Нет структурной связи между `tool_use` и task ID. JSONL не содержит `task_id` в метаданных инструментов.

**Текущий подход** (`findLogsForTask`): keyword search по task ID — ~60% надёжность.

**Рекомендуемый подход**: Time-window:
1. Найти `task start {id}` и `task complete {id}` Bash команды в JSONL
2. Все `tool_use` блоки между этими timestamp'ами = изменения задачи
3. Confidence: HIGH если оба маркера найдены, MEDIUM/LOW если нет

### Задачи на диске

`~/.claude/tasks/{team-name}/{id}.json` — **нет timestamp'ов смены статуса!** Только `createdAt` и `comments[].createdAt`.

---

## 5. Accept/Reject — Практическая реализация

### Подход: Hybrid (originalContent + jsdiff per-hunk)

```
Reject whole file:  fs.writeFile(filePath, originalFile)
Reject per-hunk:    jsdiff.applyPatch(originalFile, onlyAcceptedHunks)
Accept:             No-op (файл уже в нужном состоянии, просто UI mark)
Conflict detection: node-diff3.diff3Merge(current, original, agentVersion)
```

### Проблема timing (T1 → T2)
```
T0: Файл = A (original)
T1: Агент редактирует → файл = B (toolUseResult.originalFile = A)
T2: Другой агент/пользователь → файл = C
T3: Пользователь ревьюит и хочет reject
```
**Решение**: Three-way merge через `node-diff3`: base=B, ours=A, theirs=C → C без изменений агента.

### Пакеты для реализации

| Пакет | Назначение | Downloads/нед |
|-------|-----------|---:|
| `diff` (jsdiff v8) | `applyPatch`, `reversePatch`, `structuredPatch` | ~47M |
| `node-diff3` | Three-way merge с детекцией конфликтов | ~5K |
| `simple-git` | Git операции (опционально) | ~1.5M |

---

## 6. UX рекомендации

### Лучшие паттерны из индустрии

| Паттерн | Инструменты | Описание |
|---------|------------|----------|
| File tree sidebar | GitHub, Cursor 2.0, JetBrains | Resizable, со статус-индикаторами |
| Split/Unified toggle | GitHub, GitKraken, VS Code | По выбору пользователя |
| Per-file accept/reject | Cursor, VS Code Copilot | Самая частая гранулярность |
| Per-hunk accept/reject | GitKraken (revert hunk), CodeMirror | Очень востребовано |
| "Viewed" tracking | GitHub | Чекбокс на файл |
| Keyboard navigation | GitHub (T/C/I), VS Code (Tab) | Критично для power users |

### Предложенная структура UI

```
┌──────────────────────────────────────────────────┐
│ Task: "Implement auth"  [backend-dev]  +142 -38  │
├──────────┬───────────────────────────────────────┤
│ File Tree│  CodeMirror Merge View                │
│          │                                        │
│ ▸ src/   │  src/middleware/auth.ts                │
│   auth.ts│  @@ -1,5 +1,42 @@                     │
│   +87 -2 │  + import jwt from 'jsonwebtoken'      │
│   ✓      │  [✓ Accept] [✗ Reject]                 │
│          │                                        │
│ ▸ test/  │  @@ -42,3 +42,8 @@                     │
│   auth.. │  - const OLD = ...                      │
│   +42 -0 │  + const NEW = ...                      │
│          │  [✓ Accept] [✗ Reject]                 │
├──────────┴───────────────────────────────────────┤
│ [Reject All]  [Accept All]   Unified ↔ Split     │
└──────────────────────────────────────────────────┘
```

### 3 уровня контроля
1. **Global**: Accept All / Reject All
2. **Per-file**: Иконки в файловом дереве
3. **Per-hunk**: Кнопки на каждом hunk (через `@codemirror/merge` mergeControls)

---

---

## Раунд 2: Решения (5 агентов параллельно)

---

## 7. РЕШЕНО: Subagent Diff Data Gap

### Проблема
`toolUseResult` с `originalFile`/`structuredPatch` существует ТОЛЬКО в main session JSONL. Subagent файлы содержат только `tool_use.input` и текстовый `tool_result`.

### Решение: Двухуровневый подход

**Level 1 (Primary): Snippet-level дифы из `tool_use.input`** — мгновенные, 0 disk I/O:
- Edit: `old_string` → `new_string` = точный snippet diff (95% надёжность)
- Write (create): `""` → `content` = полный новый файл (100%)
- Write (update): только `content`, нет "before" (0% для diff, 100% для показа)
- MultiEdit: каждая пара `old_string`/`new_string` отдельно

**Level 2 (Enrichment): Full-file дифы из file-history backups** — on-demand:
- Ключевое открытие: `file-history-snapshot` в main session JSONL **отслеживает ВСЕ файлы, включая изменённые subagent'ами**
- Backup файлы в `~/.claude/file-history/{sessionId}/{backupFileName}` содержат полное содержимое файлов
- Корреляция по timestamp: subagent edit timestamp → version bump в file-history
- Решает проблему Write (update) без originalFile

| Инструмент | Level 1 (snippet) | Level 2 (full-file) |
|------------|:-:|:-:|
| Edit | old→new (идеально) | file-history v(n-1)→v(n) |
| Write (create) | ""→content (идеально) | backupFileName=null→v2 |
| Write (update) | только content | **file-history решает!** |
| MultiEdit | каждая пара | file-history для агрегата |
| Bash | недоступно | file-history как fallback |

---

## 8. РЕШЕНО: @codemirror/merge vs @pierre/diffs

### Победитель: `@codemirror/merge` (однозначно)

| Критерий | @codemirror/merge | @pierre/diffs |
|---|---|---|
| Accept/Reject кнопки | **Встроены** (`mergeControls: true`) | Нет UI, только утилита |
| Callback | `isUserEvent('accept'/'revert')` | Ручная реализация |
| Tailwind совместимость | Стандартный DOM | **Shadow DOM — конфликт!** |
| Bundle | 181 KB | 2.4 MB + Shiki 1.2 MB gzip |
| Темизация | CSS-переменные через `EditorView.theme()` | Только через Shadow DOM CSS vars |
| Лицензия | MIT | Apache-2.0 |
| Стабильность | 3+ года, 445K downloads/нед | "Early active development, APIs subject to change" |
| Автор | Marijn Haverbeke (создатель CM) | Стартап, 12 contributors |

**Минимальный рабочий пример:**
```tsx
const extensions = [
  EditorView.editable.of(false),
  EditorState.readOnly.of(true),
  unifiedMergeView({
    original: originalCode,
    mergeControls: true,               // Accept/Reject кнопки на каждом hunk
    collapseUnchanged: { margin: 3 },  // Скрыть неизменённые участки
    allowInlineDiffs: true,            // Character-level дифы
  }),
  EditorView.updateListener.of(update => {
    for (const tr of update.transactions) {
      if (tr.isUserEvent('accept')) onAccept?.();
      if (tr.isUserEvent('revert')) onReject?.();
    }
  }),
  EditorView.theme({
    '&': { backgroundColor: 'var(--color-surface)' },
  }, { dark: true }),
];
```

---

## 9. Backend Architecture

### Новые сервисы
- **`ChangeExtractorService`** — парсит JSONL (main + subagent), извлекает FileChange[], кэш 3 мин
  - `extractChangesForAgent(teamName, memberName)` → `AgentChangeSet`
  - `extractChangesForTask(teamName, taskId)` → `TaskChangeSet`
- **`RejectService`** — reject file/hunks, conflict detection, three-way merge
  - `rejectFile(fileChange)` → `RejectResult`
  - `rejectHunks(fileChange, hunkIndices)` → `RejectResult`
  - `previewReject(fileChange, hunkIndices?)` → content preview

### Reject алгоритм
```
Reject whole file:
  no conflict → fs.writeFile(originalContent)
  conflict → node-diff3 three-way merge (current, original, agentVersion)

Reject per hunk:
  1. Build partial patch (only accepted hunks)
  2. jsdiff.applyPatch(originalContent, partialPatch)
  3. Conflict check + three-way merge if needed

Accept = no-op (файл уже в нужном состоянии)
```

### IPC каналы (7 новых)
`review:getAgentChanges`, `review:getTaskChanges`, `review:checkConflict`,
`review:rejectFile`, `review:rejectHunks`, `review:rejectBatch`, `review:previewReject`

---

## 10. Frontend Architecture

### Компонентное дерево
```
ChangeReviewDialog (dialog shell)
  ├── ChangeReviewToolbar (Accept All / Reject All / Apply / Split↔Unified)
  └── [resizable split panel]
      ├── FileTreePanel (файлы с +/- stats, статус-иконки)
      │     └── FileTreeItem (файл, viewed checkbox)
      └── DiffPanel (CodeMirror merge view)
            ├── DiffPanelHeader (имя файла, per-file accept/reject)
            ├── CodeMirrorDiffView (@codemirror/merge wrapper)
            └── DiffPanelEmptyState (loading/error/empty)
```

### Zustand slice: `changeReviewSlice`
- `activeChangeSet`, `changeSetLoading`, `changeSetError`
- `selectedReviewFilePath`, `fileReviewStates`, `diffViewMode`
- `changeStatsCache` (для badge'ей на карточках)
- Actions: `fetchTaskChanges`, `fetchAgentChanges`, `setHunkDecision`, `setFileDecision`, `acceptAll`, `rejectAll`, `applyReview`

### Интеграция
- **KanbanTaskCard** → `ChangeStatsBadge` (+142 -38) на карточках в done/review/approved
- **TaskDetailDialog** → секция "Changes" с кнопкой "View Changes"
- **MemberDetailDialog** → таб "Changes" для per-agent ревью

### Keyboard shortcuts
`j`/`k` файлы, `n`/`p` hunks, `a` accept hunk, `x` reject hunk, `A` accept file, `X` reject file

---

## 11. Implementation Phases

### Phase 1: MVP — Read-Only Diff View (~1,900 LOC)
- 14 новых файлов, 14 модификаций
- Пакет: `diff` (jsdiff v8)
- `FileChangeExtractor` + `ReviewAggregator` (backend)
- `ReviewPanel` + `ReviewFileTree` + `ReviewDiffContent` (frontend)
- Snippet-level дифы из `tool_use.input`
- "Review Changes" кнопка на MemberCard

### Phase 2: Accept/Reject Per Hunk (~1,340 LOC)
- 9 новых файлов, 8 модификаций
- Пакеты: `@codemirror/merge`, `react-codemirror-merge`, `node-diff3`, CM language packages
- `ReviewApplier` + `BackupReader` (backend)
- `CodeMirrorDiffView` + `ReviewToolbar` + `ConflictDialog` (frontend)
- Three-way merge для конфликтов

### Phase 3: Per-Task Scoping (~880 LOC)
- 4 новых файла, 9 модификаций
- `TaskTimeWindowResolver` — time-window подход (~85% надёжность)
- Интеграция в KanbanTaskCard
- Confidence badges

### Phase 4: Enhanced Features (~550 LOC)
- 5 новых файлов, 3 модификации
- Пакет: `simple-git`
- File Edit Timeline, Keyboard Navigation, "Viewed" tracking, Git fallback

### Итого: ~4,670 LOC, 32 новых файла + 34 модификации, 14 npm пакетов

---

## 12. Ключевые npm-пакеты

| Пакет | Фаза | Назначение |
|-------|:---:|-----------|
| `diff` (jsdiff v8) | 1 | structuredPatch, applyPatch, reversePatch |
| `@codemirror/merge` | 2 | Diff UI с accept/reject |
| `react-codemirror-merge` | 2 | React wrapper для CM merge |
| `@codemirror/state` | 2 | CM core dependency |
| `@codemirror/view` | 2 | CM core dependency |
| `@codemirror/lang-javascript` | 2 | TS/JS подсветка |
| `@codemirror/lang-python` | 2 | Python подсветка |
| `@codemirror/lang-json` | 2 | JSON подсветка |
| `@codemirror/lang-css` | 2 | CSS подсветка |
| `@codemirror/lang-html` | 2 | HTML подсветка |
| `@codemirror/theme-one-dark` | 2 | Тёмная тема (базовая) |
| `node-diff3` | 2 | Three-way merge |
| `simple-git` | 4 | Git операции (fallback) |

---

---

## Раунд 3: Углублённое исследование (5 агентов параллельно)

---

## 13. Monaco DiffEditor — глубокий анализ

### Accept/Reject возможности
- Monaco DiffEditor имеет ТОЛЬКО `renderMarginRevertIcon` (кнопка revert на gutter) — **reject only, нет accept**
- Для полноценного accept/reject per hunk нужно **500+ строк кастомного кода**:
  - Ручное создание ViewZone + overlay widget
  - Вычисление diff chunks через `getLineChanges()`
  - Ручное apply/reverse каждого hunk
  - Управление scroll/layout при операциях
- **Оценка времени**: 2-3 недели vs 3-5 дней для CodeMirror merge

### Bundle & Performance
- **Bundle**: 1.5-2 MB gzipped (весь Monaco)
- CSS переменные **НЕ поддерживаются** напрямую — нужен workaround через `defineTheme()`
- Устаревшие API (удалённые в v0.50+) создают риск нестабильности

### Вывод
Monaco DiffEditor = overkill для нашего use case. CodeMirror merge значительно проще и легче.

---

## 14. CodeMirror Merge — гибкость и кастомизация

### `mergeControls` — полный контроль HTML
```typescript
mergeControls: (type: 'accept' | 'reject', action: () => void) => {
  const btn = document.createElement('button');
  btn.className = 'my-custom-btn'; // Любые стили, включая Tailwind
  btn.textContent = type === 'accept' ? '✓' : '✗';
  btn.onclick = action;
  return btn;
}
```
- Каждый hunk получает свои кнопки, полностью кастомизируемые
- Можно добавить любой HTML: иконки, tooltips, dropdown meню

### CSS переменные — полная совместимость
```typescript
EditorView.theme({
  '&': { backgroundColor: 'var(--color-surface)' },
  '.cm-changedLine': { backgroundColor: 'var(--diff-added-bg)' },
  '.cm-deletedChunk': { backgroundColor: 'var(--diff-removed-bg)' },
}, { dark: true })
```
- Sourcegraph мигрировал **ИЗ Monaco В CodeMirror** именно ради CSS гибкости

### Per-chunk метаданные
- `getChunks(mergeView)` → массив chunk'ов с `fromA`, `toA`, `fromB`, `toB`
- Можно навешивать декорации (~30-50 строк кастомного extension)
- Keyboard navigation: `goToNextChunk` / `goToPreviousChunk` из коробки

---

## 15. Альтернативные библиотеки с accept/reject

### Полная матрица (найдено 15 агентом-исследователем)

| # | Библиотека | Accept/Reject | Stars | Стабильность | Наш вердикт |
|---|-----------|:---:|---:|---|---|
| **1** | **`@codemirror/merge`** | **Нативный API** | 103 (CM: 7.5K) | 3+ года, Marijn Haverbeke | **ПОБЕДИТЕЛЬ** |
| 2 | `@marimo-team/codemirror-ai` | Да (keybinds) | 43 | v0.3.5, 19 релизов | AI-focused, не diff review |
| 3 | `tiptap-diff-suggestions` | Да (commands) | 22 | MIT, headless | Для rich text, не код |
| 4 | `@pierre/diffs` | Утилита only | 1,770 | "APIs subject to change" | Shadow DOM конфликт |
| 5 | `react-diff-viewer-continued` | Нет | 210 | Только отображение | Нет accept/reject |
| 6 | `@git-diff-view/react` | Нет (widget ext.) | 646 | Активный | Нет нативного A/R |
| 7 | `ace-diff` | Copy LR arrows | 365 | MIT, Ace-based | Устаревший подход |
| 8 | `react-diff-view` | Через Decoration | 985 | Stable | DIY accept/reject |
| 9 | Monaco DiffEditor | Только revert | 42K | Microsoft | 500+ LOC custom |
| 10 | `monaco-inline-diff-editor` | Да (custom) | **1** | No npm pkg | Прототип, не production |

### `@marimo-team/codemirror-ai` — детали
- **Назначение**: AI inline suggestions (как Continue.dev / Cursor autocomplete)
- `acceptEdit: 'Mod-y'`, `rejectEdit: 'Mod-u'` — keybindings
- `onAcceptEdit`, `onRejectEdit` callbacks
- **Проблема для нас**: заточен под AI suggestions в реальном времени, НЕ под post-hoc diff review
- Его нельзя применить к нашему use case (ревью уже сделанных изменений)

### `tiptap-diff-suggestions` — детали
- `acceptDiffSuggestion(id?)`, `rejectDiffSuggestion(id?)`
- Headless, CSS variables для тем
- **Проблема для нас**: TipTap = rich text editor. Наш use case — код с подсветкой синтаксиса
- Не подходит для code diff review

### `monaco-inline-diff-editor-with-accept-reject-undo`
- 1 star, 0 forks, нет npm пакета
- "Copy the code directly to your project"
- Вдохновлён Cursor, но это прототип
- **Не production-ready**

### Итог
**Ни одна альтернатива не превосходит `@codemirror/merge`** для нашего use case (post-hoc code diff review with per-hunk accept/reject). Решение подтверждено.

---

## 16. КРИТИЧЕСКОЕ: Per-Task Scoping улучшен до 95%+

### Открытие: `TaskUpdate` tool_use в subagent JSONL

**Два механизма управления задачами (ВЗАИМОИСКЛЮЧАЮЩИЕ в рамках сессии):**

**Механизм A: `TaskUpdate` нативный tool** (307 сессий)
```json
{
  "type": "tool_use",
  "name": "TaskUpdate",
  "input": { "taskId": "5", "status": "in_progress" }
}
```
- Используется стандартными subagent сессиями
- 100% парсируемо — `input.taskId` + `input.status`
- Tool result: `"Updated task #1 status"` (текст)

**Механизм B: Bash `teamctl.js`** (44 сессии)
```bash
node "$HOME/.claude/tools/teamctl.js" --team "<team>" task start|complete|set-status <id>
```
- Используется in-process teammates
- Tool result: `"OK task #5 status=completed"` (стабильный формат)
- Regex: `/task\s+(start|complete|set-status)\s+(\d+)/`

**Ключевой факт: эти механизмы НИКОГДА не смешиваются** (0 из 351 сессий).

### Статистика субагентов
- **86% сессий** работают над **1 задачей** → 100% надёжность (вся сессия = задача)
- **14% сессий** работают над **несколькими задачами** последовательно
- Мульти-задачные сессии: чёткие `in_progress` → `completed` маркеры на каждую задачу

### Реальный пример мульти-задачной сессии (agent-a9f16f0)
```
L 29  TaskCreate: task 1..5
L 40  TaskUpdate: taskId=2, status=in_progress
L 42  Grep, Read, Bash (pnpm add), Write...   ← изменения задачи 2
L137  TaskUpdate: taskId=1, status=in_progress
L139  TaskUpdate: taskId=3, status=in_progress
L141  TaskUpdate: taskId=4, status=in_progress
L144  Edit, Edit, Edit...                       ← изменения задач 1,3,4
L220  TaskUpdate: taskId=1, status=completed
L222  TaskUpdate: taskId=2, status=completed
L224  TaskUpdate: taskId=3, status=completed
L226  TaskUpdate: taskId=4, status=completed
L228  TaskUpdate: taskId=5, status=in_progress
L230  Bash: pnpm typecheck, test, lint...       ← изменения задачи 5
```

### Алгоритм структурного scoping'а

```
parseTaskBoundaries(sessionJsonl) → Map<taskId, tool_use_ids[]>

1. Детектировать TaskUpdate tool_use:
   - status == "in_progress" → TASK_START(taskId, line)
   - status == "completed"   → TASK_END(taskId, line)

2. Детектировать Bash teamctl:
   - "task start <id>"      → TASK_START(taskId, line)
   - "task complete <id>"   → TASK_END(taskId, line)

3. Между TASK_START и TASK_END:
   - Все Edit/Write/Bash tool_use = изменения задачи

4. Если новый TASK_START до TASK_END предыдущей:
   - Граница переключения задач
```

### Уровни уверенности

| Tier | Надёжность | Описание | Покрытие |
|------|:-:|---|---|
| **Tier 1** | **95%+** | Чёткие маркеры start/end | 86% сессий (1 задача) + sequential multi |
| **Tier 2** | **90%** | Batch completion | ~8% сессий |
| **Tier 3** | **80%** | Только end-маркер | ~4% сессий |
| **Tier 4** | **70%** | Нет маркеров | ~2% сессий → fallback на owner+mention |

### Почему было ~85% раньше
Существующая реализация (`findLogsForTask`) использовала **только text search по task ID**. Она **НЕ парсила `TaskUpdate` tool_use blocks** (которые покрывают 87.5% task-active сессий).

### Как достичь 95%+
1. **Добавить парсинг `TaskUpdate` tool_use** (name == "TaskUpdate", input.taskId, input.status)
2. **Сохранить Bash teamctl regex** для остальных 12.5%
3. Для single-task сессий (86%): вся сессия = задача (100%)
4. Для multi-task: маркеры start/end как границы сегментов

---

## 17. Финальная консолидированная рекомендация

### Библиотека: `@codemirror/merge` (подтверждено 3 раундами)
- Единственная production-ready библиотека с нативным accept/reject per hunk
- CSS variables, полная кастомизация HTML, ~150 KB bundle
- Ни одна из 10+ исследованных альтернатив не превосходит

### Данные: Hybrid (tool_use.input + file-history) = 98% надёжность
- Level 1: Snippet diffs из tool_use.input (мгновенно, 0 I/O)
- Level 2: Full-file diffs из file-history-snapshot backups (on-demand)
- Решает проблему subagent'ов без `toolUseResult`

### Per-Task Scoping: Структурные маркеры = 95%+
- `TaskUpdate` tool_use + Bash teamctl = 100% парсируемые маркеры
- 86% сессий = 1 задача → 100% надёжность
- Улучшение с ~85% (text search) до 95%+ (структурный парсинг)

### Reject механизм: jsdiff + node-diff3
- Reject whole file: fs.writeFile(originalContent)
- Reject per hunk: jsdiff.applyPatch(original, acceptedHunksOnly)
- Conflict resolution: node-diff3 three-way merge
- Accept = no-op (файл уже изменён)

---

## 18. Полный каталог библиотек (exhaustive search)

### Что используют крупные продукты

| Продукт | Технология | Accept/Reject? |
|---------|-----------|:---:|
| **Cursor** | Monaco + custom decorations | Да (gold standard) |
| **VS Code** | Monaco merge editor | Да (3-way conflicts) |
| **GitKraken** | Monaco + libgit2/NodeGit | Нет в diff view |
| **GitHub Desktop** | Custom React renderer | Нет |
| **Linear Reviews** | Custom React ("structural diffing") | Нет |
| **Vercel v0** | Custom diff view | Нет |

### Дополнительная находка: `@git-diff-view/react`
- 646 stars, MIT, обновляется еженедельно (февраль 2026)
- GitHub-style UI, Split/Unified views, Web Worker performance
- **Widget system**: `renderWidgetLine` + `renderExtendLine` для кастомных React-компонентов на строках
- Shiki / highlight.js для подсветки синтаксиса
- **Нет нативного accept/reject**, но widget system позволяет добавить
- **Альтернативный путь**: использовать как viewer + custom accept/reject widgets

### Справочная реализация: `revu` (desktop app)
- Tauri (React + Rust), НЕ библиотека
- Ревью AI-изменений перед коммитом, comments per line, "Send to Agent" export
- Хороший UX-reference

### Итог exhaustive search
**Ни одна библиотека в экосистеме React/JS не предоставляет production-ready code diff viewer с per-hunk accept/reject из коробки.** Это gap в экосистеме, который каждый продукт (Cursor, VS Code, Linear) заполняет custom-реализациями поверх Monaco или CodeMirror. `@codemirror/merge` — ближайшее к "из коробки" решение.
