# PR 0: Обязательные рефакторинги (R1-R4)

> Перед итерацией 1. Отдельный PR.

## Цель

Обязательные рефакторинги -- без них будет дублирование кода. Выполняются ДО написания нового кода. Тесты `ReviewFileTree` и `CodeMirrorDiffView` должны проходить после рефакторинга (zero behavior change).

## Почему отдельный PR

R1 затрагивает production `ReviewFileTree` (используется в `ChangeReviewDialog`), R3 затрагивает production `CodeMirrorDiffView`. Объединение рефакторинга production-кода + 15 новых файлов в одну итерацию — чрезмерный blast radius (28 файлов). Разделение:
- **PR 0 ("Refactoring")**: R1-R4 + тесты. Мёрдж только после проверки что ChangeReviewDialog работает корректно.
- **PR 1 ("Walking Skeleton")**: Новые editor-файлы. Зависит от PR 0.

## Рефакторинги

| # | Что извлечь | Откуда | Куда | LOC |
|---|-------------|--------|------|-----|
| R1 | `buildTree()` + `collapse()` + сортировка | `ReviewFileTree.tsx:42-83` | `src/renderer/utils/fileTreeBuilder.ts` | ~50 |
| R2 | `getSyncLanguageExtension()` + `getAsyncLanguageDesc()` | `CodeMirrorDiffView.tsx:64-128` | `src/renderer/utils/codemirrorLanguages.ts` | ~70 |
| R3 | Базовая тема CM (без diff-стилей) | `CodeMirrorDiffView.tsx:158-198` | `src/renderer/utils/codemirrorTheme.ts` | ~40 |
| R4 | `wrapReviewHandler<T>()` | `review.ts:133-145` | `src/main/ipc/ipcWrapper.ts` | ~15 |

## Детали каждого рефакторинга

### R1: `buildTree<T>()` — Generic tree builder

**NB**: `ReviewFileTree` работает с `FileChangeSummary` (имеет `status`, `additions`, `deletions`), а editor использует `FileTreeEntry` (имеет `size`, `children`). `buildTree<T>()` должен быть generic по типу node, принимая `getPath: (item: T) => string` и `isDirectory: (item: T) => boolean` как параметры.

```typescript
// src/renderer/utils/fileTreeBuilder.ts
function buildTree<T>(
  items: T[],
  getPath: (item: T) => string,
  isDirectory: (item: T) => boolean
): TreeNode<T>[]
```

### R2: `getSyncLanguageExtension()` — Языковой маппинг

Извлечь из `CodeMirrorDiffView.tsx:64-128`. 16+ языков синхронно + `@codemirror/language-data` async fallback.

### R3: `baseEditorTheme` — Базовая тема

**NB**: `diffTheme` — один `EditorView.theme({...})` на 125 строк. Рефакторинг:
1. Извлечь строки 158-198 в `baseEditorTheme = EditorView.theme({...})` в `codemirrorTheme.ts`
2. В `CodeMirrorDiffView.tsx` создать `const diffSpecificTheme = EditorView.theme({...})` со строками 199-283
3. В `buildExtensions()` заменить `diffTheme` на `[baseEditorTheme, diffSpecificTheme]`

### R4: `createIpcWrapper()` — Общий IPC wrapper

**NB**: `teams.ts` имеет аналогичный `wrapTeamHandler` (40+ вызовов), но его миграция — отдельный follow-up PR после итерации 1. Blast radius слишком высокий (1755 строк) для совмещения с основной фичей. В итерации 1 R4 применяется ТОЛЬКО к `review.ts` + новому `editor.ts`.

```typescript
// src/main/ipc/ipcWrapper.ts
export function createIpcWrapper(logPrefix: string) {
  const log = createLogger(logPrefix);
  return async function wrap<T>(op: string, fn: () => Promise<T>): Promise<IpcResult<T>> {
    try { return { success: true, data: await fn() }; }
    catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`handler error [${op}]:`, msg);
      return { success: false, error: msg };
    }
  };
}

// review.ts:
const wrapHandler = createIpcWrapper('IPC:review');

// editor.ts:
const wrapHandler = createIpcWrapper('IPC:editor');
```

## После рефакторинга

- `ReviewFileTree.tsx` импортирует `buildTree`, `TreeNode` из `fileTreeBuilder.ts`
- `CodeMirrorDiffView.tsx` импортирует из `codemirrorLanguages.ts` и `codemirrorTheme.ts`
- `review.ts` импортирует `createIpcWrapper` из `ipcWrapper.ts`
- `teams.ts` — миграция `wrapTeamHandler` → `createIpcWrapper` в отдельном follow-up PR (40+ замен, высокий blast radius)

## Уровень риска по рефакторингам

| R# | Что трогает | Уровень риска | Почему |
|----|-------------|--------------|--------|
| R1 | ReviewFileTree (дерево файлов) | Низкий | Извлечение чистой функции buildTree(). Diff-viewer, hunks, approve/reject — не затрагиваются |
| R2 | CodeMirrorDiffView (языки) | Около нуля | Чистые stateless функции, просто выносим в отдельный файл |
| R3 | CodeMirrorDiffView (тема) | Низкий | Разрезка CSS-объекта на base + diff-specific. Визуально проверить |
| R4 | review.ts (IPC wrapper) | Около нуля | 15 LOC try-catch factory, тривиальная замена |

**Что НЕ затрагивается**: ChangeReviewDialog logic, diff rendering, hunks, approve/reject, комментарии, changeReviewSlice state.

## Критерии готовности

- [ ] `pnpm typecheck` проходит
- [ ] `pnpm test` проходит (zero behavior change)
- [ ] Новые unit-тесты для `fileTreeBuilder.ts` и `ipcWrapper.ts`
- [ ] Новые unit-тесты для `codemirrorLanguages.ts` — проверка маппинга расширений на языки
- [ ] Manual smoke-тест: открыть ChangeReviewDialog → файловое дерево рендерится корректно, diff подсвечивается

## Оценка

- **Надёжность решения: 9/10** — все 4 рефакторинга механические (извлечение функций без изменения поведения). R2/R4 — около нуля риска, R1/R3 — низкий.
- **Уверенность: 9/10** — код review workflow не затрагивается, трогается только утилитарная часть (дерево файлов, языки, тема, wrapper).
