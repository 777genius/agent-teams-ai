# Split Screen Multi-View Research

> Исследование: поддержка одновременного просмотра нескольких сессий/команд в split pane.
> Дата: 2026-03-10

## Текущее состояние архитектуры

### Split Pane System (уже реализовано)
- До **4 панелей** одновременно (`MAX_PANES = 4` в `src/renderer/types/panes.ts`)
- Drag-and-drop между панелями (dnd-kit, `TabbedLayout.tsx`)
- Resize handles между панелями (`PaneResizeHandle.tsx`)
- CSS `display: none` toggle — все вкладки mounted, только active видна (`PaneContent.tsx`)
- `TabUIContext` предоставляет `tabId` потомкам

### Pane Layout Structure
```typescript
// src/renderer/types/panes.ts
interface Pane {
  id: string;
  tabs: Tab[];
  activeTabId: string;
  selectedTabIds: string[];
  widthFraction: number; // 0-1, сумма всех = 1.0
}

interface PaneLayout {
  panes: Pane[];
  focusedPaneId: string; // какая панель в фокусе
}
```

### Backward Compatibility Facade
Root-level `openTabs`, `activeTabId`, `selectedTabIds` синхронизируются из **focused pane only** через `syncFromLayout()` в `tabSlice.ts`.

---

## Изоляция состояния: что per-tab vs глобальное

### ✅ Per-Tab (уже изолировано)

| Состояние | Хранение | Слайс |
|-----------|----------|-------|
| UI expansion state | `tabUIStates[tabId]` | `tabUISlice` |
| Scroll position | `tabUIStates[tabId].savedScrollTop` | `tabUISlice` |
| Context panel visibility | `tabUIStates[tabId].showContextPanel` | `tabUISlice` |
| Context phase selection | `tabUIStates[tabId].selectedContextPhase` | `tabUISlice` |
| Session data cache | `tabSessionData[tabId]` | `sessionDetailSlice` |
| Conversation cache | `tabSessionData[tabId].conversation` | `sessionDetailSlice` |

**Паттерн чтения:**
```typescript
const stats = useStore((s) => {
  const td = tabId ? s.tabSessionData[tabId] : null;
  return td?.sessionClaudeMdStats ?? s.sessionClaudeMdStats;
});
```

### ❌ Глобальное (проблемы для multi-view)

| Состояние | Слайс | Проблема |
|-----------|-------|----------|
| `selectedTeamName` | `teamSlice` | Одна команда на всё приложение |
| `selectedTeamData` | `teamSlice` | Полные данные только одной команды |
| `searchQuery` | `conversationSlice` | Поиск общий для всех вкладок |
| `searchVisible` | `conversationSlice` | Показ поиска общий |
| `searchMatches` | `conversationSlice` | Результаты поиска общие |
| `currentSearchIndex` | `conversationSlice` | Навигация по результатам общая |
| `expandedAIGroupIds` | `conversationSlice` | Legacy дубль `tabUISlice` |
| `expandedDisplayItemIds` | `conversationSlice` | Legacy дубль `tabUISlice` |
| `expandedStepIds` | `conversationSlice` | Глобальное, логично per-tab |
| `activeDetailItem` | `conversationSlice` | Глобальное, логично per-tab |

### ⚠️ Синхронизируемое (работает через swap)

| Состояние | Механизм |
|-----------|----------|
| `selectedProjectId` | Swap при фокусе pane |
| `selectedSessionId` | Swap при фокусе pane |
| `sessionDetail` (global) | Swap из `tabSessionData[tabId]` |
| `conversation` (global) | Swap из `tabSessionData[tabId]` |

---

## Варианты реализации

### Вариант A: Полная поддержка split-screen для сессий
**Надёжность: 8/10 | Уверенность: 9/10**

Основа уже заложена через `tabSessionData`. Нужно:

1. **Search isolation** (~5 файлов):
   - Перенести `searchQuery`, `searchVisible`, `searchMatches`, `currentSearchIndex` в `tabUISlice`
   - Обновить `SearchBar`, `useSearchContextNavigation`, `searchHighlightUtils`
   - Компоненты читают search state через `tabUIStates[tabId]`

2. **Legacy cleanup** (~3 файла):
   - Удалить `expandedAIGroupIds` и `expandedDisplayItemIds` из `conversationSlice`
   - Убедиться все компоненты используют `tabUISlice` версии
   - Удалить `expandedStepIds` из global scope

3. **Верификация** (~3 файла):
   - Проверить все компоненты в chat/ читают через `tabSessionData[tabId]` паттерн
   - Проверить что `activeDetailItem` изолирован

**Объём: ~8-12 файлов, средняя сложность.**

### Вариант B: Полная поддержка split-screen для команд
**Надёжность: 7/10 | Уверенность: 7/10**

Нужна новая инфраструктура:

1. **Per-tab team data cache** (~5 файлов):
   ```typescript
   // В teamSlice или sessionDetailSlice
   tabTeamData: Record<string, {
     teamName: string;
     teamData: TeamData | null;
     loading: boolean;
     error: string | null;
   }>
   ```

2. **selectTeam() с tabId** (~3 файла):
   - `selectTeam(teamName, tabId?)` — кэширует в `tabTeamData[tabId]`
   - При переключении tab: swap из кэша или fetch
   - При закрытии tab: cleanup кэша

3. **Team компоненты** (~8 файлов):
   - `TeamDetailView`, `TeamChatView`, `TeamKanbanView` и др.
   - Читать через `tabTeamData[tabId]` паттерн
   - File watcher: обновлять нужные tab кэши

4. **Sidebar sync** (~2 файла):
   - При фокусе pane с team tab: sync sidebar к этой команде

**Объём: ~15-20 файлов, высокая сложность.**

### Вариант C: A + B (полный split-screen)
**Надёжность: 6/10 | Уверенность: 7/10**

**Объём: ~20-25 файлов.**

---

## Риски

### Высокие
1. **Race conditions при file watcher events** — обновление прилетает, нужно обновить правильный tab cache. Для сессий решено через `tabFetchGeneration` Map, для команд нужен аналог.
2. **Search isolation** — search завязан на глобальные `searchMatches` и навигацию по ним, самый трудоёмкий рефактор.

### Средние
3. **Memory pressure** — каждый tab хранит полный кэш. Для сессий работает (cleanup при закрытии). Для команд нужен аналог.
4. **Sidebar sync** — сайдбар показывает контекст focused pane. При переключении нужен корректный swap project/worktree/team.
5. **Stale data** — два tab с одной сессией/командой: file watcher обновляет оба или только active?

### Низкие
6. **DnD between panes** — перетаскивание team tab между panes должно триггерить cache transfer.
7. **Tab duplication** — `openTab()` проверяет дупликаты across ALL panes. Нужно ли разрешить одну и ту же команду в двух panes?

---

## Ключевые файлы

### Store Slices
| Файл | Роль |
|------|------|
| `src/renderer/store/slices/tabSlice.ts` | Tab lifecycle, session switching, backward compat |
| `src/renderer/store/slices/paneSlice.ts` | Multi-pane split/resize/focus |
| `src/renderer/store/slices/tabUISlice.ts` | Per-tab UI state (expansion, scroll) |
| `src/renderer/store/slices/sessionDetailSlice.ts` | Session data + per-tab caching |
| `src/renderer/store/slices/conversationSlice.ts` | Search, legacy expansion (нужен рефактор) |
| `src/renderer/store/slices/teamSlice.ts` | Team selection (глобальное, нужен рефактор) |

### Layout Components
| Файл | Роль |
|------|------|
| `src/renderer/components/layout/TabbedLayout.tsx` | Main layout + DnD context |
| `src/renderer/components/layout/TabBarRow.tsx` | Full-width tab bar (pane-proportional) |
| `src/renderer/components/layout/TabBar.tsx` | Single pane tab bar |
| `src/renderer/components/layout/PaneContainer.tsx` | Split layout renderer |
| `src/renderer/components/layout/PaneView.tsx` | Single pane wrapper |
| `src/renderer/components/layout/PaneContent.tsx` | Tab content renderer (display-toggle) |
| `src/renderer/components/layout/SessionTabContent.tsx` | Session tab content |

### Contexts
| Файл | Роль |
|------|------|
| `src/renderer/contexts/TabUIContext.tsx` | Per-tab ID provider |
| `src/renderer/contexts/useTabUIContext.ts` | Context hook |

---

## Рекомендация

**Начать с Варианта A** (сессии в split-screen):
- 80% инфраструктуры уже есть
- Нужно дочистить search isolation и legacy duplicates
- Низкий риск регрессий

**Затем Вариант B** (команды):
- Когда паттерн per-tab caching отработан на сессиях
- Применить тот же подход к team data

---

## Обнаруженные баги (побочный результат ресёрча)

1. **Search state не изолирован** — поиск в одной вкладке влияет на другие
2. **Legacy дублирование** — `expandedAIGroupIds` существует и в `conversationSlice` и в `tabUISlice`
3. **Team tabs в split pane** — обе панели показывают одну команду (последнюю выбранную)
