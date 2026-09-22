# Исследование: встраивание Git UI в Electron + React приложение

> Дата: 2026-02-25

## TL;DR

**Готового `<GitPanel repo="/path" />` компонента не существует.** Все Git GUI (GitHub Desktop, GitButler, Ungit) — монолитные приложения с тесно связанными компонентами. Реалистичный путь — собрать из кирпичиков или встроить терминал с lazygit.

---

## Оглавление

1. [Git Backend библиотеки](#1-git-backend-библиотеки)
2. [UI-компоненты (npm-пакеты)](#2-ui-компоненты-npm-пакеты)
3. [Open-source Git GUI приложения (референсы)](#3-open-source-git-gui-приложения)
4. [IDE-embedded Git UI (не извлекаемые)](#4-ide-embedded-git-ui)
5. [Подходы к интеграции](#5-подходы-к-интеграции)
6. [Итоговая сравнительная таблица](#6-итоговая-сравнительная-таблица)
7. [Рекомендация](#7-рекомендация)

---

## 1. Git Backend библиотеки

Обеспечивают программный доступ к Git-операциям из Node.js/Electron.

### simple-git ⭐ РЕКОМЕНДУЕТСЯ

- **GitHub**: [simple-git-js/simple-git](https://github.com/simple-git-js/simple-git)
- **Stars**: ~3,550
- **npm downloads**: ~5.8M/week
- **Версия**: 3.32.2 (февраль 2026)
- **Лицензия**: MIT
- **Тип**: CLI wrapper (требует git binary)
- **Особенности**:
  - Легковесная обертка вокруг `git` CLI
  - ES Modules, CommonJS, TypeScript
  - Async/await, promise chaining
  - Progress monitoring для clone/checkout
  - Concurrency control (`maxConcurrentProcesses`)
- **Плюсы**: Простейший API, самые высокие downloads, отличная TS поддержка, активно поддерживается
- **Минусы**: Требует установленный Git на машине; спавнит shell-процессы

```typescript
import simpleGit, { SimpleGit } from 'simple-git';

const git: SimpleGit = simpleGit('/path/to/repo');

const status = await git.status();           // modified, staged, not_added
const log = await git.log({ maxCount: 50 }); // hash, date, message, author
const diff = await git.diff(['--staged']);    // staged diff
const branches = await git.branch();         // all branches
await git.add(['src/file.ts']);
await git.commit('fix: resolve issue');
await git.stash(['push', '-m', 'WIP']);
```

### isomorphic-git

- **GitHub**: [isomorphic-git/isomorphic-git](https://github.com/isomorphic-git/isomorphic-git)
- **Stars**: ~8,100
- **npm downloads**: ~300-600K/week
- **Версия**: 1.37.1 (февраль 2026)
- **Лицензия**: MIT
- **Тип**: Pure JavaScript Git implementation
- **Особенности**:
  - Pure JS — zero native dependencies
  - Работает в Node.js И в browser/renderer
  - Clone, commit, push, pull, fetch, branch, merge, checkout
  - 100% совместимость с canonical git
  - Читает/пишет `.git` директорию напрямую
- **Плюсы**: Нет нативных зависимостей, работает везде
- **Минусы**: Медленнее нативных реализаций на больших репо; некоторые продвинутые git-фичи отсутствуют

### dugite

- **GitHub**: [desktop/dugite](https://github.com/desktop/dugite)
- **Stars**: ~495
- **npm downloads**: ~3-6K/week
- **Версия**: 2.7.1
- **Лицензия**: MIT
- **Тип**: Бандлит git binary (свой Git в пакете)
- **Особенности**:
  - Поставляет скомпилированный Git binary — пользователю НЕ нужен установленный Git
  - TypeScript
  - Используется GitHub Desktop (проверено в production)
  - Создан командой GitHub Desktop
- **Плюсы**: Гарантия наличия Git; battle-tested
- **Минусы**: Увеличивает размер бандла; возможные проблемы с corporate proxy

### nodegit ❌ НЕ РЕКОМЕНДУЕТСЯ

- **GitHub**: [nodegit/nodegit](https://github.com/nodegit/nodegit)
- **Stars**: ~5,750
- **Тип**: Native C++ bindings к libgit2
- **Проблемы**: Плохо поддерживается (последний stable-релиз много лет назад); нативный C++ build ломается; persistent проблемы совместимости с Electron
- **Вердикт**: Не использовать для новых проектов

---

## 2. UI-компоненты (npm-пакеты)

### Diff Viewers

#### @git-diff-view/react ⭐ РЕКОМЕНДУЕТСЯ

- **GitHub**: [MrWangJustToDo/git-diff-view](https://github.com/MrWangJustToDo/git-diff-view)
- **Версия**: 0.0.36 (февраль 2026, активно обновляется)
- **Лицензия**: MIT
- **Особенности**:
  - GitHub-parity UI (выглядит как GitHub diff)
  - Web Worker для 60fps рендеринга
  - Split и unified views
  - Zero dependencies, pure CSS
  - SSR/RSC support
  - **Virtual scrolling** — ~280ms рендер 10K+ строк
  - Multi-framework (React, Vue, Solid, Svelte)
- **Плюсы**: Самый активно поддерживаемый; лучшая производительность; GitHub-quality UI
- **Минусы**: Pre-1.0 (v0.0.x)

#### react-diff-view

- **GitHub**: [otakustay/react-diff-view](https://github.com/otakustay/react-diff-view)
- **Stars**: ~977 | **Downloads**: ~140K/week
- **Версия**: 3.3.2
- **Лицензия**: MIT
- **Особенности**:
  - Принимает `git diff -U1` output напрямую (самый git-native)
  - Split и unified views
  - Collapsed code expansion
  - Code comments support
  - Large diff lazy loading
  - Гибкая система decoration/widget
- **Плюсы**: Самый Git-native; хорошая производительность; extensible

#### react-diff-viewer-continued

- **GitHub**: [ralzinov/react-diff-viewer-continued](https://github.com/ralzinov/react-diff-viewer-continued)
- **Версия**: 3.4.0
- **Лицензия**: MIT
- **Описание**: Maintained форк заброшенного react-diff-viewer. Split/inline view, word diff, GitHub-style

#### Monaco DiffEditor (@monaco-editor/react)

- **GitHub**: [suren-atoyan/monaco-react](https://github.com/suren-atoyan/monaco-react)
- **Описание**: VS Code Monaco Editor с встроенным DiffEditor
- **Плюсы**: Production-grade (тот же движок что в VS Code); отличная подсветка синтаксиса
- **Минусы**: Тяжелый бандл; overkill если нужен только просмотр diff

### Commit Graph Visualization

#### @dolthub/gitgraph-react

- **npm**: [@dolthub/gitgraph-react](https://www.npmjs.com/package/@dolthub/gitgraph-react)
- **Описание**: Живой форк архивированного @gitgraph/react, поддерживается DoltHub
- **Плюсы**: Активный форк; декларативный API
- **Минусы**: Кастомизирован под нужды DoltHub

#### @gitgraph/react ❌ АРХИВИРОВАН

- **GitHub**: [nicoespeon/gitgraph.js](https://github.com/nicoespeon/gitgraph.js)
- **Downloads**: ~4,300/week
- **Статус**: Архивирован с 2019. Автор рекомендует Mermaid.js

#### Mermaid.js + @mermaid-js/react-wrapper

- **GitHub**: [mermaid-js/mermaid](https://github.com/mermaid-js/mermaid)
- **Stars**: ~60,000+
- **Лицензия**: MIT
- **Описание**: Нативный `gitGraph` тип диаграмм. Text-based DSL
- **Плюсы**: Огромное сообщество, активно поддерживается
- **Минусы**: Text-based input; больше для документации/иллюстраций, чем для интерактивных графов

#### commit-graph (CommitGraph)

- **GitHub**: [liuliu-dev/CommitGraph](https://github.com/liuliu-dev/CommitGraph)
- **Описание**: Interactive commit graph с infinite scrolling и pagination
- **Особенности**: `commitSpacing`, `branchSpacing`, `nodeRadius`, `branchColors`, `onCommitClick`
- **Плюсы**: Построен для реальных данных; пагинация
- **Минусы**: Новый, мало adoption

#### @gitkraken/gitkraken-components

- **npm**: v11.0.7 (февраль 2026)
- **Описание**: Shared React-компоненты между GitKraken Desktop и GitLens. Включает `GraphContainer` для commit graph
- **Плюсы**: Production-proven (GitKraken), активно обновляется
- **Минусы**: **Без документации**, требует React 17, undocumented API

### File Tree

#### react-arborist

- **GitHub**: [brimdata/react-arborist](https://github.com/brimdata/react-arborist)
- **Stars**: ~3,542 | **Downloads**: ~225K/week
- **Версия**: 3.4.3 (февраль 2025)
- **Лицензия**: MIT
- **Описание**: Полное tree view (как VS Code sidebar). Selection, multi-select, drag-and-drop, виртуализация, кастомный рендеринг нод
- **Использование**: Для git staging panel с file tree + status indicators

### Terminal Emulator

#### xterm.js (@xterm/xterm)

- **GitHub**: [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js)
- **Описание**: Полный терминальный эмулятор в браузере/Electron. Используется VS Code, Hyper, Wave Terminal
- **React wrapper**: [Qovery/react-xtermjs](https://github.com/Qovery/react-xtermjs)
- **Использование**: Для встраивания lazygit/tig как терминальной панели

---

## 3. Open-source Git GUI приложения

### GitHub Desktop ⭐ ЛУЧШИЙ РЕФЕРЕНС

- **GitHub**: [desktop/desktop](https://github.com/desktop/desktop)
- **Stars**: ~21,000
- **Стек**: Electron + React + TypeScript
- **Git backend**: dugite
- **Лицензия**: MIT
- **Статус**: Активно поддерживается (февраль 2026)
- **Извлекаемость**: Монолитное приложение. Компоненты тесно связаны с внутренним `git-store.ts`. Нельзя npm install, но можно изучить архитектуру и адаптировать паттерны
- **Ключевые файлы для изучения**: `src/ui/diff/`, `src/ui/history/`, `src/lib/stores/git-store.ts`

### Ungit

- **GitHub**: [FredrikNoren/ungit](https://github.com/FredrikNoren/ungit)
- **Stars**: ~10,456
- **Стек**: Node.js web server (Knockout.js)
- **Лицензия**: MIT
- **Описание**: Web-based Git GUI. Запускает HTTP-сервер на localhost. Есть pre-built Electron-пакеты
- **Встраивание**: Можно через iframe/webview, но свой UI (Knockout.js), невозможно стилизовать

### GitButler

- **GitHub**: [gitbutlerapp/gitbutler](https://github.com/gitbutlerapp/gitbutler)
- **Stars**: ~14,000
- **Стек**: Tauri + Svelte + TypeScript + Rust
- **Лицензия**: Fair Source (→ MIT через 2 года)
- **Извлекаемость**: Не React, не Electron. Есть `@gitbutler/ui` но на Svelte

### Sapling ISL (Facebook) — интересная находка

- **GitHub**: [facebook/sapling](https://github.com/facebook/sapling) → `addons/isl/`
- **Стек**: React 18 + Jotai + StyleX + Vite
- **Лицензия**: MIT
- **Описание**: Interactive Smartlog — web GUI для Sapling SCM
- **Компоненты**: Commit tree visualization, drag-and-drop rebase, commit details panel, PR integration
- **Проблемы**: Заточен под Sapling SCM (не Git напрямую); требует isl-server backend
- **Ценность**: Отличный референс React-архитектуры для Git UI

### Другие

| Проект | Стек | Stars | Статус |
|--------|------|-------|--------|
| Thermal | Electron + Vue | - | Не React |
| Gitamine | Electron + React + NodeGit | 142 | Неактивен (2019), GPL v3 |
| LithiumGit | Electron + TypeScript | 20 | Активен, MIT |
| NeatGit | Electron + React + Tailwind + Vite | 3 | Ранняя разработка |

---

## 4. IDE-embedded Git UI

Все **не извлекаемые** для standalone использования.

### Eclipse Theia (@theia/git)

- **Статус**: **DEPRECATED** — рекомендуют использовать VS Code Git extension
- **Проблемы**: InversifyJS DI-контейнер, PhosphorJS/Lumino виджеты (не React), нужна полная Theia среда
- [Обсуждение Copia Automation](https://github.com/eclipse-theia/theia/discussions/15151) — вывод: проще написать свой view

### VS Code Git Extension

- **Архитектура**: Extension Host + webview API. Глубоко интегрирован в workbench. Не React. С VS Code 1.93 Git Graph встроен
- **Извлекаемость**: Невозможна без переписывания workbench

### Другие IDE

| IDE | Вердикт |
|-----|---------|
| Gitpod / OpenVSCode Server | Форк VS Code, не экспортирует компоненты |
| JetBrains Fleet | Proprietary, Kotlin/Skia рендеринг |
| Sourcegraph | Нет git management компонентов, фокус на code search |

---

## 5. Подходы к интеграции

### Подход A: xterm.js + lazygit (~200 LOC)

Быстрейший путь к полному Git UI.

```
Electron Main Process
  └── node-pty.spawn('lazygit', [], { cwd: repoPath })
        ├── stdout → xterm.js (renderer)
        └── stdin  ← xterm.js keyboard events
```

```typescript
// Main process
import * as pty from 'node-pty';

const ptyProcess = pty.spawn('lazygit', [], {
  name: 'xterm-256color',
  cols: 120, rows: 40,
  cwd: '/path/to/repo',
  env: { ...process.env, TERM: 'xterm-256color' }
});

ptyProcess.onData((data) => mainWindow.webContents.send('terminal:data', data));
ipcMain.on('terminal:input', (_, data) => ptyProcess.write(data));
ipcMain.on('terminal:resize', (_, { cols, rows }) => ptyProcess.resize(cols, rows));
```

```tsx
// Renderer (React)
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

function LazyGitTerminal({ repoPath }: { repoPath: string }) {
  const termRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({
      theme: { background: '#141416' },
      fontSize: 13
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current!);
    fitAddon.fit();

    term.onData((data) => window.api.terminalInput(data));
    window.api.onTerminalData((data: string) => term.write(data));

    return () => term.dispose();
  }, []);

  return <div ref={termRef} className="w-full h-full" />;
}
```

| Критерий | Оценка |
|---|---|
| Сложность | **Низкая** (~200 LOC) |
| React-совместимость | Хорошая (xterm.js оборачивается в компонент) |
| Git-полнота | **Отличная** (lazygit покрывает всё) |
| Кастомизация UI | **Никакая** (черный ящик) |
| Зависимости | `node-pty` (нативный модуль), lazygit должен быть установлен |

### Подход B: Кастомный React UI (из кирпичиков)

```
Electron Main Process
  └── GitService (simple-git)
        ├── IPC: git:status
        ├── IPC: git:log
        ├── IPC: git:diff
        ├── IPC: git:commit
        ├── IPC: git:branch
        ├── IPC: git:checkout
        ├── IPC: git:stash
        └── IPC: git:merge

Electron Renderer (React + Zustand)
  └── gitSlice (status, log, branches, diff)
        ├── GitStatusPanel (кастомный)
        ├── GitLogView + CommitGraph (@dolthub/gitgraph-react)
        ├── GitDiffViewer (@git-diff-view/react)
        ├── CommitForm (кастомный)
        ├── BranchSelector (кастомный)
        └── StashPanel (кастомный)
```

| Критерий | Оценка |
|---|---|
| Сложность | **Высокая** (полная реализация), **Средняя** (базовые функции) |
| React-совместимость | **Идеальная** (нативные React-компоненты, Zustand, Tailwind) |
| Git-полнота | Настраиваемая — от status/commit/diff до полного |
| Кастомизация UI | **Полная** |
| Объем работ | ~500-1000 LOC для базового функционала |

### Подход C: Embed Ungit (iframe)

```
Electron Main Process
  └── spawn('ungit', ['--port', '9001'])

Renderer
  └── <iframe src="http://localhost:9001" />
```

| Критерий | Оценка |
|---|---|
| Сложность | **Низкая** |
| React-совместимость | **Плохая** (чужой UI, Knockout.js) |
| Git-полнота | Хорошая |
| Кастомизация UI | **Никакая** |

---

## 6. Итоговая сравнительная таблица

| Подход | Сложность | React-совместимость | Git-полнота | Кастомизация | Зависимости |
|---|---|---|---|---|---|
| **xterm.js + lazygit** | Низкая | Хорошая | Отличная | Нет | node-pty, lazygit |
| **Кастомный React UI** | Высокая | Идеальная | Настраиваемая | Полная | simple-git, @git-diff-view/react |
| **Embed Ungit** | Низкая | Плохая | Хорошая | Нет | ungit |
| **VS Code SCM API** | Нереальная | Никакая | Отличная | — | — |

---

## 7. Рекомендация

### Гибридная стратегия

**Фаза 1 — Быстрый старт:** xterm.js + lazygit
- Встраиваем lazygit как терминальную панель/вкладку
- Полный git-функционал за ~200 LOC
- Подходит для power-users

**Фаза 2 — Нативный React UI:**
1. `simple-git` как backend через IPC
2. `@git-diff-view/react` для просмотра диффов
3. Кастомные компоненты для status, commit, branches
4. `@dolthub/gitgraph-react` или `commit-graph` для визуализации графа коммитов
5. `react-arborist` для file tree в staging panel

### npm-пакеты для установки

```bash
# Backend
pnpm add simple-git

# UI-компоненты (по мере необходимости)
pnpm add @git-diff-view/react    # diff viewer
pnpm add react-arborist           # file tree
pnpm add @xterm/xterm @xterm/addon-fit  # terminal (для lazygit)

# Commit graph (выбрать один)
pnpm add @dolthub/gitgraph-react  # форк gitgraph.js
pnpm add commit-graph             # interactive commit graph
```

---

## Источники

- [simple-git](https://github.com/simple-git-js/simple-git)
- [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git)
- [dugite](https://github.com/desktop/dugite)
- [GitHub Desktop](https://github.com/desktop/desktop)
- [Ungit](https://github.com/FredrikNoren/ungit)
- [@git-diff-view/react](https://github.com/MrWangJustToDo/git-diff-view)
- [react-diff-view](https://github.com/otakustay/react-diff-view)
- [react-arborist](https://github.com/brimdata/react-arborist)
- [xterm.js](https://xtermjs.org/)
- [node-pty](https://github.com/microsoft/node-pty)
- [Mermaid.js GitGraph](https://mermaid.js.org/syntax/gitgraph.html)
- [@gitkraken/gitkraken-components](https://www.npmjs.com/package/@gitkraken/gitkraken-components)
- [Sapling ISL](https://github.com/facebook/sapling/tree/main/addons/isl)
- [GitButler](https://github.com/gitbutlerapp/gitbutler)
- [Electron Web Embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds/)
- [@theia/git](https://www.npmjs.com/package/@theia/git) (deprecated)
- [VS Code SCM API](https://code.visualstudio.com/api/extension-guides/scm-provider)
