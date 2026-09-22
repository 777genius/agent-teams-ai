import { useAppTranslation } from '@features/localization/renderer';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';

import type { AgentActionMode } from '@shared/types';

export type ActionMode = AgentActionMode;

interface ActionModeSelectorProps {
  value: ActionMode;
  onChange: (mode: ActionMode) => void;
  showDelegate: boolean;
  disabled?: boolean;
}

const MODE_CONFIG: {
  mode: ActionMode;
  label: string;
  tooltip: string;
  activeClass: string;
  tooltipClass: string;
}[] = [
  {
    mode: 'do',
    label: 'Do',
    tooltip: 'Full execution mode - can change code/state, run commands, or delegate',
    activeClass: 'text-rose-300 after:bg-rose-400 after:opacity-100',
    tooltipClass: 'bg-rose-500/80 border-rose-600 text-white',
  },
  {
    mode: 'ask',
    label: 'Ask',
    tooltip: 'Read-only discussion mode - no code/state changes or commands',
    activeClass: 'text-sky-300 after:bg-sky-400 after:opacity-100',
    tooltipClass: 'bg-blue-600 border-blue-700 text-white',
  },
  {
    mode: 'delegate',
    label: 'Delegate',
    tooltip: 'Lead-only orchestration - delegate everything, do not execute yourself',
    activeClass: 'text-amber-300 after:bg-amber-400 after:opacity-100',
    tooltipClass: 'bg-amber-500/80 border-amber-600 text-white',
  },
];

export const ActionModeSelector = ({
  value,
  onChange,
  showDelegate,
  disabled = false,
}: ActionModeSelectorProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const modes = showDelegate ? MODE_CONFIG : MODE_CONFIG.filter((m) => m.mode !== 'delegate');

  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={300}>
      <div
        className="message-composer-action-modes inline-flex h-7 items-stretch overflow-hidden rounded-md border border-[var(--color-border)]"
        role="radiogroup"
        aria-label={t('messages.actionMode.label')}
      >
        {modes.map((cfg, idx) => {
          const isActive = value === cfg.mode;

          return (
            <Tooltip key={cfg.mode} disableHoverableContent>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  className={cn(
                    'relative min-w-9 px-1.5 text-[10px] font-medium transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-px after:opacity-0 after:transition-opacity',
                    idx > 0 && 'border-l border-[var(--color-border)]',
                    disabled && 'cursor-not-allowed opacity-50',
                    isActive
                      ? cfg.activeClass
                      : 'text-[var(--color-text-muted)] hover:bg-white/[0.025] hover:text-[var(--color-text-secondary)]'
                  )}
                  disabled={disabled}
                  onClick={() => onChange(cfg.mode)}
                >
                  {cfg.label}
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className={cn(cfg.tooltipClass, 'data-[state=closed]:animate-none')}
              >
                {cfg.tooltip}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
};
