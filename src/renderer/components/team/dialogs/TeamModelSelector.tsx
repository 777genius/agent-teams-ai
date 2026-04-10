import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Label } from '@renderer/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import {
  GEMINI_UI_DISABLED_BADGE_LABEL,
  GEMINI_UI_DISABLED_REASON,
  isGeminiUiFrozen,
} from '@renderer/utils/geminiUiFreeze';
import {
  getTeamModelUiDisabledReason,
  normalizeTeamModelForUi,
  TEAM_MODEL_UI_DISABLED_BADGE_LABEL,
} from '@renderer/utils/teamModelAvailability';
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

const GoogleGeminiIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M12 2.25c.62 3.9 1.6 6.57 3.18 8.15 1.58 1.58 4.25 2.56 8.15 3.18-3.9.62-6.57 1.6-8.15 3.18-1.58 1.58-2.56 4.25-3.18 8.15-.62-3.9-1.6-6.57-3.18-8.15-1.58-1.58-4.25-2.56-8.15-3.18 3.9-.62 6.57-1.6 8.15-3.18C10.4 8.82 11.38 6.15 12 2.25Z" />
  </svg>
);

const OpenCodeIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className}>
    <defs>
      <linearGradient id="opencode-bg" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#303030" />
        <stop offset="1" stopColor="#161616" />
      </linearGradient>
      <linearGradient
        id="opencode-frame"
        x1="7"
        y1="4.5"
        x2="17"
        y2="19.5"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#f4f4f4" />
        <stop offset="0.35" stopColor="#d9d9d9" />
        <stop offset="0.68" stopColor="#a8a8a8" />
        <stop offset="1" stopColor="#ececec" />
      </linearGradient>
      <linearGradient
        id="opencode-frame-stroke"
        x1="7"
        y1="4.5"
        x2="17"
        y2="19.5"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#ffffff" stopOpacity="0.9" />
        <stop offset="1" stopColor="#5a5a5a" stopOpacity="0.9" />
      </linearGradient>
      <linearGradient
        id="opencode-core"
        x1="12"
        y1="7"
        x2="12"
        y2="17"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#121212" />
        <stop offset="0.42" stopColor="#3e3b33" />
        <stop offset="1" stopColor="#16140f" />
      </linearGradient>
      <linearGradient
        id="opencode-core-stroke"
        x1="9"
        y1="7"
        x2="15"
        y2="17"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#f2f2f2" stopOpacity="0.95" />
        <stop offset="1" stopColor="#6e6e6e" stopOpacity="0.85" />
      </linearGradient>
      <filter id="opencode-shadow" x="0" y="0" width="24" height="24" filterUnits="userSpaceOnUse">
        <feDropShadow dx="0" dy="1.2" stdDeviation="1.2" floodColor="#000000" floodOpacity="0.42" />
      </filter>
    </defs>
    <rect x="1.5" y="1.5" width="21" height="21" rx="5.2" fill="url(#opencode-bg)" />
    <g filter="url(#opencode-shadow)">
      <path
        d="M7 4.25h10c.3 0 .55.25.55.55v14.4c0 .3-.25.55-.55.55H7c-.3 0-.55-.25-.55-.55V4.8c0-.3.25-.55.55-.55Z"
        fill="url(#opencode-frame)"
        stroke="url(#opencode-frame-stroke)"
        strokeWidth="0.55"
      />
      <path
        d="M8.95 7.25h6.1c.22 0 .4.18.4.4v8.7c0 .22-.18.4-.4.4h-6.1a.4.4 0 0 1-.4-.4v-8.7c0-.22.18-.4.4-.4Z"
        fill="url(#opencode-core)"
        stroke="url(#opencode-core-stroke)"
        strokeWidth="0.45"
      />
      <path
        d="M9.25 7.6h5.5"
        stroke="#ffffff"
        strokeOpacity="0.18"
        strokeWidth="0.45"
        strokeLinecap="round"
      />
    </g>
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
  { id: 'codex', label: 'Codex', icon: OpenAIIcon, comingSoon: false },
  // { id: 'gemini', label: 'Gemini', icon: GoogleGeminiIcon, comingSoon: false },
  { id: 'gemini', label: 'Gemini', icon: GoogleGeminiIcon, comingSoon: false },
  { id: 'opencode', label: 'OpenCode', icon: OpenCodeIcon, comingSoon: false },
];

const OPENCODE_UI_DISABLED_REASON = 'OpenCode in development';

const ANTHROPIC_MODEL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus 4.6' },
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
] as const;

const CODEX_MODEL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
  { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
] as const;

const GEMINI_MODEL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
] as const;

const MODEL_LABEL_OVERRIDES: Record<string, string> = {
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-6[1m]': 'Sonnet 4.6 (1M)',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-6[1m]': 'Opus 4.6 (1M)',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.3-codex-spark': 'GPT-5.3 Spark',
  'gpt-5.2-codex': 'GPT-5.2 Codex',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.1-codex-mini': 'GPT-5.1 Mini',
  'gpt-5.1-codex-max': 'GPT-5.1 Max',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
};

export function getTeamModelLabel(model: string): string {
  return MODEL_LABEL_OVERRIDES[model] ?? model;
}

export function getTeamProviderLabel(providerId: 'anthropic' | 'codex' | 'gemini'): string {
  switch (providerId) {
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'anthropic':
    default:
      return 'Anthropic';
  }
}

export function getTeamEffortLabel(effort: string): string {
  const trimmed = effort.trim();
  if (!trimmed) return 'Default';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function formatTeamModelSummary(
  providerId: 'anthropic' | 'codex' | 'gemini',
  model: string,
  effort?: string
): string {
  const providerLabel = getTeamProviderLabel(providerId);
  const modelLabel = model.trim() ? getTeamModelLabel(model.trim()) : 'Default';
  const effortLabel = effort?.trim() ? getTeamEffortLabel(effort) : '';

  const normalizedProvider = providerLabel.trim().toLowerCase();
  const normalizedModel = modelLabel.trim().toLowerCase();
  const modelAlreadyCarriesProviderBrand =
    modelLabel !== 'Default' &&
    (normalizedModel.startsWith(normalizedProvider) ||
      (providerId === 'anthropic' && normalizedModel.startsWith('claude')) ||
      (providerId === 'codex' && normalizedModel.startsWith('codex')) ||
      (providerId === 'codex' && normalizedModel.startsWith('gpt')) ||
      (providerId === 'gemini' && normalizedModel.startsWith('gemini')));

  const providerActsAsBackendOnly =
    providerId !== 'anthropic' && modelLabel !== 'Default' && !modelAlreadyCarriesProviderBrand;

  const parts = modelAlreadyCarriesProviderBrand
    ? [modelLabel, effortLabel]
    : providerActsAsBackendOnly
      ? [modelLabel, `via ${providerLabel}`, effortLabel]
      : [providerLabel, modelLabel, effortLabel];

  return parts.filter(Boolean).join(' · ');
}

/**
 * Computes the effective model string for team provisioning.
 * By default adds [1m] suffix for 1M context (Opus/Sonnet).
 * When limitContext=true, returns base model without [1m] (200K context).
 * Haiku does not support 1M — always returned as-is.
 */
export function computeEffectiveTeamModel(
  selectedModel: string,
  limitContext: boolean,
  providerId: 'anthropic' | 'codex' | 'gemini' = 'anthropic'
): string | undefined {
  const base = selectedModel || undefined;
  if (providerId !== 'anthropic') return base;
  if (limitContext) return base;
  if (base === 'haiku') return base;
  return base ? `${base}[1m]` : 'opus[1m]';
}

export interface TeamModelSelectorProps {
  providerId: 'anthropic' | 'codex' | 'gemini';
  onProviderChange: (providerId: 'anthropic' | 'codex' | 'gemini') => void;
  value: string;
  onValueChange: (value: string) => void;
  id?: string;
  disableGeminiOption?: boolean;
}

export const TeamModelSelector: React.FC<TeamModelSelectorProps> = ({
  providerId,
  onProviderChange,
  value,
  onValueChange,
  id,
  disableGeminiOption = false,
}) => {
  const cliStatus = useStore((s) => s.cliStatus);
  const multimodelEnabled = useStore((s) => s.appConfig?.general?.multimodelEnabled ?? true);
  const multimodelAvailable = multimodelEnabled || cliStatus?.flavor === 'free-code';
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

  const effectiveProviderId =
    disableGeminiOption && isGeminiUiFrozen() && providerId === 'gemini' ? 'anthropic' : providerId;
  const activeProvider =
    PROVIDERS.find((provider) => provider.id === effectiveProviderId) ?? PROVIDERS[0];
  const ProviderIcon = activeProvider.icon;
  const defaultModelTooltip = useMemo(() => {
    if (effectiveProviderId === 'anthropic') {
      return 'Default model from Claude CLI (/model).\nUses the runtime default for the selected provider.';
    }
    return 'Uses the runtime default for the selected provider.';
  }, [effectiveProviderId]);
  const getProviderDisabledReason = (candidateProviderId: string): string | null => {
    if (candidateProviderId === 'opencode') {
      return OPENCODE_UI_DISABLED_REASON;
    }
    if (disableGeminiOption && isGeminiUiFrozen() && candidateProviderId === 'gemini') {
      return GEMINI_UI_DISABLED_REASON;
    }
    return null;
  };
  const isProviderTemporarilyDisabled = (candidateProviderId: string): boolean =>
    getProviderDisabledReason(candidateProviderId) !== null;
  const isProviderSelectable = (candidateProviderId: string): boolean =>
    !isProviderTemporarilyDisabled(candidateProviderId) &&
    (multimodelAvailable || candidateProviderId === 'anthropic');
  const activeProviderSelectable = isProviderSelectable(effectiveProviderId);
  const runtimeModels =
    cliStatus?.providers.find((provider) => provider.providerId === effectiveProviderId)?.models ??
    [];
  const normalizedValue = normalizeTeamModelForUi(effectiveProviderId, value);

  useEffect(() => {
    if (normalizedValue !== value) {
      onValueChange(normalizedValue);
    }
  }, [normalizedValue, onValueChange, value]);

  const modelOptions = useMemo(() => {
    const fallback =
      effectiveProviderId === 'codex'
        ? CODEX_MODEL_OPTIONS
        : effectiveProviderId === 'gemini'
          ? GEMINI_MODEL_OPTIONS
          : ANTHROPIC_MODEL_OPTIONS;
    if (effectiveProviderId === 'anthropic' || runtimeModels.length === 0) {
      return [...fallback];
    }
    const dynamicOptions = runtimeModels.map((model) => ({
      value: model,
      label: getTeamModelLabel(model),
    }));
    return [{ value: '', label: 'Default' }, ...dynamicOptions];
  }, [effectiveProviderId, runtimeModels]);

  return (
    <div className="mb-5">
      <Label htmlFor={id} className="label-optional mb-1.5 block">
        Model (optional)
      </Label>
      <div ref={containerRef} className="relative space-y-2">
        <div className="relative inline-flex">
          <button
            type="button"
            className={cn(
              'flex min-w-[170px] items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors',
              dropdownOpen
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
            )}
            style={{
              borderColor: 'var(--color-border)',
              backgroundColor: 'var(--color-surface)',
            }}
            onClick={() => setDropdownOpen(!dropdownOpen)}
          >
            <span className="flex items-center gap-2">
              <ProviderIcon className="size-3.5" />
              <span>{activeProvider.label}</span>
            </span>
            <ChevronDown
              className={cn(
                'size-3 transition-transform duration-200',
                dropdownOpen && 'rotate-180'
              )}
            />
          </button>

          {/* Provider dropdown */}
          {dropdownOpen && (
            <div
              className="absolute left-0 top-full z-50 mt-1 min-w-[220px] overflow-hidden rounded-md border py-1 shadow-xl shadow-black/20"
              style={{
                backgroundColor: 'var(--color-surface-raised)',
                borderColor: 'var(--color-border-subtle)',
              }}
            >
              {PROVIDERS.map((provider, index) => {
                const Icon = provider.icon;
                const isActive = provider.id === activeProvider.id;
                const isFirst = index === 0;
                const prevWasActive = index > 0 && !PROVIDERS[index - 1].comingSoon;
                const providerDisabledReason = getProviderDisabledReason(provider.id);

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
                      disabled={provider.comingSoon || !isProviderSelectable(provider.id)}
                      onClick={() => {
                        if (!provider.comingSoon && isProviderSelectable(provider.id)) {
                          onProviderChange(provider.id as 'anthropic' | 'codex' | 'gemini');
                          setDropdownOpen(false);
                        }
                      }}
                      className={cn(
                        'flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors duration-100',
                        isActive && 'bg-indigo-500/10 text-indigo-400',
                        (provider.comingSoon || !isProviderSelectable(provider.id)) &&
                          'cursor-not-allowed opacity-40',
                        !isActive &&
                          !provider.comingSoon &&
                          isProviderSelectable(provider.id) &&
                          'hover:bg-white/5'
                      )}
                      style={
                        !isActive && !provider.comingSoon && isProviderSelectable(provider.id)
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
                      {!provider.comingSoon && providerDisabledReason && (
                        <span
                          className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                          title={providerDisabledReason}
                        >
                          {GEMINI_UI_DISABLED_BADGE_LABEL}
                        </span>
                      )}
                      {!provider.comingSoon &&
                        !providerDisabledReason &&
                        !isProviderSelectable(provider.id) && (
                          <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                            Multimodel off
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
        {!multimodelAvailable && (
          <p className="text-[11px] text-[var(--color-text-muted)]">
            Codex and Gemini require Multimodel mode.
          </p>
        )}
        {disableGeminiOption && isGeminiUiFrozen() && (
          <p className="text-[11px] text-[var(--color-text-muted)]">{GEMINI_UI_DISABLED_REASON}.</p>
        )}

        <div
          className="grid gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
        >
          {modelOptions.map((opt) =>
            (() => {
              const modelDisabledReason = getTeamModelUiDisabledReason(
                effectiveProviderId,
                opt.value
              );
              const modelSelectable = activeProviderSelectable && !modelDisabledReason;

              return (
                <button
                  key={opt.value || '__default__'}
                  type="button"
                  id={opt.value === normalizedValue ? id : undefined}
                  aria-disabled={!modelSelectable}
                  className={cn(
                    'flex min-h-[44px] items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-center text-xs font-medium transition-colors',
                    normalizedValue === opt.value
                      ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
                    !modelSelectable && 'cursor-not-allowed opacity-45',
                    !modelDisabledReason && !activeProviderSelectable && 'pointer-events-none'
                  )}
                  style={{
                    borderColor:
                      normalizedValue === opt.value
                        ? 'var(--color-border-emphasis)'
                        : 'transparent',
                  }}
                  onClick={() => {
                    if (!modelSelectable) return;
                    onValueChange(opt.value);
                  }}
                >
                  <span className="flex flex-col items-center justify-center gap-0.5">
                    <span className="leading-tight">{opt.label}</span>
                    {opt.value === '' && (
                      <span className="flex items-center justify-center gap-1">
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger
                              asChild
                              onClick={(e: React.MouseEvent) => e.stopPropagation()}
                            >
                              <Info className="size-3 shrink-0 opacity-40 transition-opacity hover:opacity-70" />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[240px] text-xs">
                              {defaultModelTooltip.split('\n').map((line, index) => (
                                <React.Fragment key={line}>
                                  {index > 0 ? <br /> : null}
                                  {line}
                                </React.Fragment>
                              ))}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </span>
                    )}
                    {modelDisabledReason && (
                      <span
                        className="flex items-center justify-center gap-1 text-[10px] font-normal text-[var(--color-text-muted)]"
                        title={modelDisabledReason}
                      >
                        <span>{TEAM_MODEL_UI_DISABLED_BADGE_LABEL}</span>
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger
                              asChild
                              onClick={(e: React.MouseEvent) => e.stopPropagation()}
                            >
                              <Info className="size-3 shrink-0 opacity-40 transition-opacity hover:opacity-70" />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[240px] text-xs">
                              {modelDisabledReason}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </span>
                    )}
                  </span>
                </button>
              );
            })()
          )}
        </div>
      </div>
    </div>
  );
};
