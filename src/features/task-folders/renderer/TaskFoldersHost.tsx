import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useAppTranslation } from '@features/localization/renderer';
import { TaskFiltersPopover } from '@renderer/components/sidebar/TaskFiltersPopover';
import { TaskSortPopover } from '@renderer/components/sidebar/TaskSortPopover';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { FolderTree as FolderTreeIcon, Search, X } from 'lucide-react';

import { moveRequest } from './adapters/moveRequest';
import { useTaskFoldersHost } from './hooks/useTaskFoldersHost';
import { FolderDialogs } from './ui/FolderDialogs';
import { FolderTree } from './ui/FolderTree';
import { folderController, panelController } from './composition';

import type { FolderDialog } from './ui/FolderDialogs';
import type { TreeFocusRequest } from './ui/FolderTree';
import type { RefObject } from 'react';
export const TaskFoldersHost = ({
  contextId,
  sidebar,
  collapsed,
}: {
  contextId: string;
  sidebar: RefObject<HTMLDivElement | null>;
  collapsed: boolean;
}): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const model = useTaskFoldersHost(contextId, sidebar, collapsed, panelRef);
  const { closeViewControls, move } = model;
  const [action, setAction] = useState<FolderDialog | null>(null);
  const [focus, setFocus] = useState<TreeFocusRequest | null>(null);
  const dialog = (next: FolderDialog): void => {
    panelController.hold('dialog', true);
    setAction(next);
  };
  useEffect(() => {
    panelController.hold('dialog', !!action || !!move);
  }, [action, move]);
  useEffect(() => {
    if (collapsed) {
      // Collapsing the host cancels its owned overlay workflows.
      setAction(null);
      moveRequest.close();
      closeViewControls();
    }
  }, [collapsed, closeViewControls]);
  useEffect(() => {
    let lastPointer: { x: number; y: number } | undefined;
    let sessionPointer: { point: { x: number; y: number }; session: number } | undefined;
    const insidePanel = (point: { x: number; y: number } | undefined): boolean => {
      const r = panelRef.current?.getBoundingClientRect();
      return (
        !!r &&
        !!point &&
        point.x >= r.left &&
        point.x <= r.right &&
        point.y >= r.top &&
        point.y <= r.bottom
      );
    };
    const start = (): void => {
      // Dragover coordinates describe one native session and must never seed the next one.
      sessionPointer = undefined;
    };
    const over = (event: DragEvent): void => {
      if (!panelController.getSnapshot().dragSource) return;
      sessionPointer = {
        point: { x: event.clientX, y: event.clientY },
        session: panelController.getSnapshot().session,
      };
    };
    const move = (event: PointerEvent): void => {
      if (!event.isTrusted) return;
      const point = { x: event.clientX, y: event.clientY };
      lastPointer = point;
      sessionPointer = { point, session: panelController.getSnapshot().session };
      panelController.hold('pointer', insidePanel(point));
    };
    const end = (event: DragEvent): void => {
      const state = panelController.getSnapshot();
      if (!state.dragSource) return;
      const point =
        event.type === 'drop'
          ? { x: event.clientX, y: event.clientY }
          : sessionPointer?.session === state.session
            ? sessionPointer.point
            : lastPointer;
      if (event.type === 'drop' && point) sessionPointer = { point, session: state.session };
      panelController.hold('pointer', insidePanel(point));
      if (event.type === 'drop') panelController.endAfterDrop();
      else panelController.end();
    };
    const escape = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        target?.closest('input, [role="dialog"], [role="menu"]')
      )
        return;
      if (panelController.escape()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('keydown', escape, true);
    document.addEventListener('dragstart', start, true);
    document.addEventListener('dragover', over, true);
    document.addEventListener('pointermove', move, { capture: true, passive: true });
    document.addEventListener('drop', end, true);
    document.addEventListener('dragend', end, true);
    return () => {
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('dragstart', start, true);
      document.removeEventListener('dragover', over, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('drop', end, true);
      document.removeEventListener('dragend', end, true);
    };
  }, []);
  const content = (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <span className="flex-1 text-sm font-semibold">{t('taskFolders.title')}</span>
        <Button
          variant="ghost"
          size="sm"
          data-testid="task-folders-new-folder"
          disabled={model.state.status !== 'ready'}
          onClick={() => dialog({ kind: 'create', parent: null })}
        >
          {t('taskFolders.newFolder')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('actions.close')}
          onClick={() => panelController.close()}
        >
          <X className="size-3" />
        </Button>
        <label className="flex w-full items-center gap-2 text-xs">
          <Checkbox
            data-testid="task-folders-show-archived"
            checked={model.showArchived}
            onCheckedChange={(value) => model.setShowArchived(value === true)}
          />
          {t('taskFolders.showArchived')}
        </label>
        <div
          className="flex w-full flex-wrap items-center gap-1"
          data-testid="task-folders-task-controls"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1 rounded border border-border px-1.5">
            <Search className="size-3 shrink-0 text-text-muted" />
            <input
              type="search"
              value={model.view.searchQuery}
              aria-label={t('tasksPanel.searchPlaceholder')}
              placeholder={t('tasksPanel.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent py-1 text-xs outline-none"
              onChange={(event) => model.view.setSearchQuery(event.target.value)}
            />
          </div>
          <TaskSortPopover
            open={model.view.sortOpen}
            onOpenChange={model.view.setSortOpen}
            mode={model.view.sortMode}
            onModeChange={model.view.setSortMode}
            includeManual
            testId="tree-task-view-sort"
          />
          <TaskFiltersPopover
            open={model.view.filtersOpen}
            onOpenChange={model.view.setFiltersOpen}
            testId="tree-task-view-filters"
            teams={model.taskFilterTeams}
            projectOptions={model.projectFilterOptions}
            filters={model.view.filters}
            onFiltersChange={model.view.setFilters}
            onApply={() => undefined}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('taskFilters.clearAll')}
                className="size-6"
                onClick={model.view.reset}
              >
                <X className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('taskFilters.clearAll')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {model.state.status === 'loading' && (
        <p role="status" className="p-2 text-xs">
          {t('taskFolders.loading')}
        </p>
      )}
      {model.state.status !== 'ready' && model.state.status !== 'loading' && (
        <div role="alert" className="p-2 text-xs">
          <p>{t('taskFolders.readOnly')}</p>
          <Button variant="outline" size="sm" onClick={() => dialog({ kind: 'reset' })}>
            {t('taskFolders.reset')}
          </Button>
        </div>
      )}
      {model.state.error && (
        <div role="alert" className="p-2 text-xs">
          <p>{t('taskFolders.saveError')}</p>
          <Button
            size="sm"
            onClick={() => {
              void folderController.retry().catch(() => undefined);
            }}
          >
            {t('taskFolders.retry')}
          </Button>
        </div>
      )}
      <FolderTree model={model} dialog={dialog} focusRequest={focus} />
    </>
  );
  const visible = model.panel.open && !collapsed;
  const fallback = !!model.rect && model.rect.width < 240;
  const fallbackOpen = visible && fallback && model.panel.manual;
  useEffect(
    () => () => {
      panelController.hold('pointer', false);
    },
    [visible, fallback, fallbackOpen]
  );
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={model.panel.manual ? 'secondary' : 'ghost'}
            size="sm"
            data-testid="task-folders-toggle"
            aria-label={t('taskFolders.title')}
            aria-expanded={fallback ? fallbackOpen : visible}
            aria-pressed={model.panel.manual}
            onClick={() => panelController.toggle()}
          >
            <FolderTreeIcon className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('taskFolders.title')}</TooltipContent>
      </Tooltip>
      {visible &&
        model.rect &&
        !fallback &&
        createPortal(
          <div
            ref={model.registerPanel}
            data-testid="task-folders-panel"
            role="region"
            aria-label={t('taskFolders.title')}
            className="fixed z-40 flex flex-col overflow-hidden rounded-l-md border border-border shadow-xl"
            style={{ ...model.rect, backgroundColor: 'var(--color-surface-sidebar)' }}
            onPointerEnter={() => panelController.hold('pointer', true)}
            onPointerLeave={() => panelController.hold('pointer', false)}
            onFocusCapture={() => panelController.hold('focus', true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                panelController.hold('focus', false);
            }}
          >
            {content}
          </div>,
          document.body
        )}
      <Dialog
        open={fallbackOpen}
        onOpenChange={(open) => {
          if (!open) panelController.close();
        }}
      >
        <DialogContent
          aria-modal="true"
          onInteractOutside={(event) => {
            // Sticky mode ends only via the toggle, the close button, or an unhandled
            // Escape; a backdrop click must not dismiss the modal companion.
            event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            // Dialog-scoped keys skip the host handler, so the modal Escape must still reach
            // the controller or the drag-cancel absorb window never applies here.
            if (event.defaultPrevented) return;
            if (panelController.escape()) event.preventDefault();
          }}
          style={{ backgroundColor: 'var(--color-surface-sidebar)' }}
        >
          <DialogTitle>{t('taskFolders.title')}</DialogTitle>
          <div
            ref={model.registerPanel}
            data-testid="task-folders-panel"
            className="flex h-[60vh] min-w-0 flex-col"
            style={{ backgroundColor: 'var(--color-surface-sidebar)' }}
            onPointerEnter={() => panelController.hold('pointer', true)}
            onPointerLeave={() => panelController.hold('pointer', false)}
            onFocusCapture={() => panelController.hold('focus', true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                panelController.hold('focus', false);
            }}
          >
            {fallbackOpen ? content : null}
          </div>
        </DialogContent>
      </Dialog>
      <FolderDialogs
        action={action}
        close={() => setAction(null)}
        projection={model.projection}
        move={model.move}
        renameTask={model.local.renameTask}
        created={(id, parent) => setFocus({ id, parent })}
      />
    </>
  );
};
