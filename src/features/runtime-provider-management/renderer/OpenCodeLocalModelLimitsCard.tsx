import React, { useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { CheckCircle2, DatabaseZap, Loader2, TriangleAlert } from 'lucide-react';

import {
  invalidateOpenCodeProjectModels,
  loadOpenCodeProjectModels,
  resolveOpenCodeLocalModelLimitSuggestion,
  resolveOpenCodeLocalProviderId,
} from './openCodeLocalModelLimits';

import type { OpenCodeLocalModelLimitSuggestion } from './openCodeLocalModelLimits';

function parseTokenInput(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 100_000_000 ? parsed : null;
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export interface OpenCodeLocalModelLimitsCardProps {
  model: string;
  projectPath?: string | null;
}

export const OpenCodeLocalModelLimitsCard = ({
  model,
  projectPath,
}: OpenCodeLocalModelLimitsCardProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const normalizedModel = model.trim();
  const normalizedProjectPath = projectPath?.trim() || '';
  const providerId = useMemo(
    () => resolveOpenCodeLocalProviderId(normalizedModel),
    [normalizedModel]
  );
  const selectionKey = `${normalizedProjectPath}\u0000${normalizedModel}`;
  const currentSelectionKeyRef = useRef(selectionKey);
  currentSelectionKeyRef.current = selectionKey;
  const loadSequenceRef = useRef(0);
  const submitSequenceRef = useRef(0);
  const [suggestion, setSuggestion] = useState<OpenCodeLocalModelLimitSuggestion | null>(null);
  const [contextValue, setContextValue] = useState('');
  const [outputValue, setOutputValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const sequence = ++loadSequenceRef.current;
    let cancelled = false;
    submitSequenceRef.current += 1;
    setSaving(false);
    setSuggestion(null);
    setSuccessMessage(null);
    setErrorMessage(null);
    if (!normalizedProjectPath || !normalizedModel || !providerId) return;

    void loadOpenCodeProjectModels({
      projectPath: normalizedProjectPath,
      providerId,
      modelId: normalizedModel,
    })
      .then((response) => {
        if (
          cancelled ||
          loadSequenceRef.current !== sequence ||
          currentSelectionKeyRef.current !== selectionKey
        ) {
          return;
        }
        setSuggestion(
          resolveOpenCodeLocalModelLimitSuggestion(response.models?.models, normalizedModel)
        );
      })
      .catch(() => {
        if (!cancelled && loadSequenceRef.current === sequence) setSuggestion(null);
      });
    return () => {
      cancelled = true;
    };
  }, [normalizedModel, normalizedProjectPath, providerId, selectionKey]);

  useEffect(() => {
    setContextValue(suggestion?.contextTokens ? String(suggestion.contextTokens) : '');
    setOutputValue(suggestion?.outputTokens ? String(suggestion.outputTokens) : '');
    setSuccessMessage(null);
    setErrorMessage(null);
  }, [suggestion?.contextTokens, suggestion?.modelId, suggestion?.outputTokens]);

  if (!suggestion) {
    return null;
  }

  const contextTokens = parseTokenInput(contextValue);
  const outputTokens = parseTokenInput(outputValue);
  const valuesValid =
    contextTokens !== null && outputTokens !== null && outputTokens <= contextTokens;
  const hasDetectedLimits = suggestion.contextTokens !== null && suggestion.outputTokens !== null;
  const hasProject = Boolean(projectPath?.trim());

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!valuesValid || !contextTokens || !outputTokens || !hasProject || saving) {
      setErrorMessage(
        !hasProject
          ? t('openCodeLocalModelLimits.projectRequired')
          : t('openCodeLocalModelLimits.invalidLimits')
      );
      return;
    }

    setSaving(true);
    const submitSequence = ++submitSequenceRef.current;
    const submittedSelectionKey = selectionKey;
    setSuccessMessage(null);
    setErrorMessage(null);
    try {
      const response = await api.runtimeProviderManagement.configureModelLimits({
        runtimeId: 'opencode',
        providerId: suggestion.providerId,
        modelId: suggestion.modelId,
        contextTokens,
        outputTokens,
        projectPath: normalizedProjectPath,
      });
      if (
        submitSequenceRef.current !== submitSequence ||
        currentSelectionKeyRef.current !== submittedSelectionKey
      ) {
        return;
      }
      if (response.error) {
        setErrorMessage(response.error.message);
        return;
      }
      if (!response.result) {
        setErrorMessage(t('openCodeLocalModelLimits.unknownError'));
        return;
      }
      if (response.result.verified && response.result.saved) {
        setSuggestion((current) =>
          current
            ? {
                ...current,
                contextTokens: response.result!.contextTokens,
                outputTokens: response.result!.outputTokens,
                managed: true,
              }
            : current
        );
        setSuccessMessage(t('openCodeLocalModelLimits.verified'));
        invalidateOpenCodeProjectModels(normalizedProjectPath, suggestion.providerId);
      } else {
        setErrorMessage(response.result.message);
      }
    } catch (error) {
      if (
        submitSequenceRef.current !== submitSequence ||
        currentSelectionKeyRef.current !== submittedSelectionKey
      ) {
        return;
      }
      setErrorMessage(
        error instanceof Error ? error.message : t('openCodeLocalModelLimits.unknownError')
      );
    } finally {
      if (
        submitSequenceRef.current === submitSequence &&
        currentSelectionKeyRef.current === submittedSelectionKey
      ) {
        setSaving(false);
      }
    }
  };

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      data-testid="opencode-local-model-limits-card"
      className="rounded-md border border-cyan-500/20 bg-cyan-500/5 px-3 py-2.5 text-[11px] text-cyan-50"
    >
      <div className="flex items-start gap-2.5">
        <DatabaseZap className="mt-0.5 size-4 shrink-0 text-cyan-300" />
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="space-y-0.5">
            <p className="font-medium text-cyan-50">{t('openCodeLocalModelLimits.title')}</p>
            <p className="text-cyan-100/75">
              {suggestion.managed
                ? t('openCodeLocalModelLimits.saved', {
                    contextTokens: formatTokenCount(suggestion.contextTokens!),
                    outputTokens: formatTokenCount(suggestion.outputTokens!),
                  })
                : hasDetectedLimits
                  ? t('openCodeLocalModelLimits.detected', {
                      contextTokens: formatTokenCount(suggestion.contextTokens!),
                      outputTokens: formatTokenCount(suggestion.outputTokens!),
                    })
                  : t('openCodeLocalModelLimits.manualRequired')}
            </p>
            <p className="text-cyan-100/55">{t('openCodeLocalModelLimits.managedOnly')}</p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="block text-cyan-100/80">
                {t('openCodeLocalModelLimits.contextWindow')}
              </span>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={100_000_000}
                step={1}
                value={contextValue}
                onChange={(event) => {
                  setContextValue(event.target.value);
                  setSuccessMessage(null);
                  setErrorMessage(null);
                }}
                placeholder="128000"
                className="h-8 bg-[var(--color-surface)] text-xs"
                disabled={saving}
              />
            </label>
            <label className="space-y-1">
              <span className="block text-cyan-100/80">
                {t('openCodeLocalModelLimits.maxOutput')}
              </span>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={100_000_000}
                step={1}
                value={outputValue}
                onChange={(event) => {
                  setOutputValue(event.target.value);
                  setSuccessMessage(null);
                  setErrorMessage(null);
                }}
                placeholder="32768"
                className="h-8 bg-[var(--color-surface)] text-xs"
                disabled={saving}
              />
            </label>
          </div>

          {successMessage ? (
            <p className="flex items-center gap-1.5 text-emerald-300">
              <CheckCircle2 className="size-3.5 shrink-0" />
              {successMessage}
            </p>
          ) : null}
          {errorMessage ? (
            <p className="flex items-start gap-1.5 text-amber-200">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              <span>{errorMessage}</span>
            </p>
          ) : null}

          <Button
            type="submit"
            size="sm"
            variant="secondary"
            className="h-8"
            disabled={saving || !valuesValid || !hasProject}
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {saving
              ? t('openCodeLocalModelLimits.applying')
              : t('openCodeLocalModelLimits.applyAndVerify')}
          </Button>
        </div>
      </div>
    </form>
  );
};
