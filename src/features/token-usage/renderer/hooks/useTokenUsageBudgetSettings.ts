import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type { TokenUsageBudgetLimits } from '../adapters/tokenUsageViewModel';
import type React from 'react';

export interface UseTokenUsageBudgetSettingsOptions {
  loadErrorMessage: string;
  saveErrorMessage: string;
}

export interface UseTokenUsageBudgetSettingsResult {
  budgetConfig: TokenUsageBudgetLimits;
  budgetConfigError: string | null;
  updateBudgetConfig: React.Dispatch<React.SetStateAction<TokenUsageBudgetLimits>>;
}

export function useTokenUsageBudgetSettings({
  loadErrorMessage,
  saveErrorMessage,
}: UseTokenUsageBudgetSettingsOptions): UseTokenUsageBudgetSettingsResult {
  const [budgetConfig, setBudgetConfig] = useState<TokenUsageBudgetLimits>({});
  const [budgetConfigError, setBudgetConfigError] = useState<string | null>(null);
  const budgetConfigRef = useRef<TokenUsageBudgetLimits>({});
  const saveVersionRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const getBudgetSettings = (api.tokenUsage as Partial<typeof api.tokenUsage>).getBudgetSettings;
    if (typeof getBudgetSettings !== 'function') {
      setBudgetConfigError(loadErrorMessage);
      return () => {
        cancelled = true;
      };
    }
    void getBudgetSettings()
      .then((settings) => {
        if (cancelled) return;
        budgetConfigRef.current = settings;
        setBudgetConfig(settings);
        setBudgetConfigError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setBudgetConfigError(error instanceof Error ? error.message : loadErrorMessage);
      });
    return () => {
      cancelled = true;
    };
  }, [loadErrorMessage]);

  const updateBudgetConfig = useCallback(
    (action: React.SetStateAction<TokenUsageBudgetLimits>) => {
      const next = typeof action === 'function' ? action(budgetConfigRef.current) : action;
      budgetConfigRef.current = next;
      setBudgetConfig(next);

      const saveVersion = ++saveVersionRef.current;
      const updateBudgetSettings = (api.tokenUsage as Partial<typeof api.tokenUsage>)
        .updateBudgetSettings;
      setBudgetConfigError(null);
      if (typeof updateBudgetSettings !== 'function') {
        setBudgetConfigError(saveErrorMessage);
        return;
      }
      void updateBudgetSettings(next)
        .then((settings) => {
          if (saveVersion === saveVersionRef.current) {
            budgetConfigRef.current = settings;
            setBudgetConfig(settings);
          }
        })
        .catch((error: unknown) => {
          if (saveVersion === saveVersionRef.current) {
            setBudgetConfigError(error instanceof Error ? error.message : saveErrorMessage);
          }
        });
    },
    [saveErrorMessage]
  );

  return {
    budgetConfig,
    budgetConfigError,
    updateBudgetConfig,
  };
}
