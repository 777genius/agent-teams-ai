import React from 'react';

import { formatModifierShortcut } from '@renderer/utils/keyboardUtils';
import {
  Bell,
  Bot,
  CalendarClock,
  FolderGit2,
  Gauge,
  Loader2,
  MessageSquare,
  Puzzle,
  Search,
  Settings,
  SquareKanban,
  User,
  Users,
  X,
} from 'lucide-react';

import { useCommandPaletteController } from '../hooks/useCommandPaletteController';

import type {
  CommandCategory,
  CommandIconKey,
  CommandItem,
} from '../../core/domain/models/CommandItem';

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  action: 'Action',
  member: 'Member',
  project: 'Project',
  session: 'Session',
  settings: 'Settings',
  task: 'Task',
  team: 'Team',
};

interface CommandIconProps {
  readonly icon: CommandIconKey;
}

function CommandIcon({ icon }: CommandIconProps): React.JSX.Element {
  switch (icon) {
    case 'dashboard':
      return <Gauge className="size-4" />;
    case 'extensions':
      return <Puzzle className="size-4" />;
    case 'member':
      return <User className="size-4" />;
    case 'notifications':
      return <Bell className="size-4" />;
    case 'project':
      return <FolderGit2 className="size-4" />;
    case 'schedules':
      return <CalendarClock className="size-4" />;
    case 'search':
      return <Search className="size-4" />;
    case 'session':
      return <MessageSquare className="size-4" />;
    case 'settings':
      return <Settings className="size-4" />;
    case 'task':
      return <SquareKanban className="size-4" />;
    case 'team':
      return <Users className="size-4" />;
  }
}

interface CommandResultItemProps {
  readonly item: CommandItem;
  readonly selected: boolean;
  readonly onClick: () => void;
}

function CommandResultItem({ item, selected, onClick }: CommandResultItemProps): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={Boolean(item.disabledReason)}
      aria-selected={selected}
      onClick={onClick}
      className={`w-full px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        selected ? 'bg-surface-raised' : 'hover:bg-surface-raised/50'
      }`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 shrink-0 text-text-secondary">
          <CommandIcon icon={item.icon} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-text">{item.title}</span>
            <span className="shrink-0 rounded bg-surface-overlay px-1.5 py-0.5 text-[10px] uppercase tracking-normal text-text-muted">
              {CATEGORY_LABELS[item.category]}
            </span>
            {item.badge && (
              <span className="shrink-0 truncate rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-muted">
                {item.badge}
              </span>
            )}
          </div>
          {item.subtitle && (
            <div className="mt-0.5 truncate text-xs text-text-secondary">{item.subtitle}</div>
          )}
          {item.detail && (
            <div className="mt-1 truncate font-mono text-[11px] text-text-muted">{item.detail}</div>
          )}
          {item.disabledReason && (
            <div className="mt-1 text-xs text-yellow-400">{item.disabledReason}</div>
          )}
        </div>
      </div>
    </button>
  );
}

export function CommandPalette(): React.JSX.Element | null {
  const controller = useCommandPaletteController();

  if (!controller.open) {
    return null;
  }

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[15vh]"
      onClick={controller.handleBackdropClick}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        <div className="bg-surface-raised/50 border-b border-border px-4 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Bot className="size-3.5 shrink-0 text-text-muted" />
              <span className="shrink-0 text-xs text-text-muted">Command palette</span>
              {controller.activeProjectLabel && (
                <>
                  <span className="text-text-muted/50 mx-1 text-xs">·</span>
                  <span className="truncate rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-secondary">
                    {controller.activeProjectLabel}
                  </span>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={controller.toggleGlobalSearch}
              className={`flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
                controller.globalSearchEnabled
                  ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
                  : 'text-text-muted hover:bg-surface-raised hover:text-text'
              }`}
              title={
                !controller.globalSearchEnabled
                  ? `Search conversations across all projects (${formatModifierShortcut('G')})`
                  : undefined
              }
            >
              <Search className="size-3" />
              <span>Global</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="size-5 shrink-0 text-text-muted" />
          <input
            ref={controller.inputRef}
            type="text"
            value={controller.query}
            onChange={(event) => controller.setQuery(event.target.value)}
            onKeyDown={controller.handleKeyDown}
            placeholder="Search projects, conversations, teams, tasks, actions..."
            className="placeholder:text-text-muted/50 min-w-0 flex-1 bg-transparent text-base text-text focus:outline-none"
          />
          {controller.loading && <Loader2 className="size-4 animate-spin text-text-muted" />}
          <button
            type="button"
            onClick={controller.close}
            className="rounded p-1 text-text-muted transition-colors hover:text-text"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto">
          {controller.items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-text-muted">
              {controller.query.trim()
                ? `No commands found for "${controller.query}"`
                : 'No commands found'}
            </div>
          ) : (
            <div className="py-2">
              {controller.items.map((item, index) => (
                <CommandResultItem
                  key={`${item.providerId}:${item.id}`}
                  item={item}
                  selected={index === controller.selectedIndex}
                  onClick={() => void controller.executeItem(item)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-text-muted">
          <span>
            {controller.items.length} result{controller.items.length === 1 ? '' : 's'}
          </span>
          <div className="flex items-center gap-4">
            <span>
              <kbd className="rounded bg-surface-overlay px-1.5 py-0.5 text-[10px]">↑↓</kbd>{' '}
              navigate
            </span>
            <span>
              <kbd className="rounded bg-surface-overlay px-1.5 py-0.5 text-[10px]">↵</kbd> run
            </span>
            <span>
              <kbd className="rounded bg-surface-overlay px-1.5 py-0.5 text-[10px]">
                {formatModifierShortcut('G')}
              </kbd>{' '}
              global
            </span>
            <span>
              <kbd className="rounded bg-surface-overlay px-1.5 py-0.5 text-[10px]">esc</kbd> close
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
