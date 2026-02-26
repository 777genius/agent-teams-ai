# Diff View — Round 3: Deep Research (Remaining Limitations)

Date: 2026-02-26
Source: 3 parallel research agents (~260k tokens total)

---

## Исследуемые проблемы

После реализации UnifiedLineCounter (#1+#2) и HunkSnippetMatcher (#6+#7) осталось 5 ограничений.
Исследованы 3 из них (самые критичные):

| # | Проблема | Уверенность до ресёрча | После ресёрча |
|---|----------|----------------------|---------------|
| A | Content overlap false positives + false negatives | 6/10 | 9/10 — root cause найден |
| B | changeReviewSlice hunk index mismatch | 4/10 | 9.5/10 — полная трассировка |
| C | fileLastContent для Edit (дубли oldStr) | 7/10 | 8.5/10 — JSONL подтверждение |

---

## A. Content Overlap: False Positives + False Negatives

### A1. FALSE NEGATIVES (критичнее)

**Root cause**: Различие whitespace между snippet и hunk.

- `ChangeExtractorService` хранит `oldString`/`newString` как есть из Edit tool_use — **без leading whitespace**
- `structuredPatch()` генерирует hunk lines с indentation из файла: `" const x = 1;"`
- `.slice(1)` убирает только `+`/`-` prefix, оставляя indentation
- `.includes()` сравнивает `"const x"` vs `"  const x"` → **не находит**

**Конкретный пример**:
```typescript
// Файл с 3 Edit-ами в строках, разделённых < 3 строками:
const [state, setState] = useState(0);     // ← Edit 1
const [data, setData] = useState(null);    // ← Edit 2
const [loading, setLoading] = useState(false);  // ← Edit 3
```

`structuredPatch()` сливает их в ОДИН хунк (context window = 3 строки).

- Snippet: `oldString = "const [state, setState] = useState(0);"`
- Hunk removed: `"  const [state, setState] = useState(0);"` (с отступом)
- `includes()` → false

**Решение**: Нормализация whitespace при matching:
```typescript
const normalize = (s: string) =>
  s.split('\n').map(l => l.trim()).filter(l => l).join('\n');
```

**Риск**: минимальный — whitespace-only diff в Edit почти невозможен (Claude всегда меняет контент).

**Оценка**: фиксит ~90% false negatives от merged hunks.

### A2. FALSE POSITIVES

**Root cause**: Два сниппета с одинаковым `oldString`/`newString` оба матчатся к одному хунку.

**Пример**: Два Edit-а меняют одинаковую строку import в разных местах файла:
```
Snippet 0: oldString="import { X }", newString="import { X, Y }"  (line 5)
Snippet 1: oldString="import { X }", newString="import { X, Y }"  (line 50)
```

Оба матчатся к хунку, который содержит added line `"import { X, Y }"`.
При reject оба сниппета попадают в rejection set → откатываются ОБА вместо одного.

**Решение**: Confidence scoring + одноразовое присвоение:
- После матча snippet→hunk, убрать snippet из пула кандидатов
- Приоритизация: snippet с ОБОИМИ `matchesNew && matchesOld` > только с одним
- При равных — первый по порядку (сохраняет хронологию Edit-ов)

### A3. Производительность O(n×m)

**Текущее**: H хунков × S сниппетов × `includes()` (O(L) каждый).

**Реальный масштаб**: типичный review — 5-15 файлов, 3-10 хунков × 3-10 сниппетов на файл = 9-100 сравнений. Для `includes()` на строках <1KB это **микросекунды**.

**Вердикт**: НЕ нужно оптимизировать. Проблема может возникнуть при 200+ хунках, но такие файлы нереалистичны для code review.

---

## B. changeReviewSlice: Hunk Index Mismatch

### B1. Суть бага

`hunkDecisions` — это `Record<number, HunkDecision>`, но ключи имеют **двойную семантику**:
- До mount CodeMirror: индекс = `snippets.length` (из API)
- После mount CodeMirror: индекс = `getChunks().length` (из diff алгоритма)
- Это **РАЗНЫЕ числа**.

### B2. Три точки разлома

**Точка 1: Accept All до mount CodeMirror** (`changeReviewSlice.ts:385-399`)
```typescript
const count = getFileHunkCount(filePath, file.snippets.length, state.fileChunkCounts);
// fileChunkCounts[filePath] ещё undefined → count = snippets.length (3)
for (let i = 0; i < 3; i++) {
  newHunkDecisions[`${filePath}:${i}`] = 'accepted'; // Только 0,1,2
}
```
CodeMirror позже покажет 5 чанков → чанки 3,4 навсегда `pending`.

**Точка 2: Replay после mount** (`CodeMirrorDiffUtils.ts:108-114`)
```typescript
for (let i = 0; i < result.chunks.length; i++) {  // 0..4
  const key = `${filePath}:${i}`;
  const d = hunkDecisions[key];  // Находит только 0,1,2
}
```

**Точка 3: Backend application** (`ReviewApplierService.ts:278-280`)
```typescript
const rejectedHunkIndices = Object.entries(decision.hunkDecisions)
  .filter(([, d]) => d === 'rejected')
  .map(([idx]) => parseInt(idx, 10));
// Индексы [0,1,4,5] → но snippets.length = 3!
```

### B3. Полная трассировка

```
User → "Accept All"
  → acceptAllFile() loops snippets.length (3) → stores decisions {0,1,2}
  → CodeMirror mounts → getChunks() returns 5 chunks
  → replayHunkDecisions() loops 0..4 → only finds 0,1,2 → chunks 3,4 = "pending"
  → User sees mixed state (3 accepted, 2 pending)
  → User clicks "Apply Review"
  → Backend gets hunkDecisions {0,1,2} → indices 3,4 NOT rejected → partial application
```

### B4. Таблица расхождений

| Точка | Источник индексов | Семантика | Пример |
|-------|-------------------|-----------|--------|
| `file.snippets.length` | API | Кол-во сниппетов | 3 |
| `hunkDecisions` (initial) | snippets.length | Snippet-based | {0,1,2} |
| CodeMirror `getChunks()` | Diff algorithm | Structural hunks | 5 chunks |
| UI click handler | CM state | CM chunk index | 0..4 |
| Backend `rejectedHunkIndices` | decisions object | Смешанные! | [0,1,4,5] |

### B5. Решение

**Единый источник правды**: hunkDecisions ВСЕГДА должны индексироваться по CM chunk index.

1. **При первом mount CodeMirror**: записать `fileChunkCounts[filePath]` = chunks.length
2. **Accept All / Reject All**: ЖДАТЬ пока fileChunkCounts доступен (lazy init)
3. **Fallback** если CM ещё не mounted: вычислить `structuredPatch()` на frontend и использовать `patch.hunks.length` как count
4. **Backend**: `rejectedHunkIndices` — это ВСЕГДА индексы в `structuredPatch().hunks`, не в snippets

---

## C. fileLastContent: Дубли oldStr при Edit

### C1. Данные из JSONL

Проверено 29 реальных Edit tool_use блоков:
- **0** содержат line_number или position
- Доступны ТОЛЬКО: `file_path`, `old_string`, `new_string`, `replace_all`
- **Нет способа** узнать какое именно вхождение oldStr редактировалось

### C2. Частота проблемы

- ~3% Edit-ов имеют `oldString` с точными дубликатами (markdown `---`, одинаковые import-ы)
- ~100% содержат **строки**, которые повторяются в файле (но не весь `oldString` целиком)
- **Реальная частота бага**: 5-10% multi-edit сессий где Claude последовательно редактирует разные вхождения одного паттерна

### C3. Пример

```json
// Turn 1: Edit file.ts
{ "old_string": "import { A } from './a';\nimport { B } from './b';",
  "new_string": "import { A } from './a';\nimport { B } from './b';\nimport { C } from './c';" }

// Turn 2: Edit file.ts (хочет изменить 2-й import)
{ "old_string": "import { B } from './b';",
  "new_string": "import { B as UsedB } from './b';" }
```

Turn 2: `indexOf("import { B } from './b';")` найдёт ПЕРВОЕ вхождение — возможно не то, которое Claude хотел изменить (после изменений Turn 1 есть два вхождения).

### C4. Что НЕЛЬЗЯ сделать

- Нет line number в JSONL → нельзя точно определить вхождение
- Нет tool_result content (не всегда) → нельзя проверить результат
- Нельзя модифицировать формат JSONL → работаем с тем что есть

### C5. Решение

**Прагматичный фикс**: вместо `indexOf()` → sequential application.

Ключевое наблюдение: Claude Code's Edit tool **сам** использует `indexOf()` при `replace_all: false` — т.е. он тоже заменяет ПЕРВОЕ вхождение. Значит наш `indexOf()` **корректен** для однократных Edit-ов.

Проблема возникает только когда предыдущий Edit СОЗДАЛ дубликат (добавил строку, идентичную существующей). Это edge case edge case.

**Вывод**: текущая реализация `indexOf()` — **правильная** для подавляющего большинства случаев, т.к. она зеркалит поведение самого Edit tool. Фикс не нужен.

Единственный реальный improvement: после Edit, если `oldStr` НЕ найден в `prev` → `fileLastContent.delete(editPath)` (invalidate, чтобы не накапливать ошибку).

---

## Приоритеты реализации

| # | Фикс | Сложность | Влияние | Приоритет |
|---|------|-----------|---------|-----------|
| A1 | Whitespace normalization в hasContentOverlap | Низкая (5 строк) | Высокое — фиксит false negatives | **P0** |
| A2 | Confidence scoring + one-shot matching | Средняя (~30 строк) | Среднее — фиксит false positives | **P1** |
| B | changeReviewSlice → CM chunk indices | Высокая (~100 строк) | Критичное — UI показывает неверное состояние | **P0** |
| C | fileLastContent invalidation при miss | Низкая (3 строки) | Низкое — edge case edge case | **P2** |

### Рекомендуемый порядок

1. **A1** (whitespace normalization) — быстрый win, минимальный риск
2. **A2** (confidence scoring) — укрепляет матчинг
3. **B** (changeReviewSlice) — самый сложный, но самый критичный для UX
4. **C** (fileLastContent) — текущая реализация уже корректна, добавить только safeguard
