/**
 * DashboardView - Main dashboard shell.
 * Keeps only screen composition and delegates recent-projects logic to the feature slice.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { RecentProjectsSection } from '@features/recent-projects/renderer';
import { RunningTeamsSection } from '@features/running-teams/renderer';
import { useStore } from '@renderer/store';
import { formatShortcut } from '@renderer/utils/stringUtils';
import { Command, Search, Users } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { CliStatusBanner } from './CliStatusBanner';
import { DashboardUpdateBanner } from './DashboardUpdateBanner';
import { TmuxStatusBanner } from './TmuxStatusBanner';
import { WebPreviewBanner } from './WebPreviewBanner';
import { WindowsAdministratorBanner } from './WindowsAdministratorBanner';

interface CommandSearchProps {
  value: string;
  onChange: (value: string) => void;
}

const CommandSearch = ({ value, onChange }: Readonly<CommandSearchProps>): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { openCommandPalette, selectedProjectId } = useStore(
    useShallow((state) => ({
      openCommandPalette: state.openCommandPalette,
      selectedProjectId: state.selectedProjectId,
    }))
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.code === 'KeyK') {
        event.preventDefault();
        openCommandPalette();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openCommandPalette]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }

    input.focus({ preventScroll: true });
    const timeoutId = window.setTimeout(() => {
      if (document.activeElement !== input) {
        input.focus({ preventScroll: true });
      }
    }, 50);

    return () => window.clearTimeout(timeoutId);
  }, []);

  return (
    <div className="relative w-full">
      <div
        className={`relative flex items-center gap-3 rounded-sm border bg-surface-raised px-4 py-3 transition-all duration-200 ${
          isFocused
            ? 'border-zinc-500 shadow-[0_0_20px_rgba(255,255,255,0.04)] ring-1 ring-zinc-600/30'
            : 'border-border hover:border-zinc-600'
        } `}
      >
        <Search className="size-4 shrink-0 text-text-muted" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t('recentProjects.searchPlaceholder')}
          className="flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-muted"
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
        />
        <button
          onClick={() => openCommandPalette()}
          className="flex shrink-0 items-center gap-1 transition-opacity hover:opacity-80"
          title={
            selectedProjectId
              ? `Search in sessions (${formatShortcut('K')})`
              : `Search projects (${formatShortcut('K')})`
          }
        >
          <kbd className="flex h-5 items-center justify-center rounded border border-border bg-surface-overlay px-1.5 text-[10px] font-medium text-text-muted">
            <Command className="size-2.5" />
          </kbd>
          <kbd className="flex size-5 items-center justify-center rounded border border-border bg-surface-overlay text-[10px] font-medium text-text-muted">
            K
          </kbd>
        </button>
      </div>
    </div>
  );
};

interface DashboardViewProps {
  isActive?: boolean;
}

export const DashboardView = ({ isActive = true }: DashboardViewProps): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const [searchQuery, setSearchQuery] = useState('');
  const openTeamsTab = useStore((state) => state.openTeamsTab);

  return (
    <div className="relative flex-1 overflow-auto bg-surface">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[600px] bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(99,102,241,0.08),transparent)]"
        aria-hidden="true"
      />

      <div className="relative mx-auto max-w-5xl px-8 py-12">
        <WebPreviewBanner />
        <WindowsAdministratorBanner />
        <DashboardUpdateBanner />
        <CliStatusBanner isDashboardActive={isActive} />
        <TmuxStatusBanner />

        <div className="mb-12 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
          <button
            onClick={openTeamsTab}
            className="flex shrink-0 items-center justify-center gap-2 rounded-sm border border-border bg-surface-raised px-4 py-3 text-sm text-text-secondary transition-all duration-200 hover:border-zinc-500 hover:text-text"
          >
            <Users className="size-4" />
            {t('actions.selectTeam')}
          </button>
          <span className="hidden shrink-0 text-xs text-text-muted sm:block">
            {t('actions.or')}
          </span>
          <div className="flex-1">
            <CommandSearch value={searchQuery} onChange={setSearchQuery} />
          </div>
        </div>

        <RunningTeamsSection searchQuery={searchQuery} />

        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wider text-text-muted">
            {searchQuery.trim() ? t('recentProjects.searchResults') : t('recentProjects.title')}
          </h2>
          {searchQuery.trim() && (
            <button
              onClick={() => setSearchQuery('')}
              className="text-xs text-text-muted transition-colors hover:text-text-secondary"
            >
              {t('actions.clearSearch')}
            </button>
          )}
        </div>

        <RecentProjectsSection searchQuery={searchQuery} />
      </div>
    </div>
  );
};
