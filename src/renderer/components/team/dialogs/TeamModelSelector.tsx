import React, { useEffect, useRef, useState } from 'react';

import { Label } from '@renderer/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { Check, ChevronDown, Info } from 'lucide-react';

// --- Provider SVG Icons (real brand logos from Simple Icons, monochrome currentColor) ---

/** Anthropic — official "A" lettermark (Simple Icons) */
const AnthropicIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M17.304 3.541h-3.672l6.696 16.918H24Zm-10.608 0L0 20.459h3.744l1.37-3.553h7.005l1.369 3.553h3.744L10.536 3.541Zm-.371 10.223 2.291-5.946 2.292 5.946Z" />
  </svg>
);

/** OpenAI — official hexagonal knot logo (Simple Icons) */
const OpenAIIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.998 5.998 0 0 0-3.992 2.9 6.042 6.042 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.612-1.5z" />
  </svg>
);

/** Google Gemini — official sparkle/star mark (Simple Icons) */
const GoogleIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
  </svg>
);

/** Local — server rack icon */
const LocalIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className}>
    <rect x="3" y="3" width="18" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
    <rect x="3" y="14" width="18" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="7" cy="6.5" r="1" fill="currentColor" />
    <circle cx="7" cy="17.5" r="1" fill="currentColor" />
    <line
      x1="10.5"
      y1="6.5"
      x2="17.5"
      y2="6.5"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
    <line
      x1="10.5"
      y1="17.5"
      x2="17.5"
      y2="17.5"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);

// --- Provider definitions ---

interface ProviderDef {
  id: string;
  label: string;
  icon: React.FC<{ className?: string }>;
  comingSoon: boolean;
}

const PROVIDERS: ProviderDef[] = [
  { id: 'anthropic', label: 'Anthropic', icon: AnthropicIcon, comingSoon: false },
  { id: 'openai', label: 'OpenAI', icon: OpenAIIcon, comingSoon: true },
  { id: 'google', label: 'Google', icon: GoogleIcon, comingSoon: true },
  { id: 'local', label: 'Local', icon: LocalIcon, comingSoon: true },
];

const ACTIVE_PROVIDER = PROVIDERS[0];

// --- Model options (Anthropic only for now) ---

const MODEL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus 4.6' },
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
] as const;

/**
 * Computes the effective model string for team provisioning.
 * By default adds [1m] suffix for 1M context (Opus/Sonnet).
 * When limitContext=true, returns base model without [1m] (200K context).
 * Haiku does not support 1M — always returned as-is.
 */
export function computeEffectiveTeamModel(
  selectedModel: string,
  limitContext: boolean
): string | undefined {
  const base = selectedModel || undefined;
  if (limitContext) return base;
  if (base === 'haiku') return base;
  return base ? `${base}[1m]` : 'sonnet[1m]';
}

export interface TeamModelSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  id?: string;
}

export const TeamModelSelector: React.FC<TeamModelSelectorProps> = ({
  value,
  onValueChange,
  id,
}) => {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    if (!dropdownOpen) return;

    const handleClickOutside = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  const ProviderIcon = ACTIVE_PROVIDER.icon;

  return (
    <div className="mb-5">
      <Label htmlFor={id} className="label-optional mb-1.5 block">
        Model (optional)
      </Label>
      <div ref={containerRef} className="relative inline-block">
        <div className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
          {/* Provider button */}
          <button
            type="button"
            className={cn(
              'flex items-center gap-1.5 rounded-[3px] px-2.5 py-1 text-xs font-medium transition-colors',
              'mr-0.5 border-r border-[var(--color-border)] pr-2.5',
              dropdownOpen
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
            )}
            onClick={() => setDropdownOpen(!dropdownOpen)}
          >
            <ProviderIcon className="size-3.5" />
            <span>{ACTIVE_PROVIDER.label}</span>
            <ChevronDown
              className={cn(
                'size-3 transition-transform duration-200',
                dropdownOpen && 'rotate-180'
              )}
            />
          </button>

          {/* Model pills */}
          {MODEL_OPTIONS.map((opt) => (
            <button
              key={opt.value || '__default__'}
              type="button"
              id={opt.value === value ? id : undefined}
              className={cn(
                'flex items-center gap-1 rounded-[3px] px-3 py-1 text-xs font-medium transition-colors',
                value === opt.value
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              )}
              onClick={() => onValueChange(opt.value)}
            >
              {opt.label}
              {opt.value === '' && (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                      <Info className="size-3 opacity-40 transition-opacity hover:opacity-70" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[240px] text-xs">
                      Default model from Claude CLI (/model).
                      <br />
                      Currently Sonnet 4.6, but may change with CLI updates.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </button>
          ))}
        </div>

        {/* Provider dropdown */}
        {dropdownOpen && (
          <div
            className="absolute bottom-full left-0 z-50 mb-1 min-w-[220px] overflow-hidden rounded-md border py-1 shadow-xl shadow-black/20"
            style={{
              backgroundColor: 'var(--color-surface-raised)',
              borderColor: 'var(--color-border-subtle)',
            }}
          >
            {PROVIDERS.map((provider, index) => {
              const Icon = provider.icon;
              const isActive = provider.id === ACTIVE_PROVIDER.id;
              const isFirst = index === 0;
              const prevWasActive = index > 0 && !PROVIDERS[index - 1].comingSoon;

              return (
                <React.Fragment key={provider.id}>
                  {prevWasActive && !isFirst && (
                    <div
                      className="mx-2 my-1 border-t"
                      style={{ borderColor: 'var(--color-border-subtle)' }}
                    />
                  )}
                  <button
                    type="button"
                    disabled={provider.comingSoon}
                    onClick={() => {
                      if (!provider.comingSoon) {
                        setDropdownOpen(false);
                      }
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors duration-100',
                      isActive && 'bg-indigo-500/10 text-indigo-400',
                      provider.comingSoon && 'cursor-not-allowed opacity-40',
                      !isActive && !provider.comingSoon && 'hover:bg-white/5'
                    )}
                    style={
                      !isActive && !provider.comingSoon
                        ? { color: 'var(--color-text-secondary)' }
                        : undefined
                    }
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="flex-1">{provider.label}</span>
                    {provider.comingSoon && (
                      <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                        Coming Soon
                      </span>
                    )}
                    {isActive && <Check className="size-3.5 shrink-0" />}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
