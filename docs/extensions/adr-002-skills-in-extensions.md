# ADR-002: Skills In Extensions

**Date**: 2026-03-11
**Status**: Accepted

## Context

Нужно добавить в `Extensions` first-class раздел `Skills`, не смешивая его ни с `Plugins`, ни с `MCP`, и не строя отдельный remote marketplace.

Нужны были ответы на три вопроса:

1. Делаем ли отдельный внешний skills registry/API?
2. Можно ли переиспользовать текущий project editor backend как есть?
3. Какой runtime contract должен быть у локальных skills?

## Decision Matrix

### Option A: Remote skills marketplace/API

Плюсы:
- единый внешний source of truth;
- потенциально install/publish flows позже.

Минусы:
- не нужен для текущего local-first usage;
- добавляет moderation, trust, publishing, auth и sync surface;
- не соответствует текущему продукту "runs entirely locally".

Decision: **Rejected for this phase**.

### Option B: Treat skills as MCP/plugin variants

Плюсы:
- меньше новых surface areas.

Минусы:
- семантически неверно: `MCP` = tools/integrations, `Skills` = reusable instructions/workflows;
- разные security and discovery models;
- contracts начинают смешиваться и размывать UX.

Decision: **Rejected**.

### Option C: Local-first Skills domain inside Extensions

Плюсы:
- соответствует реальному source of truth: filesystem skill roots;
- хорошо ложится в existing `Extensions` shell;
- позволяет безопасно поддержать discovery, preview, authoring и review;
- не требует marketplace/runtime model changes.

Минусы:
- нужен отдельный typed IPC/API слой;
- нужен dedicated security model для non-project roots.

Decision: **Accepted**.

## Final Decisions

### 1. Skills are a separate domain

- `Plugins` остаются installable plugin packages.
- `MCP` остаётся tooling/integration surface.
- `Skills` становятся local-first reusable workflow/instruction packages.

### 2. No external skills API in V1/V1.5

В этом проходе не делаем:

- remote registry;
- GitHub one-click install without review;
- publishing pipeline;
- trust badges / moderation / verification.

### 3. Dedicated internal Skills API

Renderer работает через отдельный typed contract:

- list/detail
- preview/apply upsert
- preview/apply import
- delete
- focused watch start/stop + change events

Это отдельный Skills domain API, а не переиспользование project editor IPC.

### 4. Reuse renderer components, not editor backend assumptions

Разрешён reuse:

- CodeMirror-based editor UI
- Markdown preview/viewers
- Diff viewer
- dialog/button/badge primitives

Не reuse as-is:

- current `editor.open(projectPath)` backend
- project-root-only editor security assumptions

### 5. Source of truth = supported local roots

Supported roots:

- project: `.claude/skills`, `.cursor/skills`, `.agents/skills`
- user: `~/.claude/skills`, `~/.cursor/skills`, `~/.agents/skills`

### 6. Project context is pinned per Extensions tab

`Extensions` tab stores optional `projectId` and does not silently follow later global selection changes.

Seed rule:

- primary: `selectedProjectId`
- fallback: `activeProjectId`

### 7. Refresh strategy

- `V1`: mount refresh, manual refresh, mutation refresh
- `V1.5`: focused watcher only while Skills tab is mounted

No always-on global watcher service for all windows/contexts.

## Consequences

Плюсы:
- clearer contracts and UX boundaries;
- safer filesystem mutations;
- predictable per-tab project context;
- easier future extension toward generation/review/publishing.

Минусы:
- больше отдельных services/files;
- skills lifecycle needs dedicated tests and docs.

## Implementation Notes

Implementation was performed in a separate worktree/branch to avoid mixing with the user's dirty main worktree, per plan.
