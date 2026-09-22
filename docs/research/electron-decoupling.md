# Electron Decoupling Audit

> Дата аудита: 2026-03-08

## Executive Summary

Кодовая база **на 68% независима от Electron**. Только 30 из 692 файлов имеют прямые Electron импорты. Миграция оценивается в 4-6 недель, в основном механический рефакторинг.

## Структура кодовой базы

| Категория | Файлов | % | Electron-зависимость |
|-----------|:------:|:-:|---------------------|
| Renderer (React) | 473 | 68% | Нет — pure React, работает в браузере |
| Main (Services) | ~140 | 20% | Минимальная — pure Node.js |
| Main (IPC handlers) | 22 | 3% | Да — `ipcMain.handle()` |
| Main (Electron APIs) | 8 | 1% | Да — BrowserWindow, app, dialog, shell |
| Preload | 2 | 0.3% | Да — contextBridge |
| Shared (types/utils) | 45 | 6.5% | Нет — полностью agnostic |

## Уже реализованная инфраструктура отвязки

### 1. HTTP Server (Fastify)
- **Файл**: `src/main/services/infrastructure/HttpServer.ts` (179 LOC)
- Работает на `127.0.0.1:3456`
- Раздаёт статику + API роуты
- CORS настроен для standalone режима

### 2. HTTP Routes (80% покрытие)
- **Директория**: `src/main/http/`
- 13 файлов роутов, дублируют IPC handlers:
  - projects, sessions, search, subagents
  - config, notifications, utility, validation
  - ssh, updater, events, schedule

### 3. HttpAPIClient
- **Файл**: `src/renderer/api/httpClient.ts` (400+ LOC)
- Полная имплементация `ElectronAPI` интерфейса
- EventSource (SSE) для real-time событий
- Fetch для request/response

### 4. Unified API Proxy
- **Файл**: `src/renderer/api/index.ts`
- Автоматически переключается между:
  - `window.electronAPI` (Electron mode)
  - `HttpAPIClient` (browser mode)
- Прозрачно для всех компонентов

### 5. Standalone Entry Point
- **Файл**: `src/main/standalone.ts`
- Запускает HTTP сервер без Electron
- Стабит UpdaterService, SshConnectionManager
- Протестирован и работает

## 30 файлов с Electron импортами

### ipcMain (22 файла)
```
src/main/ipc/handlers.ts          — оркестратор
src/main/ipc/cliInstaller.ts
src/main/ipc/config.ts            — + dialog, BrowserWindow
src/main/ipc/context.ts
src/main/ipc/editor.ts            — + BrowserWindow
src/main/ipc/extensions.ts
src/main/ipc/httpServer.ts
src/main/ipc/notifications.ts
src/main/ipc/projects.ts
src/main/ipc/rendererLogs.ts
src/main/ipc/review.ts
src/main/ipc/schedule.ts
src/main/ipc/search.ts
src/main/ipc/sessions.ts
src/main/ipc/ssh.ts
src/main/ipc/subagents.ts
src/main/ipc/teams.ts             — + BrowserWindow, Notification
src/main/ipc/terminal.ts
src/main/ipc/updater.ts
src/main/ipc/utility.ts           — + shell
src/main/ipc/validation.ts
src/main/ipc/window.ts            — + app, BrowserWindow
```

### Другие Electron API
```
src/main/index.ts                                    — app, BrowserWindow, ipcMain
src/main/utils/pathDecoder.ts                        — app.getPath('home')
src/main/services/infrastructure/UpdaterService.ts   — BrowserWindow, electron-updater
src/main/services/infrastructure/NotificationManager.ts — Notification
src/preload/index.ts                                 — contextBridge, ipcRenderer
```

## Замена каждого Electron API

| API | Файлов | Замена | Усилия |
|-----|:------:|--------|:------:|
| `ipcMain.handle()` | 22 | HTTP роуты (80% уже есть) | 3-4ч |
| `BrowserWindow` | 6 | Убрать (браузер сам управляет) | 1-2ч |
| `app` lifecycle | 2 | Прямой запуск Node.js сервера | 4-5ч |
| `dialog.showOpenDialog()` | 1 | HTML `<input type="file">` / env var | 3ч |
| `shell.openExternal/Path` | 1 | `window.open()` / убрать | 1ч |
| `Notification` | 2 | Browser Notification API | 2ч |
| `electron-updater` | 1 | GitHub releases redirect | 2ч |
| `contextBridge` | 1 | Убрать полностью | 1ч |

## Оценка миграции

| Метрика | Значение |
|---------|----------|
| Сложность | 6/10 — механический рефакторинг |
| Объём работы | 4-6 недель |
| Вероятность успеха | 95% |
| Уверенность в оценке | 9/10 |

## Фазы миграции

### Phase 1: Setup (2-3 дня)
- Рефакторинг `src/main/index.ts` в pure HTTP server bootstrap
- Удаление Electron app lifecycle
- HTTP server как primary entry point

### Phase 2: IPC → HTTP (3-4 дня)
- Завершить оставшиеся HTTP роуты (~20%)
- Удалить все `ipcMain.handle()` вызовы
- SSE для event delivery

### Phase 3: Desktop-Only Features (2-3 дня)
- Убрать auto-updater → version check API
- Убрать dialog → env var / HTML input
- Убрать shell → client-side links
- Browser Notification API

### Phase 4: Build System (2-3 дня)
- `electron-vite` → стандартный Vite
- Убрать preload bundling
- Docker build config

### Phase 5: Testing (2-3 дня)
- HTTP endpoint coverage
- Browser compatibility
- Docker deployment

## Что нельзя заменить (Electron-only)
- Auto-update бинарных патчей → GitHub releases
- System tray → убрать
- Native menu → web context menus
- System hotkeys → browser keyboard events
- Native file dialogs → HTML file input

## Build изменения

**Текущий:**
```json
"dev": "electron-vite dev",
"build": "electron-vite build",
"dist": "electron-builder --mac --win --linux"
```

**После миграции:**
```json
"dev": "tsx src/main/standalone.ts & vite",
"build": "vite build && tsc --noEmit",
"start": "node dist/main/index.cjs",
"docker": "docker build -t claude-teams ."
```
