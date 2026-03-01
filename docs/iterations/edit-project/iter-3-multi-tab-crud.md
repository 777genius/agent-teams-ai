# Итерация 3: Multi-tab + создание/удаление файлов

> Зависит от: [Итерация 2](iter-2-editable-save.md)

## Цель

Поддержка нескольких открытых файлов во вкладках. Контекстное меню: создать файл/папку, удалить. Tab management.

## Новые npm-зависимости

`@radix-ui/react-context-menu` (`pnpm add @radix-ui/react-context-menu`) — для нативного контекстного меню. Проверить текущие `@radix-ui/*` версии в package.json и использовать совместимую.

## IPC каналы

| Канал | Описание |
|-------|----------|
| `editor:createFile` | Создать файл (validateFileName + валидация parentDir) |
| `editor:createDir` | Создать директорию |
| `editor:deleteFile` | Удалить файл через `shell.trashItem()` (безопасно) |

## Новые файлы

| # | Файл | Описание |
|---|------|----------|
| 1 | `src/renderer/components/team/editor/EditorContextMenu.tsx` | Context menu (New File, New Folder, Delete, Reveal in Finder) |
| 2 | `src/renderer/components/team/editor/NewFileDialog.tsx` | Inline-input для имени файла/папки |
| 3 | `src/renderer/utils/tabLabelDisambiguation.ts` | `getDisambiguatedTabLabel()` для дублей "index.ts" |

## Изменения в существующих файлах

| # | Файл | Изменение |
|---|------|-----------|
| 1 | `src/shared/types/editor.ts` | Типы для create/delete |
| 2 | `src/shared/types/api.ts` | `createFile`, `createDir`, `deleteFile` в EditorAPI |
| 3 | `src/main/services/editor/ProjectFileService.ts` | `createFile()`, `createDir()`, `deleteFile()` |
| 4 | `src/main/ipc/editor.ts` | 3 новых handler |
| 5 | `src/preload/index.ts` | 3 новых метода |
| 6 | `src/preload/constants/ipcChannels.ts` | `EDITOR_CREATE_FILE`, `EDITOR_CREATE_DIR`, `EDITOR_DELETE_FILE` |
| 7 | `src/renderer/components/team/editor/EditorTabBar.tsx` | Multi-tab: массив, переключение, close, middle-click close |
| 8 | `src/renderer/components/team/editor/EditorFileTree.tsx` | Right-click context menu, refresh после create/delete |
| 9 | `src/renderer/store/slices/editorSlice.ts` | Tab management actions, file operations |

## Security-требования

1. `createFile`: `validateFileName()` -- запрет `.`, `..`, control chars, path separators, NUL, length > 255. Валидировать и `parentDir`, и `path.join(parentDir, name)` (SEC-7)
2. `deleteFile`: `shell.trashItem()`, НЕ `fs.unlink()`. `validateFilePath()` обязательна
3. Confirmation dialog перед удалением
4. `createFile`, `createDir`, `deleteFile`: `isGitInternalPath()` блокирует операции внутри `.git/` (SEC-12, аналог writeFile из iter-2)

## Performance-требования

- Tab closing: `stateCache.delete(tabId)` (явная очистка памяти). closeAllTabs: `stateCache.clear()`
- Debounce обновления дерева после create/delete (500ms), не перечитывать после каждой операции

## UX-требования

- Disambiguation tab labels: два "index.ts" -> "(main/utils)" и "(renderer/utils)"
- Длинные имена: max-width ~160px, `truncate`, tooltip. Modified dot ПЕРЕД текстом
- ARIA для tab bar: `role="tablist"`, `role="tab"`, `aria-selected`, `role="tabpanel"`

## Тестирование

| # | Что тестировать | Файл |
|---|----------------|------|
| 1 | `ProjectFileService.createFile/deleteFile` с mock fs | `test/main/services/editor/ProjectFileService.test.ts` (расширение) |
| 2 | `editorSlice` -- multi-tab actions (open, close, reorder) | `test/renderer/store/editorSlice.test.ts` (расширение) |
| 3 | `tabLabelDisambiguation.ts` -- unit тесты | `test/renderer/utils/tabLabelDisambiguation.test.ts` |
| 4 | `EditorContextMenu` -- рендеринг, клики | `test/renderer/components/team/editor/EditorContextMenu.test.ts` |
| 5 | Manual: несколько файлов -> вкладки -> создать файл -> удалить файл | — |

## Критерии готовности

- [ ] Несколько файлов открыты одновременно
- [ ] Вкладки переключаются, закрываются (X, middle-click)
- [ ] Right-click -> New File, New Folder, Delete
- [ ] Создание файла добавляет в дерево + автоматически открывает
- [ ] Удаление через Trash с confirmation
- [ ] Disambiguation labels для дублирующихся имён

## Оценка

- **Надёжность решения: 7/10** -- file operations с правильной валидацией и trash -- надёжный подход.
- **Уверенность: 8/10** -- паттерны файловых операций отработаны.
