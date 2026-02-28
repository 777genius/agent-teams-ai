# Итерация 4: Горячие клавиши, поиск, UX polish

> Зависит от: [Итерация 3](iter-3-multi-tab-crud.md)

## Цель

Клавиатурная навигация, Quick Open (Cmd+P), поиск по файлам (Cmd+Shift+F), breadcrumb, иконки файлов, виртуализация дерева.

## IPC каналы

| Канал | Описание |
|-------|----------|
| `editor:searchInFiles` | Literal string search, max 100 results, max 1MB/файл |

## Новые файлы

| # | Файл | Описание |
|---|------|----------|
| 1 | `src/renderer/components/team/editor/QuickOpenDialog.tsx` | Cmd+P: fuzzy search через `cmdk` |
| 2 | `src/renderer/components/team/editor/SearchInFilesPanel.tsx` | Cmd+Shift+F: результаты поиска |
| 3 | `src/renderer/components/team/editor/EditorBreadcrumb.tsx` | Breadcrumb навигация (кликабельный) |
| 4 | `src/renderer/components/team/editor/EditorShortcutsHelp.tsx` | Модальное окно shortcuts (кнопка ?) |
| 5 | `src/renderer/components/team/editor/fileIcons.ts` | Маппинг расширений на lucide-react иконки/цвета |
| 6 | `src/renderer/hooks/useEditorKeyboardShortcuts.ts` | Все горячие клавиши редактора. CM6 keybindings с `stopPropagation: true` |
| 7 | `src/main/services/editor/FileSearchService.ts` | Search in files (literal, с лимитами) |

## Изменения в существующих файлах

| # | Файл | Изменение |
|---|------|-----------|
| 1 | `src/shared/types/editor.ts` | Типы SearchResult |
| 2 | `src/shared/types/api.ts` | `searchInFiles` в EditorAPI |
| 3 | `src/main/ipc/editor.ts` | Handler `editor:searchInFiles` |
| 4 | `src/preload/index.ts` | `editor.searchInFiles` |
| 5 | `src/preload/constants/ipcChannels.ts` | `EDITOR_SEARCH_IN_FILES` |
| 6 | `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | QuickOpen, SearchInFiles, Breadcrumb, shortcuts |
| 7 | `src/renderer/components/team/editor/EditorFileTree.tsx` | Виртуализация через react-virtual + иконки файлов |
| 8 | `src/renderer/components/team/editor/EditorTabBar.tsx` | Иконки файлов на вкладках |

## Security-требования

1. `searchInFiles`: ТОЛЬКО literal string search, НЕ regex. Default case-insensitive (`line.toLowerCase().includes(query.toLowerCase())` — ReDoS-безопасно). Опция `caseSensitive?: boolean` в параметрах. Max 1000 файлов, max 1MB/файл. Каждый файл валидируется через `validateFilePath()`. AbortController timeout 5s (SEC-8). **Cancellation**: предыдущий поиск отменяется AbortController при новом запросе (debounce 300ms на renderer перед IPC вызовом)

## Performance-требования

- File tree виртуализация: `@tanstack/react-virtual` -- `flattenTree()` + `useVirtualizer({ estimateSize: () => 28 })`
- Quick Open: кешировать flat file list при открытии editor. Invalidate по file watcher event или F5
- Search in files: запускать с AbortController timeout. На renderer: debounce 300ms + отмена предыдущего IPC запроса при новом вводе (хранить `abortControllerRef` в SearchInFilesPanel)

## Keyboard Scope Isolation (R1)

**Обязательный шаг**: добавить guard в `useKeyboardShortcuts.ts` для 6 конфликтующих shortcuts:

```typescript
// В useKeyboardShortcuts.ts:
const editorOpen = useStore(s => s.editorProjectPath !== null);
// В handler — early return для конфликтов при editorOpen === true
```

Конкретные конфликты: `Cmd+W` (:155), `Cmd+B` (:271), `Cmd+F` (:241), `Cmd+Shift+[/]` (:177), `Ctrl+Tab` (:81).

Плюс в `useEditorKeyboardShortcuts.ts` — все CM6 keybindings с `stopPropagation: true` как safety net.

**Keyboard scope для диалогов внутри editor**: Escape в QuickOpenDialog/SearchInFilesPanel закрывает ДИАЛОГ, не overlay. Реализация: диалоги вызывают `e.stopPropagation()` на Escape, overlay слушает Escape только когда нет открытых диалогов (state-guard `quickOpenVisible || searchPanelVisible`).

## Изменения в существующих файлах (доп.)

| # | Файл | Изменение |
|---|------|-----------|
| 9 | `src/renderer/hooks/useKeyboardShortcuts.ts` | Guard `editorOpen` → early return для 6 конфликтующих shortcuts (R1) |

## UX-требования

- `Cmd+Shift+[`/`]` для табов (НЕ `Cmd+[/]` -- это indent/outdent!)
- `Cmd+B` toggle sidebar, width persist в localStorage
- `Cmd+G` go to line (CM6 gotoLine)
- EmptyState показывает шпаргалку shortcuts
- Кнопка `?` в header overlay
- Breadcrumb: каждый сегмент кликабелен -- открывает папку в дереве

## Тестирование

| # | Что тестировать | Файл |
|---|----------------|------|
| 1 | `FileSearchService` -- поиск по mock файлам, лимиты | `test/main/services/editor/FileSearchService.test.ts` |
| 2 | `useEditorKeyboardShortcuts` -- обработка горячих клавиш | `test/renderer/hooks/useEditorKeyboardShortcuts.test.ts` |
| 3 | `fileIcons.ts` -- маппинг расширений | `test/renderer/components/team/editor/fileIcons.test.ts` |
| 4 | Виртуализация: benchmark 5000+ файлов, FPS >= 55fps | — |
| 5 | Manual: Cmd+P, Cmd+Shift+F, навигация клавиатурой | — |

## Критерии готовности

- [ ] Cmd+P открывает quick open с fuzzy search
- [ ] Cmd+Shift+F показывает результаты поиска по содержимому
- [ ] Все горячие клавиши из таблицы работают
- [ ] Breadcrumb-навигация для текущего файла
- [ ] Иконки файлов по типу в дереве и вкладках
- [ ] File tree виртуализирован, скролл плавный

## Оценка

- **Надёжность решения: 7/10** -- виртуализация и search добавляют сложность, но библиотеки проверены.
- **Уверенность: 7/10** -- много нового UI, но каждый компонент изолирован.
