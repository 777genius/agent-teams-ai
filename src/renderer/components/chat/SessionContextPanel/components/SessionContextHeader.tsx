/**
 * SessionContextHeader - Header component with title, help tooltip, and token stats.
 */

import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  COLOR_BORDER,
  COLOR_BORDER_SUBTLE,
  COLOR_SURFACE_OVERLAY,
  COLOR_TEXT,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SECONDARY,
} from '@renderer/constants/cssVariables';
import { formatCostUsd } from '@shared/utils/costFormatting';
import { ArrowDownWideNarrow, FileText, LayoutList, X } from 'lucide-react';

import { formatTokens } from '../utils/formatting';

import { SessionContextHelpTooltip } from './SessionContextHelpTooltip';

import type { ContextViewMode } from '../types';
import type { ContextPhaseInfo } from '@renderer/types/contextInjection';
import type { SessionMetrics } from '@shared/types';
import type { DerivedContextMetrics } from '@shared/utils/contextMetrics';

interface SessionContextHeaderProps {
  injectionCount: number;
  totalTokens: number;
  contextMetrics?: DerivedContextMetrics;
  sessionMetrics?: SessionMetrics;
  subagentCostUsd?: number;
  onClose?: () => void;
  onViewReport?: () => void;
  phaseInfo?: ContextPhaseInfo;
  selectedPhase: number | null;
  onPhaseChange: (phase: number | null) => void;
  viewMode: ContextViewMode;
  onViewModeChange: (mode: ContextViewMode) => void;
}

export const SessionContextHeader = ({
  injectionCount,
  totalTokens,
  contextMetrics,
  sessionMetrics,
  subagentCostUsd,
  onClose,
  onViewReport,
  phaseInfo,
  selectedPhase,
  onPhaseChange,
  viewMode,
  onViewModeChange,
}: Readonly<SessionContextHeaderProps>): React.ReactElement => {
  const { t } = useAppTranslation('common');

  const formatPercentLabel = (percent: number | null, suffix: string): string | null => {
    if (percent === null) {
      return null;
    }
    return `${percent.toFixed(1)}% ${suffix}`;
  };

  const renderMetricValue = (
    label: string,
    tokens: number | null,
    percentLabel: string | null,
    options?: {
      approximate?: boolean;
      unavailableLabel?: string;
    }
  ): React.ReactElement => (
    <div
      className="flex items-center justify-between gap-3 rounded px-2 py-1.5"
      style={{ backgroundColor: COLOR_SURFACE_OVERLAY }}
    >
      <span style={{ color: COLOR_TEXT_MUTED }}>{label}</span>
      <div className="text-right">
        <div className="font-medium tabular-nums" style={{ color: COLOR_TEXT_SECONDARY }}>
          {tokens === null
            ? (options?.unavailableLabel ?? t('sessionContext.metrics.unavailable'))
            : `${options?.approximate ? '~' : ''}${formatTokens(tokens)}`}
        </div>
        {percentLabel && (
          <div className="text-[10px] tabular-nums" style={{ color: COLOR_TEXT_MUTED }}>
            {percentLabel}
          </div>
        )}
      </div>
    </div>
  );

  const codexTelemetryUnavailable =
    contextMetrics?.providerId === 'codex' && contextMetrics.promptInputSource === 'unavailable';

  return (
    <div className="shrink-0 px-4 py-3" style={{ borderBottom: `1px solid ${COLOR_BORDER}` }}>
      {/* Title row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText size={16} style={{ color: COLOR_TEXT_SECONDARY }} />
          <h2 className="text-sm font-semibold" style={{ color: COLOR_TEXT }}>
            {t('sessionContext.header.title')}
          </h2>
          <span
            className="rounded px-1.5 py-0.5 text-xs"
            style={{
              backgroundColor: COLOR_SURFACE_OVERLAY,
              color: COLOR_TEXT_SECONDARY,
            }}
          >
            {injectionCount}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <SessionContextHelpTooltip />
          {onClose && (
            <button
              onClick={onClose}
              className="rounded p-1 transition-colors hover:bg-white/10"
              style={{ color: COLOR_TEXT_SECONDARY }}
              aria-label={t('sessionContext.header.closePanel')}
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Primary metrics */}
      <div
        className="mt-2 space-y-1.5 pt-2 text-xs"
        style={{ borderTop: `1px solid ${COLOR_BORDER_SUBTLE}` }}
      >
        {renderMetricValue(
          t('sessionContext.metrics.contextUsed'),
          contextMetrics?.contextUsedTokens ?? null,
          formatPercentLabel(
            contextMetrics?.contextUsedPercentOfContextWindow ?? null,
            t('sessionContext.metrics.ofContext')
          )
        )}
        {renderMetricValue(
          t('sessionContext.metrics.promptInput'),
          contextMetrics?.promptInputTokens ?? null,
          formatPercentLabel(
            contextMetrics?.promptInputPercentOfContextWindow ?? null,
            t('sessionContext.metrics.ofContext')
          )
        )}
        {renderMetricValue(
          t('sessionContext.metrics.visibleContext'),
          totalTokens,
          formatPercentLabel(
            contextMetrics?.visibleContextPercentOfPromptInput ?? null,
            t('sessionContext.metrics.ofPrompt')
          ),
          { approximate: true }
        )}
      </div>

      {codexTelemetryUnavailable && (
        <div
          className="mt-2 rounded px-2 py-1.5 text-[10px]"
          style={{
            border: `1px solid ${COLOR_BORDER_SUBTLE}`,
            color: COLOR_TEXT_MUTED,
          }}
        >
          {t('sessionContext.metrics.codexTelemetryUnavailable')}
        </div>
      )}

      {/* Session Metrics Breakdown */}
      {sessionMetrics && (
        <div
          className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 pt-2 text-[10px]"
          style={{ borderTop: `1px solid ${COLOR_BORDER_SUBTLE}` }}
        >
          {/* Cost */}
          {sessionMetrics.costUsd !== undefined && sessionMetrics.costUsd > 0 && (
            <div className="col-span-2">
              <span style={{ color: COLOR_TEXT_MUTED }}>
                {t('sessionContext.metrics.sessionCost')}{' '}
              </span>
              <span className="font-medium tabular-nums" style={{ color: COLOR_TEXT_SECONDARY }}>
                {formatCostUsd(sessionMetrics.costUsd + (subagentCostUsd ?? 0))}
              </span>
              {subagentCostUsd !== undefined && subagentCostUsd > 0 && (
                <span style={{ color: COLOR_TEXT_MUTED }}>
                  {' ('}
                  {formatCostUsd(sessionMetrics.costUsd)}
                  {` ${t('sessionContext.metrics.parentPlus')} `}
                  {formatCostUsd(subagentCostUsd)}
                  {` ${t('sessionContext.metrics.subagents')}`}
                  {onViewReport && (
                    <>
                      {' · '}
                      <button
                        onClick={onViewReport}
                        className="underline"
                        style={{ color: COLOR_TEXT_SECONDARY }}
                      >
                        {t('sessionContext.metrics.details')}
                      </button>
                    </>
                  )}
                  {')'}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Phase selector - only shown when compactions exist */}
      {phaseInfo && phaseInfo.phases.length > 1 && (
        <div
          className="mt-2 flex flex-wrap items-center gap-1 pt-2"
          style={{ borderTop: `1px solid ${COLOR_BORDER_SUBTLE}` }}
        >
          <span className="mr-1 text-[10px]" style={{ color: COLOR_TEXT_MUTED }}>
            {t('sessionContext.header.phase')}
          </span>
          {phaseInfo.phases.map((phase) => (
            <button
              key={phase.phaseNumber}
              onClick={() =>
                onPhaseChange(phase.phaseNumber === selectedPhase ? null : phase.phaseNumber)
              }
              className="rounded px-1.5 py-0.5 text-[10px] transition-colors"
              style={{
                backgroundColor:
                  selectedPhase === phase.phaseNumber
                    ? 'rgba(99, 102, 241, 0.2)'
                    : COLOR_SURFACE_OVERLAY,
                color: selectedPhase === phase.phaseNumber ? '#818cf8' : COLOR_TEXT_MUTED,
              }}
            >
              {phase.phaseNumber}
            </button>
          ))}
          <button
            onClick={() => onPhaseChange(null)}
            className="rounded px-1.5 py-0.5 text-[10px] transition-colors"
            style={{
              backgroundColor:
                selectedPhase === null ? 'rgba(99, 102, 241, 0.2)' : COLOR_SURFACE_OVERLAY,
              color: selectedPhase === null ? '#818cf8' : COLOR_TEXT_MUTED,
            }}
          >
            {t('sessionContext.header.current')}
          </button>
        </div>
      )}

      {/* View mode toggle */}
      <div
        className="mt-2 flex items-center gap-1 pt-2"
        style={{ borderTop: `1px solid ${COLOR_BORDER_SUBTLE}` }}
      >
        <span className="mr-1 text-[10px]" style={{ color: COLOR_TEXT_MUTED }}>
          {t('sessionContext.header.view')}
        </span>
        <button
          onClick={() => onViewModeChange('category')}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors"
          style={{
            backgroundColor:
              viewMode === 'category' ? 'rgba(99, 102, 241, 0.2)' : COLOR_SURFACE_OVERLAY,
            color: viewMode === 'category' ? '#818cf8' : COLOR_TEXT_MUTED,
          }}
        >
          <LayoutList size={10} />
          {t('sessionContext.header.category')}
        </button>
        <button
          onClick={() => onViewModeChange('ranked')}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors"
          style={{
            backgroundColor:
              viewMode === 'ranked' ? 'rgba(99, 102, 241, 0.2)' : COLOR_SURFACE_OVERLAY,
            color: viewMode === 'ranked' ? '#818cf8' : COLOR_TEXT_MUTED,
          }}
        >
          <ArrowDownWideNarrow size={10} />
          {t('sessionContext.header.bySize')}
        </button>
      </div>
    </div>
  );
};
