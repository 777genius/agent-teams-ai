import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog';
import { Button } from '@renderer/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import { cn } from '@renderer/lib/utils';
import { Check, Loader2, Palette, Pencil, Plus, X } from 'lucide-react';

import {
  TERMINAL_TAB_COLOR_OPTIONS,
  type TerminalTabColorId,
} from '../model/terminalTabPreferences';

import { TerminalButtonTooltip } from './TerminalButtonTooltip';

import type { TerminalMuxTabsController } from '../hooks/useTerminalMuxTabsController';

export interface TerminalMuxTabsCopy {
  cancel: string;
  chooseColor: string;
  closeSettings: string;
  closeSettingsTab: string;
  closeTab: string;
  closeTabDialogDescription: string;
  closeTabDialogTitle: string;
  createTab: string;
  editTabTitle: string;
  noTabs: string;
  renameTab: string;
  settingsTab: string;
  tabColor: string;
  tabs: string;
  tabsUnavailable: string;
  closeTabLabel: (tabLabel: string) => string;
  colorLabel: (colorId: TerminalTabColorId) => string;
  unavailableCloseTabLabel: () => string;
}

export interface TerminalMuxTabsViewProps {
  controller: TerminalMuxTabsController;
  copy: TerminalMuxTabsCopy;
  settingsOpen: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
}

export const TerminalMuxTabsView = ({
  controller,
  copy,
  settingsOpen,
  onSettingsOpenChange,
}: TerminalMuxTabsViewProps): React.JSX.Element => {
  const {
    busy,
    cancelRenameTab,
    closeCandidate,
    commitRenameTab,
    confirmCloseCandidate,
    createTab,
    dismissCloseCandidate,
    draggingTabId,
    dropIndicator,
    editingTabId,
    editingTitle,
    endTabPointerDrag,
    error,
    getTabDragOffsetX,
    handleSettingsTabKeyDown,
    handleTabClick,
    handleTabKeyDown,
    handleTabLostPointerCapture,
    handleTabPointerDown,
    handleTabPointerMove,
    handleTabPointerUp,
    pendingAction,
    registerTabButtonElement,
    registerTabElement,
    renameInputRef,
    requestCloseTab,
    setEditingTitle,
    setTabColor,
    settingsTabButtonRef,
    startRenameTab,
    tabListElementRef,
    viewModel,
  } = controller;
  const {
    canCloseVisibleTabs,
    canCreateTab,
    canRenameTab,
    headerPlacement,
    tabItems,
    visibleTabs,
  } = viewModel;

  return (
    <>
      <div
        className={cn(
          'min-w-0 shrink-0',
          headerPlacement
            ? 'bg-transparent px-0 pt-0'
            : 'border-b border-white/10 bg-[#0b0f16] px-2 pt-1'
        )}
        data-testid="agent-team-terminal-mux-tabs"
        onPointerDown={(event) => {
          const target = event.target;
          if (target instanceof HTMLElement && target.closest('button,input')) {
            event.stopPropagation();
          }
        }}
      >
        <div
          className={cn(
            'flex min-w-0 gap-1',
            headerPlacement ? 'min-h-7 items-end' : 'min-h-8 items-end'
          )}
        >
          <div
            className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto"
            ref={tabListElementRef}
            role="tablist"
            aria-label={copy.tabs}
            tabIndex={-1}
          >
            {visibleTabs.length === 0 ? (
              headerPlacement ? (
                <span className="sr-only">{copy.noTabs}</span>
              ) : (
                <span className="px-2 py-1.5 text-xs text-slate-500">{copy.noTabs}</span>
              )
            ) : (
              tabItems.map(({ active, color, explicitColorId, id, label, tab }) => {
                const pendingClose = pendingAction === `close-tab:${id}`;
                const closeLabel = canCloseVisibleTabs
                  ? copy.closeTabLabel(label)
                  : copy.unavailableCloseTabLabel();
                const editing = editingTabId === id;
                const tabColorStyle =
                  active || explicitColorId
                    ? ({
                        backgroundColor: color.background,
                        '--tp-tab-border': color.border,
                        '--tp-tab-border-bottom': active ? 'transparent' : color.border,
                      } as React.CSSProperties)
                    : undefined;
                const dragOffsetX = getTabDragOffsetX(id);
                const tabStyle =
                  dragOffsetX !== 0
                    ? ({
                        ...(tabColorStyle ?? {}),
                        transform: `translateX(${dragOffsetX}px)`,
                      } as React.CSSProperties)
                    : tabColorStyle;

                return (
                  <ContextMenu key={id}>
                    <ContextMenuTrigger asChild>
                      <div
                        ref={(element) => registerTabElement(id, element)}
                        className={cn(
                          'group relative inline-grid h-7 shrink-0 touch-none select-none grid-cols-[minmax(0,1fr)] overflow-hidden border text-xs transition-[background-color,border-color,box-shadow,opacity] duration-150 ease-out will-change-transform',
                          headerPlacement
                            ? 'max-w-40 rounded-b-none rounded-t-md'
                            : 'max-w-44 rounded-b-none rounded-t-md',
                          active
                            ? 'relative z-10 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]'
                            : 'border-white/10 bg-white/[0.035] text-slate-400 hover:bg-white/[0.075] hover:text-slate-200',
                          (active || explicitColorId) &&
                            'border-[var(--tp-tab-border)] border-b-[var(--tp-tab-border-bottom)]',
                          draggingTabId === id &&
                            'z-30 cursor-grabbing shadow-[0_10px_26px_rgba(0,0,0,0.34)]'
                        )}
                        data-active={active}
                        data-dragging={draggingTabId === id}
                        data-drop-placement={
                          dropIndicator?.tabId === id ? dropIndicator.placementMode : undefined
                        }
                        data-terminal-tab-id={id}
                        onLostPointerCapture={handleTabLostPointerCapture}
                        onPointerCancel={endTabPointerDrag}
                        onPointerDown={(event) => handleTabPointerDown(event, id)}
                        onPointerMove={handleTabPointerMove}
                        onPointerUp={(event) => handleTabPointerUp(event, id)}
                        style={tabStyle}
                      >
                        {dropIndicator?.tabId === id && draggingTabId !== id ? (
                          <span
                            className={cn(
                              'pointer-events-none absolute bottom-0 top-1 z-30 w-0.5 rounded-full bg-sky-300/90 shadow-[0_0_10px_rgba(125,211,252,0.75)]',
                              dropIndicator.placementMode === 'before' ? '-left-px' : '-right-px'
                            )}
                            data-testid="agent-team-terminal-tab-drop-indicator"
                          />
                        ) : null}
                        {editing ? (
                          <div className="inline-flex min-w-0 items-center gap-1.5 px-1.5">
                            <Pencil size={12} className="shrink-0 text-slate-400" />
                            <input
                              ref={renameInputRef}
                              className="h-5 min-w-0 flex-1 rounded border border-white/15 bg-black/35 px-1 font-mono text-[12px] text-slate-100 outline-none ring-0 focus:border-sky-400/60"
                              value={editingTitle}
                              aria-label={copy.editTabTitle}
                              data-testid="agent-team-terminal-tab-title-input"
                              onBlur={() => void commitRenameTab()}
                              onChange={(event) => setEditingTitle(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  void commitRenameTab();
                                }
                                if (event.key === 'Escape') {
                                  event.preventDefault();
                                  cancelRenameTab();
                                }
                              }}
                            />
                          </div>
                        ) : (
                          <TerminalButtonTooltip label={tab.title?.trim() || id}>
                            <button
                              ref={(element) => registerTabButtonElement(id, element)}
                              type="button"
                              className="inline-flex min-w-0 items-center gap-1.5 px-2 pr-7 text-left"
                              aria-selected={active}
                              aria-disabled={busy}
                              data-testid="agent-team-terminal-mux-tab"
                              data-terminal-tab-button-id={id}
                              role="tab"
                              tabIndex={active ? 0 : -1}
                              onClick={(event) => handleTabClick(event, id)}
                              onDoubleClick={(event) => {
                                event.preventDefault();
                                startRenameTab(tab, label);
                              }}
                              onKeyDown={(event) => handleTabKeyDown(event, id)}
                            >
                              <span className="min-w-0 truncate">{label}</span>
                            </button>
                          </TerminalButtonTooltip>
                        )}
                        {!editing ? (
                          <TerminalButtonTooltip label={closeLabel}>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className={cn(
                                'pointer-events-none absolute bottom-0 right-0 top-0 z-20 h-7 w-7 rounded-none border-0 bg-transparent p-0 text-slate-500 opacity-0 transition-[background-color,color,opacity] duration-150 hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100',
                                pendingClose && 'pointer-events-auto opacity-100'
                              )}
                              aria-label={copy.closeTabLabel(label)}
                              data-terminal-tab-drag-ignore="true"
                              data-testid="agent-team-terminal-close-mux-tab"
                              disabled={!canCloseVisibleTabs || (busy && !pendingClose)}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation();
                                void requestCloseTab(tab);
                              }}
                            >
                              {pendingClose ? (
                                <Loader2 size={11} className="animate-spin" />
                              ) : (
                                <X size={12} />
                              )}
                            </Button>
                          </TerminalButtonTooltip>
                        ) : null}
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent alignOffset={-4} className="w-48">
                      <ContextMenuItem
                        disabled={!canRenameTab || busy}
                        onSelect={() => startRenameTab(tab, label)}
                      >
                        <Pencil size={13} />
                        {copy.renameTab}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          <Palette size={13} />
                          {copy.tabColor}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-44">
                          <ContextMenuLabel>{copy.chooseColor}</ContextMenuLabel>
                          {TERMINAL_TAB_COLOR_OPTIONS.map((option) => (
                            <ContextMenuItem
                              key={option.id}
                              onSelect={() => setTabColor(id, option.id)}
                            >
                              <span
                                className="size-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: option.accent }}
                              />
                              <span className="min-w-0 flex-1">{copy.colorLabel(option.id)}</span>
                              {color.id === option.id ? <Check size={13} /> : null}
                            </ContextMenuItem>
                          ))}
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })
            )}
            {settingsOpen ? (
              <div
                className={cn(
                  'group relative z-10 inline-grid h-7 max-w-44 shrink-0 select-none grid-cols-[minmax(0,1fr)] overflow-hidden rounded-b-none rounded-t-md border border-sky-400/55 border-b-transparent bg-sky-400/15 text-xs text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]',
                  headerPlacement ? 'max-w-40' : 'max-w-44'
                )}
                data-testid="agent-team-terminal-settings-tab"
              >
                <button
                  ref={settingsTabButtonRef}
                  type="button"
                  className="inline-flex min-w-0 items-center gap-1.5 px-2 pr-7 text-left"
                  aria-selected="true"
                  role="tab"
                  tabIndex={0}
                  onClick={() => onSettingsOpenChange?.(true)}
                  onKeyDown={handleSettingsTabKeyDown}
                >
                  <Palette size={13} className="shrink-0 text-sky-200" />
                  <span className="min-w-0 truncate">{copy.settingsTab}</span>
                </button>
                <TerminalButtonTooltip label={copy.closeSettings}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute bottom-0 right-0 top-0 h-7 w-7 rounded-none border-0 bg-transparent p-0 text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
                    aria-label={copy.closeSettingsTab}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSettingsOpenChange?.(false);
                    }}
                  >
                    <X size={12} />
                  </Button>
                </TerminalButtonTooltip>
              </div>
            ) : null}
            <TerminalButtonTooltip label={canCreateTab ? copy.createTab : copy.tabsUnavailable}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-7 shrink-0 rounded-b-none rounded-t-md border border-white/10 bg-white/[0.04] p-0 text-slate-400 transition-colors hover:bg-white/[0.08] hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
                aria-label={copy.createTab}
                data-testid="agent-team-terminal-new-mux-tab"
                disabled={busy || !canCreateTab}
                onClick={() => void createTab()}
              >
                {pendingAction === 'new-tab' || pendingAction === 'activate-prewarmed-tab' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Plus size={15} />
                )}
              </Button>
            </TerminalButtonTooltip>
          </div>
        </div>

        {error ? (
          <div className="px-2 py-1 text-xs text-red-300" role="alert">
            {error}
          </div>
        ) : null}
      </div>

      <AlertDialog
        open={closeCandidate !== null}
        onOpenChange={(open) => {
          if (!open) {
            dismissCloseCandidate();
          }
        }}
      >
        <AlertDialogContent className="max-w-md bg-[#10141d]">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.closeTabDialogTitle}</AlertDialogTitle>
            <AlertDialogDescription>{copy.closeTabDialogDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmCloseCandidate()}>
              {copy.closeTab}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
