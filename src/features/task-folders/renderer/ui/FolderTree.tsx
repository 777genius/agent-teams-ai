import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  dragAndDropFeature,
  hotkeysCoreFeature,
  selectionFeature,
  syncDataLoaderFeature,
} from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import { SidebarTaskItem } from '@renderer/components/sidebar/SidebarTaskItem';
import { buildTaskCardActions } from '@renderer/components/sidebar/taskCardActions';
import { Button } from '@renderer/components/ui/button';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { Input } from '@renderer/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { isImeComposing } from '@renderer/utils/imeComposition';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Folder,
  GripVertical,
  MoreHorizontal,
  Plus,
} from 'lucide-react';

import { childKey, parentOf, validateName } from '../../core/domain/folders';
import { createEdgeScroll, observeEdgeDrag } from '../adapters/edgeScroll';
import { taskFolderMoveRequest } from '../adapters/taskFolderEditing';
import { cancelHoverExpansion, clearTreeDrag } from '../adapters/treeDragLifecycle';
import { TreeDropAdapter } from '../adapters/treeDropAdapter';
import { folderController, panelController } from '../composition';
import { ROOT, UNFILED } from '../view-models/projection';

import { RowMenuOwner } from './TreeRowMenu';

import type { TaskFoldersHostModel } from '../hooks/useTaskFoldersHost';
import type { Node } from '../view-models/projection';
import type { FolderDialog } from './FolderDialogs';
import type { ItemInstance } from '@headless-tree/core';
import type { Virtualizer } from '@tanstack/react-virtual';

type RenameError = 'invalid-name' | 'read-only' | 'save-error';
const stopRowMenuEvent = (event: React.SyntheticEvent): void => {
  event.stopPropagation();
};
export interface TreeFocusRequest {
  id: string;
  parent: string | null;
}
export const FolderTree = ({
  model,
  dialog,
  focusRequest,
}: {
  model: TaskFoldersHostModel;
  dialog(action: FolderDialog): void;
  focusRequest: TreeFocusRequest | null;
}): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const scroll = useRef<HTMLDivElement>(null);
  const virtualRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const editHold = `edit:${useId()}` as const;
  const editSession = useRef<string | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<RenameError | null>(null);
  const [saving, setSaving] = useState(false);
  const projectionRef = useRef(model.projection);
  projectionRef.current = model.projection;
  const adapter = useMemo(
    () => new TreeDropAdapter(() => projectionRef.current, folderController, panelController),
    []
  );
  const tree = useTree<Node>({
    rootItemId: ROOT,
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature, dragAndDropFeature],
    initialState: { expandedItems: [UNFILED], selectedItems: [] },
    dataLoader: {
      getItem: (id) => model.projection.nodes.get(id)!,
      getChildren: (id) => model.projection.nodes.get(id)?.children ?? [],
    },
    getItemName: (item) =>
      item.getId() === UNFILED ? t('taskFolders.unfiled') : (item.getItemData()?.name ?? ''),
    isItemFolder: (item) => item.getItemData()?.kind !== 'task',
    onPrimaryAction: (item) => {
      const n = item.getItemData();
      if (n.identity) model.openTask(n.identity.teamName, n.identity.taskId);
    },
    scrollToItem: (item) => {
      const index = tree.getItems().findIndex((row) => row.getId() === item.getId());
      if (index >= 0) virtualRef.current?.scrollToIndex(index);
    },
    canDrag: (items) =>
      model.state.status === 'ready' &&
      !saving &&
      !rename &&
      items.length === 1 &&
      ['folder', 'task'].includes(items[0].getItemData().kind),
    canDrop: (items, target) =>
      adapter.canInternal(
        items.map((item) => item.getItemData()),
        target
      ),
    onDrop: (items, target) =>
      adapter
        .dropInternal(
          items.map((item) => item.getItemData()),
          target
        )
        .catch(() => undefined),
    canDragForeignDragObjectOver: (transfer, target) => adapter.canForeign(transfer, target, false),
    canDropForeignDragObject: (transfer, target) => adapter.canForeign(transfer, target, true),
    onDropForeignDragObject: (transfer, target) =>
      adapter.dropForeign(transfer, target).catch(() => undefined),
    canReorder: true,
    seperateDragHandle: true,
    openOnDropDelay: 600,
    indent: 16,
  });
  const consumedFocus = useRef<TreeFocusRequest | null>(null);
  const previous = useRef(model.projection);
  const repairedProjection = useRef(model.projection);
  if (previous.current !== model.projection) {
    tree.scheduleRebuildTree();
    previous.current = model.projection;
  }
  const items = tree.getItems();
  const source = model.panel.dragSource;
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroll.current,
    estimateSize: (index) => {
      const kind = items[index]?.getItemData().kind;
      return kind === 'task' ? 78 : kind === 'unfiled' ? 36 : 32;
    },
    overscan: 6,
    getItemKey: (index) => items[index].getId(),
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      const sourceIndex = items.findIndex((item) => item.getId() === source);
      return sourceIndex < 0 || indexes.includes(sourceIndex)
        ? indexes
        : [...indexes, sourceIndex].sort((a, b) => a - b);
    },
  });
  virtualRef.current = virtual;
  useEffect(() => {
    if (!focusRequest || consumedFocus.current === focusRequest) return;
    if (focusRequest.parent) tree.getItemInstance(`folder:${focusRequest.parent}`).expand();
    const id = `folder:${focusRequest.id}`;
    if (projectionRef.current.nodes.has(id)) {
      consumedFocus.current = focusRequest;
      const item = tree.getItemInstance(id);
      item.setFocused();
      let active = true;
      const frame = requestAnimationFrame(() => {
        if (!active) return;
        void item.scrollTo().then(() => {
          if (active) tree.updateDomFocus();
        });
      });
      return () => {
        active = false;
        cancelAnimationFrame(frame);
      };
    }
  }, [focusRequest, model.projection, tree]);
  useEffect(() => {
    const oldProjection = repairedProjection.current;
    repairedProjection.current = model.projection;
    let frame: number | undefined;
    let active = true;
    const focused = tree.getState().focusedItem;
    if (focused && !tree.getItems().some((item) => item.getId() === focused)) {
      let old: string | undefined;
      const oldNode = oldProjection.nodes.get(focused);
      if (oldNode?.kind === 'task') {
        const container = oldProjection.snapshot.folders.find((f) =>
          f.children.some((c) => c.kind === 'task' && childKey(c) === focused)
        )?.id;
        old = container ? `folder:${container}` : UNFILED;
      } else if (oldNode?.folderId) {
        const parent = parentOf(oldProjection.snapshot, oldNode.folderId);
        if (parent) old = `folder:${parent}`;
        else {
          const roots = oldProjection.snapshot.rootFolderIds;
          const index = roots.indexOf(oldNode.folderId);
          const live = (id: string): boolean => model.projection.nodes.has(`folder:${id}`);
          const sibling =
            roots.slice(index + 1).find(live) ??
            roots.slice(0, Math.max(index, 0)).reverse().find(live);
          old = sibling ? `folder:${sibling}` : UNFILED;
        }
      }
      const target =
        old && model.projection.nodes.has(old) && old !== ROOT ? old : tree.getItems()[0]?.getId();
      if (target) {
        const item = tree.getItemInstance(target);
        item.setFocused();
        frame = requestAnimationFrame(() => {
          if (!active) return;
          void item.scrollTo().then(() => {
            if (active) tree.updateDomFocus();
          });
        });
      }
    }
    const visible = new Set(tree.getItems().map((item) => item.getId()));
    const state = tree.getState();
    const expanded = state.expandedItems.filter((id) => model.projection.nodes.has(id));
    const selected = state.selectedItems.filter((id) => visible.has(id));
    if (selected.length !== state.selectedItems.length) {
      const focused = tree.getState().focusedItem;
      tree.setSelectedItems(focused && visible.has(focused) ? [focused] : []);
    }
    if (expanded.length !== state.expandedItems.length)
      tree.applySubStateUpdate('expandedItems', expanded);
    if ((!source && tree.getState().dnd) || (source && !model.projection.nodes.has(source))) {
      panelController.end();
      clearTreeDrag(tree);
    }
    return () => {
      active = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [model.projection, source, tree]);
  useEffect(() => {
    const container = scroll.current;
    if (!container) return;
    const edge = createEdgeScroll(container);
    const release = panelController.subscribe(() => {
      if (!panelController.getSnapshot().dragSource) {
        edge.stop();
        clearTreeDrag(tree);
      }
    });
    const stopObserving = observeEdgeDrag(
      container,
      edge,
      () => !!panelController.getSnapshot().dragSource
    );
    const leave = (event: DragEvent): void => {
      if (!container.contains(event.relatedTarget as globalThis.Node | null)) {
        edge.stop();
        cancelHoverExpansion(tree);
      }
    };
    container.addEventListener('dragleave', leave);
    document.addEventListener('drop', edge.stop, true);
    document.addEventListener('dragend', edge.stop, true);
    window.addEventListener('blur', edge.stop);
    return () => {
      stopObserving();
      edge.stop();
      release();
      cancelHoverExpansion(tree);
      container.removeEventListener('dragleave', leave);
      document.removeEventListener('drop', edge.stop, true);
      document.removeEventListener('dragend', edge.stop, true);
      window.removeEventListener('blur', edge.stop);
    };
  }, [tree]);
  const startRename = (n: Node): void => {
    if (model.state.status !== 'ready') return;
    setRename(n.folderId!);
    setValue(n.name);
    setError(null);
    setSaving(false);
    editSession.current = crypto.randomUUID();
    panelController.hold(editHold, true);
  };
  const cancelRename = useCallback((): void => {
    editSession.current = null;
    setRename(null);
    setError(null);
    setSaving(false);
    panelController.hold(editHold, false);
  }, [editHold]);
  useEffect(
    () => () => {
      editSession.current = null;
      panelController.hold(editHold, false);
    },
    [editHold]
  );
  useEffect(() => {
    if (rename && !items.some((item) => item.getId() === `folder:${rename}`)) cancelRename();
  }, [rename, items, cancelRename]);
  useEffect(() => {
    if (rename && model.state.status !== 'ready') cancelRename();
  }, [cancelRename, model.state.status, rename]);
  const saveRename = async (): Promise<void> => {
    if (!rename || saving) return;
    try {
      validateName(value);
    } catch {
      setError('invalid-name');
      return;
    }
    const session = editSession.current;
    setSaving(true);
    try {
      await folderController.execute(
        { type: 'rename', id: rename, name: value },
        editSession.current ?? undefined
      );
      if (editSession.current === session) cancelRename();
    } catch (caught) {
      if (editSession.current === session)
        setError(
          caught instanceof Error && caught.message === 'read-only' ? 'read-only' : 'save-error'
        );
    } finally {
      if (editSession.current === session) setSaving(false);
    }
  };
  const actions = (
    n: Node
  ): { label: string; run(): void; restoreFocus: boolean; disabled?: boolean }[] =>
    n.kind === 'folder'
      ? [
          {
            label: t('taskFolders.newSubfolder'),
            run: () => dialog({ kind: 'create', parent: n.folderId! }),
            restoreFocus: false,
          },
          {
            label: t('taskFolders.renameFolder'),
            run: () => startRename(n),
            restoreFocus: false,
          },
          {
            label: t('taskFolders.move'),
            run: () => dialog({ kind: 'moveFolder', id: n.folderId! }),
            restoreFocus: false,
          },
          {
            label: t('taskFolders.deleteFolder'),
            run: () => dialog({ kind: 'delete', id: n.folderId! }),
            restoreFocus: false,
          },
        ]
      : n.identity && n.task
        ? buildTaskCardActions({
            isPinned: model.local.isPinned(n.identity.teamName, n.identity.taskId) ?? false,
            isArchived: n.archived ?? false,
            editingReady: model.state.status === 'ready',
            includeDelete: false,
            handlers: {
              onTogglePin: () => model.local.togglePin(n.identity!.teamName, n.identity!.taskId),
              onMove: () => taskFolderMoveRequest.open(n.identity!),
              onRename: () => dialog({ kind: 'renameTask', identity: n.identity!, name: n.name }),
              onMarkUnread: () => model.markUnread(n.identity!.teamName, n.identity!.taskId),
              onToggleArchive: () =>
                model.local.toggleArchive(n.identity!.teamName, n.identity!.taskId),
            },
          }).map((action) => ({
            label: t(action.labelKey),
            run: action.run,
            restoreFocus: action.restoreFocus,
            disabled: action.disabled,
          }))
        : [];
  const row = (item: ItemInstance<Node>): React.JSX.Element => {
    const n = item.getItemData();
    const menu = actions(n);
    const props = item.getProps();
    const drag = item.getDragHandleProps();
    const level = item.getItemMeta().level;
    const unreadCount = model.unreadTaskCounts?.get(n.id) ?? 0;
    const indentation = `min(${level * 16}px, 24%)`;
    const editing = n.kind === 'folder' && rename === n.folderId;
    const task = n.task;
    const identity = n.identity;
    if (n.kind === 'task' && task && identity) {
      return (
        <RowMenuOwner id={n.id}>
          {({ deferAction, onCloseAutoFocus, onMenuOpenChange }) => (
            <>
              <ContextMenuTrigger asChild>
                <SidebarTaskItem
                  task={task}
                  contextId={model.contextId}
                  cardScope="tree"
                  displaySubjectOverride={n.name}
                  isArchived={n.archived}
                  teamOffline={model.isTeamOffline(task.teamName)}
                  ownerColorName={model.getOwnerColorName(task)}
                  showTeamName
                  containerProps={{
                    ...props,
                    role: 'treeitem',
                    tabIndex: props.tabIndex ?? -1,
                    'aria-selected': item.isSelected(),
                    'aria-label': n.archived
                      ? `${n.name} (${t('taskFolders.archived')})`
                      : props['aria-label'],
                    className: `min-h-8 outline-none focus:ring-1 focus:ring-blue-400 ${
                      item.isDragTarget() ? 'bg-blue-500/20' : ''
                    }`,
                    style: { paddingLeft: indentation },
                    onKeyDown: (event) => {
                      if (event.target !== event.currentTarget || isImeComposing(event)) return;
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        item.primaryAction();
                      } else props.onKeyDown?.(event);
                    },
                  }}
                  onOpenDetail={(teamName, taskId) => model.openTask(teamName, taskId)}
                  renderDragHandle={() => (
                    <Button
                      {...drag}
                      type="button"
                      variant="ghost"
                      size="icon"
                      tabIndex={-1}
                      disabled={model.state.status !== 'ready'}
                      aria-disabled={model.state.status !== 'ready'}
                      aria-label={t('taskFolders.dragTask')}
                      data-testid="sidebar-task-drag-handle"
                      draggable={model.state.status === 'ready'}
                      onDragStart={(event) => {
                        if (model.state.status !== 'ready') {
                          event.preventDefault();
                          return;
                        }
                        drag.onDragStart?.(event);
                        if (!event.defaultPrevented) panelController.begin(n.id);
                      }}
                      onDragEnd={(event) => {
                        drag.onDragEnd?.(event);
                        panelController.end();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (model.state.status === 'ready') taskFolderMoveRequest.open(n.identity!);
                      }}
                      className="col-start-1 row-start-1 mt-0.5 size-5 shrink-0 p-0"
                    >
                      <GripVertical className="size-3" />
                    </Button>
                  )}
                  menuSlot={
                    <DropdownMenu
                      onOpenChange={(open) => {
                        onMenuOpenChange(open);
                        panelController.hold(`menu:dropdown:${n.id}`, open);
                      }}
                    >
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t('taskFolders.actions')}
                          data-testid="tree-task-actions"
                          onClick={(event) => event.stopPropagation()}
                          className="col-start-3 row-start-1 size-5 shrink-0 p-0"
                        >
                          <MoreHorizontal className="size-3" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        onCloseAutoFocus={onCloseAutoFocus}
                        onClick={stopRowMenuEvent}
                        onKeyDown={stopRowMenuEvent}
                      >
                        {menu.map((action) => (
                          <DropdownMenuItem
                            key={action.label}
                            disabled={action.disabled}
                            onSelect={() => deferAction(action.run, action.restoreFocus)}
                          >
                            {action.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  }
                />
              </ContextMenuTrigger>
              {menu.length > 0 && (
                <ContextMenuContent
                  onCloseAutoFocus={onCloseAutoFocus}
                  onClick={stopRowMenuEvent}
                  onKeyDown={stopRowMenuEvent}
                >
                  {menu.map((action) => (
                    <ContextMenuItem
                      key={action.label}
                      disabled={action.disabled}
                      onSelect={() => deferAction(action.run, action.restoreFocus)}
                    >
                      {action.label}
                    </ContextMenuItem>
                  ))}
                </ContextMenuContent>
              )}
            </>
          )}
        </RowMenuOwner>
      );
    }
    return (
      <RowMenuOwner id={n.id}>
        {({ deferAction, onCloseAutoFocus, onMenuOpenChange }) => (
          <>
            <ContextMenuTrigger asChild>
              <div
                {...props}
                role="treeitem"
                tabIndex={props.tabIndex ?? -1}
                aria-selected={item.isSelected()}
                aria-label={
                  n.archived ? `${n.name} (${t('taskFolders.archived')})` : props['aria-label']
                }
                data-folder-id={n.folderId}
                data-task-key={
                  n.identity ? JSON.stringify([n.identity.teamName, n.identity.taskId]) : undefined
                }
                className={`flex h-8 min-w-0 items-center gap-1 rounded px-1 text-xs outline-none focus:ring-1 focus:ring-blue-400 ${n.archived ? 'text-text-muted opacity-60' : 'text-text'} ${item.isDragTarget() ? 'bg-blue-500/20' : ''}`}
                style={{ paddingLeft: indentation }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget || editing || isImeComposing(event))
                    return;
                  if (event.key === 'Enter' && n.kind === 'task') {
                    event.preventDefault();
                    item.primaryAction();
                  } else if (event.key === 'F2' && n.kind === 'folder') {
                    event.preventDefault();
                    if (model.state.status === 'ready') startRename(n);
                  } else props.onKeyDown?.(event);
                }}
              >
                {n.kind !== 'unfiled' && (
                  <Button
                    {...drag}
                    type="button"
                    variant="ghost"
                    size="icon"
                    tabIndex={-1}
                    disabled={model.state.status !== 'ready'}
                    aria-disabled={model.state.status !== 'ready'}
                    aria-label={t(
                      n.kind === 'folder' ? 'taskFolders.dragFolder' : 'taskFolders.dragTask'
                    )}
                    data-testid={
                      n.kind === 'folder' ? 'task-folder-drag-handle' : 'sidebar-task-drag-handle'
                    }
                    draggable={model.state.status === 'ready'}
                    onDragStart={(event) => {
                      if (model.state.status !== 'ready') {
                        event.preventDefault();
                        return;
                      }
                      drag.onDragStart?.(event);
                      if (!event.defaultPrevented) panelController.begin(n.id);
                    }}
                    onDragEnd={(event) => {
                      drag.onDragEnd?.(event);
                      panelController.end();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (model.state.status !== 'ready') return;
                      if (n.identity) taskFolderMoveRequest.open(n.identity);
                      else dialog({ kind: 'moveFolder', id: n.folderId! });
                    }}
                    className={`size-5 shrink-0 p-0 ${model.state.status === 'ready' ? 'cursor-grab' : 'cursor-default opacity-50'}`}
                  >
                    <GripVertical className="size-3" />
                  </Button>
                )}
                {item.isFolder() ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t(
                      item.isExpanded() ? 'taskFolders.collapse' : 'taskFolders.expand'
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (item.isExpanded()) item.collapse();
                      else item.expand();
                    }}
                    className="size-5 shrink-0 p-0"
                  >
                    {item.isExpanded() ? (
                      <ChevronDown className="size-3" />
                    ) : (
                      <ChevronRight className="size-3" />
                    )}
                  </Button>
                ) : n.archived ? (
                  <Archive aria-label={t('taskFolders.archived')} className="size-3 shrink-0" />
                ) : null}
                {n.kind === 'folder' && <Folder className="size-3 shrink-0" />}
                {editing ? (
                  <Input
                    autoFocus
                    value={value}
                    aria-label={t('taskFolders.renameFolder')}
                    aria-invalid={error === 'invalid-name'}
                    disabled={saving}
                    className="h-6 min-w-0 px-1 text-xs"
                    onChange={(event) => {
                      setValue(event.target.value);
                      setError(null);
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Escape') cancelRename();
                      else if (event.key === 'Enter' && !isImeComposing(event)) {
                        event.preventDefault();
                        void saveRename();
                      }
                    }}
                  />
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="min-w-0 flex-1 truncate">
                        {n.kind === 'unfiled' ? t('taskFolders.unfiled') : n.name}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {n.kind === 'unfiled' ? t('taskFolders.unfiled') : n.name}
                    </TooltipContent>
                  </Tooltip>
                )}
                {editing && error && (
                  <span role="alert" className="text-red-400">
                    {t(
                      error === 'invalid-name'
                        ? 'taskFolders.invalidName'
                        : error === 'read-only'
                          ? 'taskFolders.readOnly'
                          : 'taskFolders.saveError'
                    )}
                  </span>
                )}
                {item.isFolder() && unreadCount > 0 && (
                  <span
                    data-testid="task-folder-unread-count"
                    data-unread-count={unreadCount}
                    aria-label={t('taskFolders.unreadTasks', { count: unreadCount })}
                    className="inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-full bg-blue-500 px-1 text-[8px] font-bold leading-none text-white"
                  >
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
                {item.isFolder() && (
                  <span
                    className="ml-auto shrink-0 text-[10px] text-text-muted"
                    aria-label={t('taskFolders.counts', {
                      active: n.active,
                      archived: n.archivedCount,
                      unavailable: n.unavailable,
                    })}
                  >
                    {n.active}/{n.archivedCount}
                    {n.unavailable ? ` +${n.unavailable}?` : ''}
                  </span>
                )}
                {menu.length > 0 && (
                  <DropdownMenu
                    onOpenChange={(open) => {
                      onMenuOpenChange(open);
                      panelController.hold(`menu:dropdown:${n.id}`, open);
                    }}
                  >
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t('taskFolders.actions')}
                        onClick={(event) => event.stopPropagation()}
                        className="size-5 shrink-0 p-0"
                      >
                        <MoreHorizontal className="size-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      onCloseAutoFocus={onCloseAutoFocus}
                      onClick={stopRowMenuEvent}
                      onKeyDown={stopRowMenuEvent}
                    >
                      {menu.map((a) => (
                        <DropdownMenuItem
                          key={a.label}
                          disabled={model.state.status !== 'ready'}
                          onSelect={() => deferAction(a.run, a.restoreFocus)}
                        >
                          {a.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </ContextMenuTrigger>
            {menu.length > 0 && (
              <ContextMenuContent
                onCloseAutoFocus={onCloseAutoFocus}
                onClick={stopRowMenuEvent}
                onKeyDown={stopRowMenuEvent}
              >
                {menu.map((a) => (
                  <ContextMenuItem
                    key={a.label}
                    disabled={model.state.status !== 'ready'}
                    onSelect={() => deferAction(a.run, a.restoreFocus)}
                  >
                    {a.label}
                  </ContextMenuItem>
                ))}
              </ContextMenuContent>
            )}
          </>
        )}
      </RowMenuOwner>
    );
  };
  const container = tree.getContainerProps(t('taskFolders.title'));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 py-1">
        <Button
          variant="ghost"
          size="sm"
          data-testid="task-folders-new-folder-list"
          disabled={model.state.status !== 'ready'}
          className="h-7 w-full justify-start gap-1.5 px-2 text-xs text-text-muted hover:text-text"
          onClick={() => dialog({ kind: 'create', parent: null })}
        >
          <Plus className="size-3.5" />
          {t('taskFolders.newFolder')}
        </Button>
      </div>
      <div
        {...container}
        role="tree"
        tabIndex={container.tabIndex ?? 0}
        ref={(element) => {
          scroll.current = element;
          container.ref?.(element);
        }}
        data-testid="task-folders-tree"
        className="min-h-0 flex-1 overflow-auto"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && rename) {
            event.stopPropagation();
            cancelRename();
          } else container.onKeyDown?.(event);
        }}
      >
        <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((v) => (
            <div
              key={items[v.index].getId()}
              data-index={v.index}
              ref={virtual.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${v.start}px)` }}
            >
              {row(items[v.index])}
            </div>
          ))}
          {tree.getDragTarget() && (
            <div
              className="pointer-events-none absolute h-0.5 bg-blue-400"
              style={tree.getDragLineStyle((scroll.current?.scrollTop ?? 0) - 1)}
            />
          )}
        </div>
      </div>
    </div>
  );
};
