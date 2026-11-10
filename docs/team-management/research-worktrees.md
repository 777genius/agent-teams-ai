# Research: Git Worktrees + Agent Teams + Process Launch

## Статус: Phase 2 (после базовой реализации Team Management)

---

## ЧАСТЬ 1: Текущая ситуация

### Agent Teams работают в ОДНОМ каталоге

Все тиммейты шарят один `cwd` — нет встроенной поддержки worktrees для команд.

```
Lead + Teammate-1 + Teammate-2 → все в /project/
→ Два агента могут редактировать один файл → перезапись
→ "Решение" Claude Code: лид вручную назначает разные файлы разным агентам
```

### Worktrees в Claude Code — отдельный механизм

Worktrees существуют как способ **ручного параллелизма пользователя**:
```bash
git worktree add ../project-feature-a -b feature-a
cd ../project-feature-a
claude  # Новая независимая сессия
```

Это НЕ связано с Agent Teams. Каждый worktree = отдельный процесс claude, никакой координации.

### У Task tool нет параметра cwd

При спавне тиммейта через Task нельзя указать рабочую директорию. Тиммейт наследует `cwd` лидера.

---

## ЧАСТЬ 2: Существующая инфраструктура в Agent Teams

### Уже реализовано (можно переиспользовать)

| Компонент | Файл | Что делает |
|-----------|------|-----------|
| `GitIdentityResolver` | `src/main/services/parsing/GitIdentityResolver.ts` | Определяет worktree vs main repo, извлекает branch, remote URL |
| `WorktreeGrouper` | `src/main/services/discovery/WorktreeGrouper.ts` | Группирует проекты по git repository |
| `WorktreeBadge` | `src/renderer/components/common/WorktreeBadge.tsx` | UI badge для типа worktree (8 типов) |
| `repositorySlice` | `src/renderer/store/slices/repositorySlice.ts` | Store: repos, worktrees, grouped/flat view |
| `worktreePatterns` | `src/main/constants/worktreePatterns.ts` | 8 типов: vibe-kanban, conductor, auto-claude, 21st, claude-desktop, ccswitch, git, unknown |
| `SidebarHeader` | `src/renderer/components/layout/SidebarHeader.tsx` | Dropdown с repo → worktree навигацией |

### config.json содержит cwd у members

```json
{
  "members": [
    {
      "name": "team-lead",
      "cwd": "/Users/belief/dev/projects/modularity"  // Все members имеют ОДИНАКОВЫЙ cwd
    }
  ]
}
```

Поле есть, но все members указывают одну директорию.

---

## ЧАСТЬ 3: Идея — Запуск Claude Process из UI

### Суть

Пользователь хочет не просто **просматривать** команды, но и **запускать** Claude Code процессы прямо из Electron UI. С предконфигурацией:

1. Выбрать рабочую директорию (может быть worktree)
2. Настроить agent teams заранее
3. Запустить claude процесс с нужными параметрами
4. Worktree создаётся автоматически перед запуском

### Сценарии использования

#### Сценарий 1: Запуск одиночного Claude

```
UI: [Выбрать директорию] → [Запустить Claude]
→ spawn('claude', [], { cwd: '/selected/path' })
```

#### Сценарий 2: Запуск с предсозданным worktree

```
UI: [Выбрать репо] → [Создать worktree для branch X] → [Запустить Claude в worktree]
→ git worktree add ../project-branch-x -b branch-x
→ spawn('claude', [], { cwd: '../project-branch-x' })
```

#### Сценарий 3: Запуск команды с worktrees для каждого тиммейта

```
UI: [Настроить команду]
  - Lead: /project (main)
  - Teammate-1: /project-wt1 (branch auth)
  - Teammate-2: /project-wt2 (branch api)

→ git worktree add ../project-wt1 -b auth
→ git worktree add ../project-wt2 -b api
→ spawn('claude', ['--prompt', 'Create team... Teammate-1 works in /project-wt1...'], { cwd: '/project' })
```

#### Сценарий 4: Worktree per-task

```
UI: [Создать задачу] → [Auto-create worktree] → [Assign to teammate]
→ git worktree add ../project-task-15 -b task-15
→ Prompt: "For task #15, work in /project-task-15"
```

### Технические вопросы

#### Как запустить claude из Electron?

```typescript
import { spawn } from 'child_process';

const claude = spawn('claude', ['--prompt', initialPrompt], {
  cwd: workingDirectory,
  env: {
    ...process.env,
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',  // Если нужны teams
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

// Слушаем stdout для отслеживания прогресса?
claude.stdout.on('data', (data) => { /* ... */ });
```

**Вопросы**:
- claude запускается как interactive CLI. Можно ли передать начальный промпт через args?
- Есть ли headless/non-interactive режим? (`claude --message "..."` — да, но одноразовый)
- Как мониторить процесс после запуска?
- Как связать запущенный процесс с нашим UI?

#### Claude CLI аргументы (известные)

```bash
claude                          # Interactive REPL
claude "prompt here"            # One-shot (non-interactive? needs check)
claude --resume <session-id>    # Resume session
claude --continue               # Continue last session
claude -p "prompt"              # Print mode (non-interactive, output to stdout)
```

**Нужно исследовать**:
- Как запустить interactive сессию с начальным промптом
- Можно ли передать agent teams конфигурацию через аргументы
- Как получить session ID запущенного процесса

#### Worktree lifecycle

```
Создание:   git worktree add <path> -b <branch>
Удаление:   git worktree remove <path>
Список:     git worktree list
```

**Вопросы**:
- Когда удалять worktree? После завершения задачи/команды?
- Как мержить изменения из worktree обратно в main?
- Что если worktree "зависает" (процесс упал)?

---

## ЧАСТЬ 4: Варианты архитектуры

### A: Prompt Injection (простой, хрупкий)

```
1. UI создаёт worktrees
2. В .claude/rules/worktrees.md: "Teammate X must cd to /path"
3. Агент (надеемся) делает cd
```

**Compliance**: ~70-80%
**Сложность**: низкая
**Риск**: агент забудет cd, или cd обратно

### B: Отдельные сессии (надёжный, без Teams)

```
1. UI создаёт worktrees
2. Запускает N отдельных claude процессов в разных worktrees
3. Координация через наш UI (Kanban, inbox messaging)
4. Нет встроенных Teams инструментов
```

**Isolation**: 100%
**Сложность**: высокая (наша координация вместо Teams)
**Плюс**: полный контроль

### C: Гибрид (3 режима)

```
shared       — один каталог (текущее поведение Teams)
per-teammate — worktree на каждого тиммейта
per-task     — worktree на каждую задачу
```

Юзер выбирает режим при создании команды. UI создаёт worktrees и инжектирует правила.

### D: Только визуализация (безопасный)

```
Не управляем worktrees
Только показываем какой тиммейт в каком каталоге
Группировка через repositorySlice
```

---

## ЧАСТЬ 5: Открытые вопросы для Phase 2

1. **Как запустить claude с начальным промптом из Electron?**
   - Нужно исследовать CLI аргументы подробнее
   - Есть ли способ передать initial team config?

2. **Можно ли контролировать cwd тиммейта?**
   - Через промпт lead'а: "spawn teammate in /path/to/worktree"
   - Через config.json manipulation?
   - Compliance?

3. **Worktree cleanup**
   - Автоматическое удаление при завершении команды?
   - UI кнопка "Cleanup worktrees"?
   - Что делать с uncommitted changes?

4. **Merge strategy**
   - Как мержить worktree branches обратно?
   - Кнопка "Merge all" в UI?
   - Conflict resolution?

5. **Process monitoring**
   - Как отслеживать запущенный claude процесс?
   - Как получить его session ID?
   - Как определить что процесс завершился?

6. **Integration с Team Management**
   - Worktree mode как часть team creation flow?
   - Или отдельная фича?
   - Как связать worktree с конкретным тиммейтом/задачей?

---

## Решение

**Phase 2** — после базовой реализации Team Management (Kanban, messaging, members).
Требует дополнительного ресёрча по claude CLI аргументам и process management.
