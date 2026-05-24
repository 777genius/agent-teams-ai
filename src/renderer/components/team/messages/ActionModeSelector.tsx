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
  labelKey:
    | 'messages.actionMode.modes.do.label'
    | 'messages.actionMode.modes.ask.label'
    | 'messages.actionMode.modes.delegate.label';
  tooltipKey:
    | 'messages.actionMode.modes.do.tooltip'
    | 'messages.actionMode.modes.ask.tooltip'
    | 'messages.actionMode.modes.delegate.tooltip';
  activeClass: string;
  tooltipClass: string;
}[] = [
  {
    mode: 'do',
    labelKey: 'messages.actionMode.modes.do.label',
    tooltipKey: 'messages.actionMode.modes.do.tooltip',
    activeClass: 'bg-rose-500/80 text-white',
    tooltipClass: 'bg-rose-500/80 border-rose-600 text-white',
  },
  {
    mode: 'ask',
    labelKey: 'messages.actionMode.modes.ask.label',
    tooltipKey: 'messages.actionMode.modes.ask.tooltip',
    activeClass: 'bg-blue-600 text-white',
    tooltipClass: 'bg-blue-600 border-blue-700 text-white',
  },
  {
    mode: 'delegate',
    labelKey: 'messages.actionMode.modes.delegate.label',
    tooltipKey: 'messages.actionMode.modes.delegate.tooltip',
    activeClass: 'bg-amber-500/80 text-white',
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
        className="inline-flex items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]"
        role="radiogroup"
        aria-label={t('messages.actionMode.label')}
      >
        {modes.map((cfg, idx) => {
          const isActive = value === cfg.mode;
          const isFirst = idx === 0;
          const isLast = idx === modes.length - 1;

          return (
            <Tooltip key={cfg.mode} disableHoverableContent>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  className={cn(
                    'px-2 py-0.5 text-[10px] font-medium transition-colors',
                    isFirst && 'rounded-l-full',
                    isLast && 'rounded-r-full',
                    disabled && 'cursor-not-allowed opacity-50',
                    isActive
                      ? cfg.activeClass
                      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                  )}
                  disabled={disabled}
                  onClick={() => onChange(cfg.mode)}
                >
                  {t(cfg.labelKey)}
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className={cn(cfg.tooltipClass, 'data-[state=closed]:animate-none')}
              >
                {t(cfg.tooltipKey)}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
};
