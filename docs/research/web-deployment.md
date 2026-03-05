# Web Deployment: Electron → Web Hybrid

> Дата: 2026-03-04
> Статус: Исследование завершено, рекомендация выбрана

## Цель

Запускать приложение на удалённом сервере с доступом через веб-интерфейс (браузер), сохраняя при этом десктопную Electron-версию.

## Исследованные варианты

---

### 1. `electron-to-web` — Drop-in замена IPC → WebSocket

- **npm**: [electron-to-web](https://libraries.io/npm/electron-to-web)
- **GitHub**: [lsadehaan/electron-to-web](https://github.com/lsadehaan/electron-to-web)
- **Версия**: 0.2.0 (первый релиз — январь 2026)
- **Загрузки**: 0/неделю
- **Зависимости**: `ws`, `json-rpc-2.0`
- **Лицензия**: MIT

**Как работает**: Меняешь 2 импорта (`'electron'` → `'electron-to-web/main'`), и IPC автоматически конвертируется в JSON-RPC over WebSocket. Маппинг: `ipcRenderer.invoke()` → JSON-RPC request, `webContents.send()` → JSON-RPC notification.

**Плюсы**: минимальный объём изменений.
**Минусы**: пакет совсем сырой (v0.2.0, один автор, 0 загрузок). Для продакшна не готов.

| Надёжность | Уверенность |
|------------|-------------|
| 3/10       | 8/10        |

---

### 2. `electron-common-ipc` — IPC-шина с WebSocket

- **GitHub**: [emmkimme/electron-common-ipc](https://github.com/emmkimme/electron-common-ipc)
- **Версия**: 16.0.4 (зрелый проект)
- **Загрузки**: ~35/неделю
- **Суб-пакет**: `@electron-common-ipc/web-socket-browser`

**Как работает**: EventEmitter-like API для обмена данными между любыми процессами (Node, Electron Main/Renderer). Есть WebSocket-расширение для браузера.

**Плюсы**: зрелый пакет, много версий.
**Минусы**: низкоуровневая шина, не drop-in замена Electron IPC. Придётся адаптировать все handlers вручную.

| Надёжность | Уверенность |
|------------|-------------|
| 5/10       | 7/10        |

---

### 3. Neutralino.js — встроенный cloud mode

- **Сайт**: [neutralino.js.org](https://neutralino.js.org/)
- **GitHub**: [neutralinojs/neutralinojs](https://github.com/neutralinojs/neutralinojs) (~22k stars)
- **Документация**: [Modes](https://neutralino.js.org/docs/configuration/modes/)

**Как работает**: Альтернативный фреймворк с 4 режимами из коробки:

| Режим      | Описание                              |
|------------|---------------------------------------|
| `window`   | Нативное окно (как Electron)          |
| `browser`  | Открывает в дефолтном браузере        |
| `chrome`   | Chrome App Mode                       |
| `cloud`    | Запускает как веб-сервер по сети      |

Cloud mode — именно то, что нужно для серверного деплоя. Но это **другой фреймворк**, не совместимый с Electron.

**Плюсы**: встроенная поддержка web-деплоя, лёгкий (~2MB vs ~150MB Electron).
**Минусы**: требует полной переписки приложения.

| Надёжность | Уверенность |
|------------|-------------|
| 7/10       | 6/10        |

---

### ✅ 4. DIY Transport Abstraction (Slack Pattern) — РЕКОМЕНДУЕТСЯ

- **Источник**: [Slack Engineering: Interop's Labyrinth](https://slack.engineering/interops-labyrinth-sharing-code-between-web-electron-apps/)
- **Источник**: [Slack Engineering: Building Hybrid Applications](https://slack.engineering/building-hybrid-applications-with-electron/)

**Как работает**: Абстракция транспортного слоя — фронтенд не знает, работает он через Electron IPC или через WebSocket. Один интерфейс, две реализации:

```typescript
// Интерфейс транспорта
interface IpcTransport {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
  on(channel: string, cb: (...args: unknown[]) => void): () => void;
}

// Electron — для десктоп-версии
class ElectronTransport implements IpcTransport {
  invoke(ch, ...args) { return window.api[ch](...args); }
  on(ch, cb) { return window.api.on(ch, cb); }
}

// WebSocket — для веб-версии
class WebSocketTransport implements IpcTransport {
  private ws: WebSocket;
  invoke(ch, ...args) { /* JSON-RPC через WS */ }
  on(ch, cb) { /* подписка на WS сообщения */ }
}
```

На сервере: Express/Fastify + WebSocket, обработчики зеркалят существующие IPC handlers.

**Плюсы**:
- Проверено Slack в продакшне (миллионы пользователей)
- Полный контроль над архитектурой
- Никаких внешних зависимостей с сомнительным качеством
- ~100 строк кода для абстракции
- Сохраняет обе версии (десктоп + веб)

**Минусы**: нужно написать самим (но объём небольшой).

| Надёжность | Уверенность |
|------------|-------------|
| **9/10**   | **9/10**    |

---

### ✅ 5. Vite Web Build + DIY — РЕКОМЕНДУЕТСЯ

Расширение варианта 4, адаптированное под наш стек.

**Как работает**: `src/renderer/` — уже обычное React SPA на Vite. Его можно собрать отдельно стандартным `vite build` для веба, подменив IPC через абстракцию из п.4.

Архитектура:
```
Сервер (VPS)
├── Node.js сервер (Express/Fastify)
│   ├── HTTP API (зеркало IPC handlers из src/main/)
│   ├── WebSocket (live updates — замена FileWatcher events)
│   └── Claude Code процессы (spawn/manage)
└── Static files (React SPA — vite build из src/renderer/)

Браузер (где угодно)
└── React SPA → HTTP/WS → сервер
```

**Что нужно сделать**:
1. Абстракция транспорта (`IpcTransport` interface) — ~100 LOC
2. `ElectronTransport` — обёртка над `window.api` — ~50 LOC
3. `WebSocketTransport` — JSON-RPC через WS — ~150 LOC
4. Node.js HTTP/WS сервер, зеркалящий IPC handlers — ~300-500 LOC
5. Vite конфиг для web-сборки — ~30 LOC
6. Auth для веб-версии (JWT/session) — ~200 LOC

**Плюсы**:
- Минимальные изменения в существующем коде
- Renderer остаётся тем же React SPA
- Работает с текущим стеком (Vite + React + Zustand + Tailwind)
- Electron-версия продолжает работать как раньше
- Latency: JSON-RPC добавляет ~1-2ms vs нативный IPC

**Минусы**: нужно поддерживать серверную часть отдельно.

| Надёжность | Уверенность |
|------------|-------------|
| **8/10**   | **8/10**    |

---

## Сводная таблица

| Подход                   | Объём работы              | Надёжность | Риск                        |
|--------------------------|---------------------------|------------|-----------------------------|
| `electron-to-web`        | Минимальный (2 импорта)   | 3/10       | Пакет v0.2.0, 0 загрузок   |
| `electron-common-ipc`    | Средний                   | 5/10       | Нужна адаптация handlers    |
| Neutralino.js            | Огромный (переписать всё) | 7/10       | Другой фреймворк            |
| **DIY (Slack pattern)**  | **Средний (~3-4 дня)**    | **9/10**   | **Минимальный**             |
| **Vite web build + DIY** | **Средний (~3-4 дня)**    | **8/10**   | **Минимальный**             |

## Решение

**Вариант 4 + 5** — DIY абстракция транспорта (по паттерну Slack) + отдельная Vite web-сборка. Это единственный подход, который:

- Проверен в продакшне крупными компаниями
- Не зависит от сырых/нишевых пакетов
- Сохраняет обратную совместимость с Electron-версией
- Требует умеренного объёма работы (~3-4 дня)
- Даёт полный контроль над архитектурой
