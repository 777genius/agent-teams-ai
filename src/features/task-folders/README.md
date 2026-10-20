# Task folders

Public renderer integration is exported from `renderer/index.ts`.

The Tasks header button enables or disables folder mode for the current app session.
Enabled mode keeps the companion panel open and shows task drag handles in the main
sidebar. Drag completion, pointer/focus changes, and closing row menus do not hide it.
The toggle, companion close button, or an unhandled Escape disables mode; Escape
first finishes an active drag or closes the current editor/menu/dialog.

Disabled mode hides the companion and sidebar task handles. Incidental holds and
drag events cannot reopen it. Explicit move choosers remain available independently.
Sidebar collapse/unmount clears transient drag state while retaining the session mode.
Folder structure and task-view preferences persist separately; mode starts OFF after
a full app restart. `useTaskFolderMode()` exposes the current mode to renderer consumers.

`renderer/view-models/taskUnreadCounts.ts` computes unread-task counts from the canonical
projection, including available archived and filter-hidden tasks once per ancestor.
