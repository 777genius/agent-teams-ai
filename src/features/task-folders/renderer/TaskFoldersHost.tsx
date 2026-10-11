import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { FolderTree as FolderTreeIcon, X } from 'lucide-react';

import { moveRequest } from './adapters/moveRequest';
import { useTaskFoldersHost } from './hooks/useTaskFoldersHost';
import { FolderDialogs } from './ui/FolderDialogs';
import { FolderTree } from './ui/FolderTree';
import { folderController, panelController } from './composition';

import type { FolderDialog } from './ui/FolderDialogs';
import type { TreeFocusRequest } from './ui/FolderTree';
import type { RefObject } from 'react';
export const TaskFoldersHost = ({
  sidebar,
  collapsed,
}: {
  sidebar: RefObject<HTMLDivElement | null>;
  collapsed: boolean;
}): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const model = useTaskFoldersHost(sidebar, collapsed);
  const [action, setAction] = useState<FolderDialog | null>(null);
  const [focus, setFocus] = useState<TreeFocusRequest | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dialog = (next: FolderDialog): void => {
    panelController.hold('dialog', true);
    setAction(next);
  };
  useEffect(() => {
    panelController.hold('dialog', !!action || !!model.move);
  }, [action, model.move]);
  useEffect(() => {
    if (collapsed) {
      // Collapsing the host cancels its owned overlay workflows.
      setAction(null);
      moveRequest.close();
    }
  }, [collapsed]);
  useEffect(() => {
    let pointer: { x: number; y: number } | undefined;
    const over = (event: DragEvent): void => {
      pointer = { x: event.clientX, y: event.clientY };
    };
    const end = (event: DragEvent): void => {
      if (!panelController.getSnapshot().dragSource) return;
      const r = panelRef.current?.getBoundingClientRect();
      const point = event.type === 'drop' ? { x: event.clientX, y: event.clientY } : pointer;
      panelController.hold(
        'pointer',
        !!r &&
          !!point &&
          point.x >= r.left &&
          point.x <= r.right &&
          point.y >= r.top &&
          point.y <= r.bottom
      );
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
    document.addEventListener('dragover', over, true);
    document.addEventListener('drop', end, true);
    document.addEventListener('dragend', end, true);
    return () => {
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('dragover', over, true);
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
      panelController.hold('focus', false);
    },
    [visible, fallback, fallbackOpen]
  );
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            data-testid="task-folders-toggle"
            aria-label={t('taskFolders.title')}
            aria-expanded={fallback ? fallbackOpen : visible}
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
            ref={panelRef}
            data-testid="task-folders-panel"
            role="region"
            aria-label={t('taskFolders.title')}
            className="fixed z-40 flex flex-col overflow-hidden rounded-l-md border border-border bg-surface shadow-xl"
            style={model.rect}
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
        <DialogContent>
          <DialogTitle>{t('taskFolders.title')}</DialogTitle>
          <div
            ref={panelRef}
            data-testid="task-folders-panel"
            className="flex h-[60vh] flex-col"
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
