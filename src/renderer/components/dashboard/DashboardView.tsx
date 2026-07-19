/**
 * DashboardView - Main dashboard shell.
 * Keeps only screen composition and delegates recent-projects logic to the feature slice.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { RecentProjectsSection } from '@features/recent-projects/renderer';
import { RunningTeamsSection } from '@features/running-teams/renderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { formatShortcut } from '@renderer/utils/stringUtils';
import { Search, Users } from 'lucide-react';
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

  const commandPaletteLabel = selectedProjectId
    ? `Search in sessions (${formatShortcut('K')})`
    : `Search projects (${formatShortcut('K')})`;

  return (
    <div className="relative w-full">
      <div
        className={`relative flex h-14 items-center gap-3 border-b px-4 transition-colors duration-200 ${
          isFocused ? 'border-zinc-500' : 'border-border hover:border-zinc-600'
        }`}
      >
        <Search className="size-5 shrink-0 text-text-muted" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t('recentProjects.searchPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-base text-text outline-none placeholder:text-text-muted"
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={commandPaletteLabel}
              onClick={() => openCommandPalette()}
              className="shrink-0 rounded px-2 py-1 font-mono text-sm text-text-muted transition-colors hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            >
              {formatShortcut('K')}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{commandPaletteLabel}</TooltipContent>
        </Tooltip>
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

        <div className="mb-12 flex flex-col items-stretch justify-center gap-2 min-[900px]:flex-row min-[900px]:items-center min-[900px]:gap-0">
          <button
            type="button"
            onClick={openTeamsTab}
            className="flex h-14 w-full shrink-0 items-center justify-center gap-3 px-4 text-base text-text-secondary transition-colors duration-200 hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 min-[900px]:w-auto min-[900px]:justify-start"
          >
            <Users className="size-5" />
            {t('actions.selectTeam')}
          </button>
          <div
            className="relative hidden h-14 w-12 shrink-0 items-center justify-center min-[900px]:flex"
            aria-hidden="true"
          >
            <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
            <span className="relative rounded border border-border bg-surface px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-text-muted">
              {t('actions.or')}
            </span>
          </div>
          <span className="text-center text-[9px] font-medium uppercase tracking-wider text-text-muted min-[900px]:hidden">
            {t('actions.or')}
          </span>
          <div className="min-w-0 flex-1">
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
