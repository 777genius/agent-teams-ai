# Wireframes (черновик, пересмотреть позже)

> Статус: DRAFT — требует пересмотра и финализации перед реализацией.

## 1. Main state (файл открыт)
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [←] Open in Editor — /Users/belief/project               [?] [×]          │
├──────────────────────┬──────────────────────────────────────────────────────┤
│ 🔍 Filter files...   │ [● index.ts] [  App.tsx ] [  utils.ts]   [×]       │
│                      │ ─────────────────────────────────────────────────── │
│  ▼ src/              │ src / renderer / components / App.tsx                │
│    ▼ renderer/       │ ─────────────────────────────────────────────────── │
│      ▼ components/   │   1 │ import React from 'react';                    │
│        ▸ chat/       │   2 │ import { useStore } from '../store';          │
│        ▸ common/     │   3 │                                               │
│      ● App.tsx       │   4 │ export const App = () => {                    │
│        index.ts      │   5 │   const theme = useStore(s => s.theme);       │
│      ▸ hooks/        │   6 │   return (                                    │
│      ▸ store/        │   7 │     <div className={theme}>                   │
│      ▸ utils/        │   8 │       <Router />                              │
│    ▸ main/           │   9 │     </div>                                    │
│    ▸ shared/         │  10 │   );                                          │
│  ▸ test/             │  11 │ };                                            │
│  ▸ docs/             │  12 │                                               │
│    package.json      │                                                     │
│    tsconfig.json     │                                                     │
│                      ├──────────────────────────────────────────────────────│
│                      │ Ln 5, Col 12 │ TypeScript │ UTF-8 │ Spaces: 2 │ LF │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

## 2. Empty state (нет открытых файлов)
```
┌──────────────────────┬──────────────────────────────────────────────────────┐
│ 🔍 Filter files...   │                                                     │
│                      │                                                     │
│  ▼ src/              │           No file is open                           │
│    ▸ main/           │                                                     │
│    ▸ renderer/       │           Keyboard Shortcuts                        │
│    ▸ shared/         │           ─────────────────                         │
│  ▸ test/             │           ⌘P     Quick Open                        │
│    package.json      │           ⌘S     Save File                         │
│                      │           ⌘⇧F    Search in Files                   │
│                      │           ⌘W     Close Tab                         │
│                      │           ⌘B     Toggle Sidebar                    │
│                      │           ⌘G     Go to Line                        │
│                      │           Esc    Close Editor                      │
│                      │                                                     │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

## 3. Unsaved changes confirm dialog
```
┌──────────────────────────────────────────────────┐
│                                                  │
│  ⚠  You have unsaved changes in 3 files:         │
│                                                  │
│     • index.ts                                   │
│     • App.tsx                                    │
│     • utils.ts                                   │
│                                                  │
│  ┌──────────────┐ ┌──────────────┐ ┌────────┐   │
│  │ Save All &   │ │ Discard &    │ │ Cancel │   │
│  │ Close        │ │ Close        │ │        │   │
│  └──────────────┘ └──────────────┘ └────────┘   │
│                                                  │
└──────────────────────────────────────────────────┘
```

## 4. Context menu на директории
```
│    ▼ components/     │
│      ▸ chat/         │
│      ▸ common/  ─────┤
│        App.tsx  │ New File...        │
│        index.ts │ New Folder...      │
│      ▸ hooks/   │────────────────────│
│                 │ Delete             │
│                 │ Copy Path          │
│                 │ Reveal in Finder   │
│                 └────────────────────┘
```

## 5. Quick Open (Cmd+P)
```
┌──────────────────────────────────────────────────┐
│ 🔍  app.tsx                                       │
├──────────────────────────────────────────────────┤
│  ● App.tsx            src/renderer/components    │
│    AppShell.tsx       src/renderer/components     │
│    api.ts             src/shared/types            │
│    atomicWrite.ts     src/main/utils              │
│                                                  │
│  4 results                                       │
└──────────────────────────────────────────────────┘
```

## 6. Search in Files (Cmd+Shift+F)
```
┌──────────────────────┬──────────────────────────────────────────────────────┐
│ SEARCH IN FILES      │ [  index.ts ] [● App.tsx ]                          │
│ 🔍 useStore  [Aa]    │ ─────────────────────────────────────────────────── │
│ ──────────────────── │   1 │ import React from 'react';                    │
│ 12 results in 8 files│   5 │   const theme = useStore(s => s.theme);  ◄── │
│                      │                                                     │
│ ▼ src/renderer/      │                                                     │
│   App.tsx:5          │                                                     │
│     const theme =    │                                                     │
│     useStore(s =>    │                                                     │
│   store/index.ts:12  │                                                     │
│     export const     │                                                     │
│     useStore = ...   │                                                     │
│ ▼ src/main/          │                                                     │
│   ...                │                                                     │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

## 7. Binary / Error / Large file states
```
Binary file:
┌──────────────────────────────────────────────────┐
│                                                  │
│              📄  logo.png                         │
│              PNG Image • 245 KB                  │
│                                                  │
│     [Open in System Viewer]  [Close Tab]         │
│                                                  │
└──────────────────────────────────────────────────┘

Error state:
┌──────────────────────────────────────────────────┐
│                                                  │
│              ⚠  Cannot read file                  │
│              Permission denied (EACCES)           │
│                                                  │
│              [Retry]  [Close Tab]                 │
│                                                  │
└──────────────────────────────────────────────────┘

Large file (2-5MB):
┌──────────────────────────────────────────────────┐
│ ⚠ File too large for editing (3.2 MB)            │
│ Showing first 100 lines (read-only preview)      │
│──────────────────────────────────────────────────│
│   1 │ // This is a large generated file...       │
│   2 │ ...                                        │
│ 100 │ ...                                        │
│──────────────────────────────────────────────────│
│ [Open in External Editor]                        │
└──────────────────────────────────────────────────┘
```

## 8. Git status badges + conflict banner
```
File tree with git status:
│  ▼ src/              │
│    ▼ renderer/       │
│      M App.tsx       │   ← M = modified (amber)
│      U newFile.ts    │   ← U = untracked (green)
│      A staged.ts     │   ← A = staged (blue)
│        index.ts      │

Conflict banner (file changed on disk while open):
┌──────────────────────────────────────────────────────────────┐
│ ⚠ File changed on disk    [Reload] [Keep Mine] [Show Diff]  │
├──────────────────────────────────────────────────────────────┤
│   1 │ import React from 'react';                             │
│   2 │ ...                                                    │
└──────────────────────────────────────────────────────────────┘
```
