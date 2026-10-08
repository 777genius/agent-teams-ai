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
  formatMuxTabTitle,
  formatTerminalTabColorLabel,
  resolveTerminalTabColor,
  type TeamTFunction,
  TERMINAL_TAB_COLOR_OPTIONS,
  type TerminalMuxTab,
  type TerminalTabColorId,
  type TerminalTabDropIndicator,
  type TerminalTabPointerDrag,
  type TerminalTabPreferences,
} from '../model/terminalTabPreferences';

import { TerminalButtonTooltip } from './TerminalButtonTooltip';

import type { resolveTerminalTopologyControlState } from '@terminal-platform/workspace-react';
import type { RefObject } from 'react';

interface TerminalMuxTabsViewProps {
  t: TeamTFunction;
  headerPlacement: boolean;
  visibleTabs: TerminalMuxTab[];
  orderedVisibleTabs: TerminalMuxTab[];
  tabPreferences: TerminalTabPreferences;
  settingsOpen: boolean;
  activeVisibleTabId: string | null;
  pendingAction: string | null;
  canCloseVisibleTabs: boolean;
  editingTabId: string | null;
  editingTitle: string;
  draggingTabId: string | null;
  dropIndicator: TerminalTabDropIndicator | null;
  tabPointerDrag: TerminalTabPointerDrag | null;
  busy: boolean;
  error: string | null;
  closeCandidate: TerminalMuxTab | null;
  controls: ReturnType<typeof resolveTerminalTopologyControlState>;
  tabListElementRef: RefObject<HTMLDivElement | null>;
  renameInputRef: RefObject<HTMLInputElement | null>;
  registerTabElement: (tabId: string, element: HTMLDivElement | null) => void;
  endTabPointerDrag: (event?: React.PointerEvent<HTMLDivElement>) => void;
  handleTabPointerDown: (event: React.PointerEvent<HTMLDivElement>, tab: TerminalMuxTab) => void;
  handleTabPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  handleTabPointerUp: (event: React.PointerEvent<HTMLDivElement>, tab: TerminalMuxTab) => void;
  suppressNextTabClickRef: RefObject<boolean>;
  focusTab: (tabId: string) => Promise<void>;
  startRenameTab: (tab: TerminalMuxTab, label: string) => void;
  commitRenameTab: () => Promise<void>;
  setEditingTitle: (title: string) => void;
  cancelRenameTab: () => void;
  requestCloseTab: (tab: TerminalMuxTab) => Promise<void>;
  setTabColor: (tabId: string, colorId: TerminalTabColorId) => void;
  onSettingsOpenChange: ((open: boolean) => void) | undefined;
  createTab: () => Promise<void>;
  setCloseCandidate: (tab: TerminalMuxTab | null) => void;
  closeTab: (tab: TerminalMuxTab) => Promise<void>;
}

export function renderTerminalMuxTabs({
  t,
  headerPlacement,
  visibleTabs,
  orderedVisibleTabs,
  tabPreferences,
  settingsOpen,
  activeVisibleTabId,
  pendingAction,
  canCloseVisibleTabs,
  editingTabId,
  editingTitle,
  draggingTabId,
  dropIndicator,
  tabPointerDrag,
  busy,
  error,
  closeCandidate,
  controls,
  tabListElementRef,
  renameInputRef,
  registerTabElement,
  endTabPointerDrag,
  handleTabPointerDown,
  handleTabPointerMove,
  handleTabPointerUp,
  suppressNextTabClickRef,
  focusTab,
  startRenameTab,
  commitRenameTab,
  setEditingTitle,
  cancelRenameTab,
  requestCloseTab,
  setTabColor,
  onSettingsOpenChange,
  createTab,
  setCloseCandidate,
  closeTab,
}: TerminalMuxTabsViewProps): React.JSX.Element {
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
            className={cn(
              'flex min-w-0 flex-1 gap-1 overflow-x-auto',
              headerPlacement ? 'items-end' : 'items-end'
            )}
            ref={tabListElementRef}
            role="tablist"
            aria-label={t('terminalWorkspace.terminalTabs')}
            tabIndex={-1}
          >
            {visibleTabs.length === 0 ? (
              headerPlacement ? (
                <span className="sr-only">{t('terminalWorkspace.noTerminalTabs')}</span>
              ) : (
                <span className="px-2 py-1.5 text-xs text-slate-500">
                  {t('terminalWorkspace.noTerminalTabs')}
                </span>
              )
            ) : (
              orderedVisibleTabs.map((tab, index) => {
                const label = formatMuxTabTitle(tab, index);
                const active = !settingsOpen && tab.tab_id === activeVisibleTabId;
                const pendingClose = pendingAction === `close-tab:${tab.tab_id}`;
                const closeLabel = canCloseVisibleTabs
                  ? t('terminalWorkspace.closeTerminalTab', { tab: label })
                  : t('terminalWorkspace.createAnotherTabBeforeClosing');
                const explicitColorId = tabPreferences.colors[tab.tab_id];
                const color = resolveTerminalTabColor(explicitColorId);
                const editing = editingTabId === tab.tab_id;
                const tabColorStyle =
                  active || explicitColorId
                    ? ({
                        backgroundColor: color.background,
                        '--tp-tab-border': color.border,
                        '--tp-tab-border-bottom': active ? 'transparent' : color.border,
                      } as React.CSSProperties)
                    : undefined;
                const dragOffsetX =
                  tabPointerDrag?.tabId === tab.tab_id ? tabPointerDrag.offsetX : 0;
                const tabStyle =
                  dragOffsetX !== 0
                    ? ({
                        ...(tabColorStyle ?? {}),
                        transform: `translateX(${dragOffsetX}px)`,
                      } as React.CSSProperties)
                    : tabColorStyle;
                return (
                  <ContextMenu key={tab.tab_id}>
                    <ContextMenuTrigger asChild>
                      <div
                        ref={(element) => registerTabElement(tab.tab_id, element)}
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
                          draggingTabId === tab.tab_id &&
                            'z-30 cursor-grabbing shadow-[0_10px_26px_rgba(0,0,0,0.34)]'
                        )}
                        data-active={active}
                        data-dragging={draggingTabId === tab.tab_id}
                        data-drop-placement={
                          dropIndicator?.tabId === tab.tab_id
                            ? dropIndicator.placementMode
                            : undefined
                        }
                        data-terminal-tab-id={tab.tab_id}
                        onPointerCancel={endTabPointerDrag}
                        onPointerDown={(event) => handleTabPointerDown(event, tab)}
                        onPointerMove={handleTabPointerMove}
                        onPointerUp={(event) => handleTabPointerUp(event, tab)}
                        style={tabStyle}
                      >
                        {dropIndicator?.tabId === tab.tab_id && draggingTabId !== tab.tab_id ? (
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
                              aria-label={t('terminalWorkspace.editTerminalTabTitle')}
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
                          <TerminalButtonTooltip label={tab.title?.trim() || tab.tab_id}>
                            <button
                              type="button"
                              className="inline-flex min-w-0 items-center gap-1.5 px-2 pr-7 text-left"
                              aria-selected={active}
                              data-testid="agent-team-terminal-mux-tab"
                              disabled={busy}
                              role="tab"
                              onClick={(event) => {
                                if (suppressNextTabClickRef.current) {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  return;
                                }
                                void focusTab(tab.tab_id);
                              }}
                              onDoubleClick={(event) => {
                                event.preventDefault();
                                startRenameTab(tab, label);
                              }}
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
                              aria-label={t('terminalWorkspace.closeTerminalTab', { tab: label })}
                              data-terminal-tab-drag-ignore="true"
                              data-testid="agent-team-terminal-close-mux-tab"
                              disabled={!canCloseVisibleTabs || (busy && !pendingClose)}
                              onPointerDown={(event) => {
                                event.stopPropagation();
                              }}
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
                        disabled={!controls.canRenameTab || busy}
                        onSelect={() => startRenameTab(tab, label)}
                      >
                        <Pencil size={13} />
                        {t('terminalWorkspace.renameTab')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          <Palette size={13} />
                          {t('terminalWorkspace.tabColor')}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-44">
                          <ContextMenuLabel>{t('terminalWorkspace.chooseColor')}</ContextMenuLabel>
                          {TERMINAL_TAB_COLOR_OPTIONS.map((option) => (
                            <ContextMenuItem
                              key={option.id}
                              onSelect={() => setTabColor(tab.tab_id, option.id)}
                            >
                              <span
                                className="size-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: option.accent }}
                              />
                              <span className="min-w-0 flex-1">
                                {formatTerminalTabColorLabel(t, option.id)}
                              </span>
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
                  type="button"
                  className="inline-flex min-w-0 items-center gap-1.5 px-2 pr-7 text-left"
                  aria-selected="true"
                  role="tab"
                  onClick={() => onSettingsOpenChange?.(true)}
                >
                  <Palette size={13} className="shrink-0 text-sky-200" />
                  <span className="min-w-0 truncate">{t('terminalWorkspace.settingsTab')}</span>
                </button>
                <TerminalButtonTooltip label={t('terminalWorkspace.closeTerminalSettings')}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute bottom-0 right-0 top-0 h-7 w-7 rounded-none border-0 bg-transparent p-0 text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
                    aria-label={t('terminalWorkspace.closeTerminalSettingsTab')}
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
            <TerminalButtonTooltip
              label={
                controls.canCreateTab
                  ? t('terminalWorkspace.createTerminalTab')
                  : t('terminalWorkspace.terminalTabsUnavailable')
              }
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  'size-7 shrink-0 border border-white/10 bg-white/[0.04] p-0 text-slate-400 transition-colors hover:bg-white/[0.08] hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-45',
                  'rounded-b-none rounded-t-md'
                )}
                aria-label={t('terminalWorkspace.createTerminalTab')}
                data-testid="agent-team-terminal-new-mux-tab"
                disabled={busy || !controls.canCreateTab}
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
            setCloseCandidate(null);
          }
        }}
      >
        <AlertDialogContent className="max-w-md bg-[#10141d]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('terminalWorkspace.closeTerminalTabDialogTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('terminalWorkspace.closeTerminalTabDialogDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('terminalWorkspace.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const tab = closeCandidate;
                setCloseCandidate(null);
                if (tab) {
                  void closeTab(tab);
                }
              }}
            >
              {t('terminalWorkspace.closeTab')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
