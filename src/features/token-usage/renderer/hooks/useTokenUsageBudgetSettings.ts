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
      setBudgetConfig((current) => {
        const next = typeof action === 'function' ? action(current) : action;
        const saveVersion = ++saveVersionRef.current;
        const updateBudgetSettings = (api.tokenUsage as Partial<typeof api.tokenUsage>)
          .updateBudgetSettings;
        setBudgetConfigError(null);
        if (typeof updateBudgetSettings !== 'function') {
          setBudgetConfigError(saveErrorMessage);
          return next;
        }
        void updateBudgetSettings(next)
          .then((settings) => {
            if (saveVersion === saveVersionRef.current) {
              setBudgetConfig(settings);
            }
          })
          .catch((error: unknown) => {
            if (saveVersion === saveVersionRef.current) {
              setBudgetConfigError(error instanceof Error ? error.message : saveErrorMessage);
            }
          });
        return next;
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
