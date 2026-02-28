# In-App Code Editor — План реализации

## Обзор

На странице `TeamDetailView` рядом с путём проекта (`data.config.projectPath`) добавляется кнопка "Open in Editor", открывающая полноэкранный редактор кода прямо внутри приложения. Редактор позволяет просматривать файловое дерево проекта, открывать файлы во вкладках с подсветкой синтаксиса, редактировать и сохранять их, создавать/удалять файлы, искать по содержимому, и отображать git-статусы.

## Tech Stack

- **Editor engine**: CodeMirror 6 (20+ пакетов `@codemirror/*` уже в `package.json`, 16 языковых пакетов)
- **Не ProseMirror**: ProseMirror -- rich-text WYSIWYG, CodeMirror -- код-редактор. Один автор (Marijn Haverbeke), CM6 уже глубоко интегрирован
- **UI**: React 18, Tailwind CSS, lucide-react иконки, Radix UI (контекстное меню, confirm dialog)
- **State**: Zustand slice (`editorSlice.ts`)
- **Виртуализация**: `@tanstack/react-virtual` (уже в проекте)
- **Fuzzy search**: `cmdk` v1.0.4 (уже в зависимостях)
- **Новые npm-зависимости**: `@codemirror/search` (~15KB gzipped) — для встроенного Cmd+F поиска в файле. Остальное уже установлено

## Ключевые архитектурные решения

| Решение | Обоснование |
|---------|-------------|
| `ProjectFileService` (не `FileEditorService`) | Лучше отражает scope; аналог `TeamDataService` |
| Stateless сервис (без `rootPath` в конструкторе) | Каждый метод принимает `projectRoot`; не привязан к одному проекту |
| EditorState pooling (не CSS show/hide) | Один EditorView + `Map<tabId, EditorState>` в useRef; экономия RAM ~8-12x |
| `editorModifiedFiles: Set<string>` (не `Record<string, string>`) | Контент живёт только в CM6 EditorState; 0 re-render при наборе текста |
| `validateFilePath()` из `pathValidation.ts` (не свой `assertInsideRoot`) | Уже проверяет traversal, symlinks, sensitive patterns, cross-platform |
| `projectRoot` в module-level state (не от renderer) | Фиксируется при `editor:open`; IPC handlers берут из state |
| Overlay вместо Radix Dialog | Radix Dialog ограничивает фокус, конфликтует с CM6 |

## Навигация по плану

| Файл | Содержимое |
|------|------------|
| [architecture.md](architecture.md) | Архитектура, безопасность, state, IPC API, сервисы, компоненты, CM6, shortcuts, CSS |
| [iter-0-refactoring.md](iter-0-refactoring.md) | PR 0: Обязательные рефакторинги R1-R4 (отдельный PR) |
| [iter-1-walking-skeleton.md](iter-1-walking-skeleton.md) | Итерация 1: Read-only файловый браузер |
| [iter-2-editable-save.md](iter-2-editable-save.md) | Итерация 2: Editable CodeMirror + сохранение |
| [iter-3-multi-tab-crud.md](iter-3-multi-tab-crud.md) | Итерация 3: Multi-tab + создание/удаление файлов |
| [iter-4-search-shortcuts.md](iter-4-search-shortcuts.md) | Итерация 4: Горячие клавиши, поиск, UX polish |
| [iter-5-git-watching.md](iter-5-git-watching.md) | Итерация 5: Git status, file watching, conflict detection |
| [file-list.md](file-list.md) | Риски, бенчмарки, полный список файлов |

## Общая статистика

- **Новые файлы**: ~30
- **Модификации**: ~17 существующих файлов
- **Тесты**: ~15 новых тестовых файлов
- **Итерации**: 6 (PR 0 + 5 итераций)
