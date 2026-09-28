import { useAppTranslation } from '@features/localization/renderer';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { cn } from '@renderer/lib/utils';
import { nameColorSet } from '@renderer/utils/projectColor';
import { Check, ChevronDown, UsersRound } from 'lucide-react';

import type { CrossTeamTarget } from '@shared/types';

interface MessageComposerTeamSelectorProps {
  currentTeamColor: string;
  currentTeamDisplayName: string;
  hasCrossTeamOptions: boolean;
  isCrossTeam: boolean;
  open: boolean;
  selectedTarget?: CrossTeamTarget;
  selectedTeam: string | null;
  sortedCrossTeamTargets: Array<CrossTeamTarget & { isOnline: boolean }>;
  targetDisplayName: string | null;
  draftMetaByTeam: ReadonlyMap<
    string,
    { readonly groupPreview: string | null; readonly count: number }
  >;
  onOpenChange: (open: boolean) => void;
  onSelectCurrent: () => void;
  onSelectTarget: (teamName: string) => void;
}

export const MessageComposerTeamSelector = ({
  currentTeamColor,
  currentTeamDisplayName,
  hasCrossTeamOptions,
  isCrossTeam,
  open,
  selectedTarget,
  selectedTeam,
  sortedCrossTeamTargets,
  targetDisplayName,
  draftMetaByTeam,
  onOpenChange,
  onSelectCurrent,
  onSelectTarget,
}: MessageComposerTeamSelectorProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const selectedTeamColor = isCrossTeam
    ? selectedTarget?.color
      ? getTeamColorSet(selectedTarget.color).border
      : selectedTarget
        ? nameColorSet(selectedTarget.displayName).border
        : undefined
    : currentTeamColor;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${t('list.title')}: ${targetDisplayName ?? currentTeamDisplayName}`}
          className={cn(
            'inline-flex min-w-0 items-center justify-end gap-1 border-r border-r-[var(--color-border)] pl-1 pr-2 text-xs transition-colors',
            isCrossTeam
              ? 'hover:bg-[var(--cross-team-bg)]/80 bg-[var(--cross-team-bg)] text-purple-400'
              : 'hover:bg-white/[0.025]'
          )}
        >
          <UsersRound
            size={13}
            className="shrink-0"
            style={{ color: selectedTeamColor }}
            aria-hidden="true"
          />
          {isCrossTeam ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="min-w-0 truncate">{targetDisplayName}</span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{targetDisplayName}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="min-w-0 truncate text-[var(--color-text-secondary)]">
              {currentTeamDisplayName}
            </span>
          )}
          <ChevronDown size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1.5">
        <div className="px-2 pb-1.5 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
          {t('list.title')}
        </div>
        <div className="max-h-48 space-y-0.5 overflow-y-auto">
          <button
            type="button"
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)]',
              !isCrossTeam && 'bg-[var(--color-surface-raised)]'
            )}
            onClick={onSelectCurrent}
          >
            <span
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ backgroundColor: currentTeamColor }}
            />
            <span className="truncate text-[var(--color-text)]">{currentTeamDisplayName}</span>
            <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
              {t('messageComposer.teamSelector.current')}
            </span>
            {!isCrossTeam ? <Check size={12} className="ml-auto shrink-0 text-blue-400" /> : null}
          </button>

          {hasCrossTeamOptions ? (
            <>
              <div className="my-1 h-px bg-[var(--color-border)]" />
              {sortedCrossTeamTargets.map((target) => {
                const isSelected = selectedTeam === target.teamName;
                const draftMeta = draftMetaByTeam.get(target.teamName);
                return (
                  <button
                    key={target.teamName}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)]',
                      isSelected && 'bg-[var(--cross-team-bg)]'
                    )}
                    onClick={() => onSelectTarget(target.teamName)}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={cn(
                            'inline-block size-2 shrink-0 rounded-full',
                            target.isOnline && 'animate-pulse'
                          )}
                          style={{
                            backgroundColor: target.isOnline
                              ? '#22c55e'
                              : target.color
                                ? getTeamColorSet(target.color).border
                                : nameColorSet(target.displayName).border,
                          }}
                        />
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {target.isOnline
                          ? t('messageComposer.teamSelector.onlineTitle')
                          : t('messageComposer.teamSelector.offlineTitle')}
                      </TooltipContent>
                    </Tooltip>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <div className="truncate text-[var(--color-text)]">
                          {target.displayName}
                        </div>
                        <span
                          className={cn(
                            'shrink-0 text-[10px]',
                            target.isOnline ? 'text-green-400' : 'text-[var(--color-text-muted)]'
                          )}
                        >
                          {target.isOnline
                            ? t('messageComposer.teamSelector.online')
                            : t('messageComposer.teamSelector.offline')}
                        </span>
                      </div>
                      {draftMeta ? (
                        <div className="truncate text-[10px] text-[var(--color-text-secondary)]">
                          {draftMeta.groupPreview ? (
                            <>
                              <span className="font-medium text-blue-400">
                                {t('messages.chats.draft')}:
                              </span>{' '}
                              {draftMeta.groupPreview}
                              {draftMeta.count > 1 ? ` · +${draftMeta.count - 1}` : ''}
                            </>
                          ) : (
                            t('messages.chats.drafts', { count: draftMeta.count })
                          )}
                        </div>
                      ) : target.description ? (
                        <div className="truncate text-[10px] text-[var(--color-text-muted)]">
                          {target.description}
                        </div>
                      ) : null}
                    </div>
                    {isSelected ? (
                      <Check size={12} className="ml-auto shrink-0 text-purple-400" />
                    ) : null}
                  </button>
                );
              })}
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
};
