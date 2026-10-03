import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type {
  TokenUsageBudgetSettingsDto,
  TokenUsageBudgetSettingsUpdateRequestDto,
  TokenUsageBudgetStatusDto,
} from '../../contracts';

export function useTokenUsageBudgetSettings({
  loadErrorMessage,
  saveErrorMessage,
}: {
  loadErrorMessage: string;
  saveErrorMessage: string;
}) {
  const [budgetConfig, setBudgetConfig] = useState<TokenUsageBudgetSettingsDto>({});
  const [budgetStatus, setBudgetStatus] = useState<TokenUsageBudgetStatusDto | null>(null);
  const [budgetConfigError, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const saved = useRef<TokenUsageBudgetSettingsDto>({});
  const statusRef = useRef<TokenUsageBudgetStatusDto | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);

  const acceptStatus = useCallback((status: TokenUsageBudgetStatusDto) => {
    if (!alive.current) return;
    const revision = saved.current.updatedAt;
    if (revision && (!status.settingsUpdatedAt || status.settingsUpdatedAt < revision)) return;
    if (statusRef.current && status.computedAt < statusRef.current.computedAt) return;
    statusRef.current = status;
    setBudgetStatus(status);
  }, []);

  const reloadBudgetConfig = useCallback(async () => {
    const version = ++generation.current;
    try {
      const [settings, status] = await Promise.all([
        api.tokenUsage.getBudgetSettings(),
        api.tokenUsage.getBudgetStatus(),
      ]);
      if (!alive.current || version !== generation.current) return null;
      saved.current = settings;
      setBudgetConfig(settings);
      setLoaded(true);
      acceptStatus(status);
      setError(null);
      return settings;
    } catch (error) {
      if (alive.current && version === generation.current)
        setError(error instanceof Error ? error.message : loadErrorMessage);
      return null;
    }
  }, [acceptStatus, loadErrorMessage]);

  useEffect(() => {
    const aliveRef = alive;
    const generationRef = generation;
    aliveRef.current = true;
    void reloadBudgetConfig();
    const unsubscribe = api.tokenUsage.onBudgetStatusChanged(acceptStatus);
    return () => {
      aliveRef.current = false;
      generationRef.current++;
      unsubscribe();
    };
  }, [acceptStatus, reloadBudgetConfig]);

  const saveBudgetConfig = useCallback(
    async (request: TokenUsageBudgetSettingsUpdateRequestDto): Promise<void> => {
      const version = ++generation.current;
      try {
        const result = await api.tokenUsage.updateBudgetSettings(request);
        if (!alive.current || version !== generation.current) return;
        saved.current = result;
        setBudgetConfig(result);
        setLoaded(true);
        setError(null);
        try {
          const status = await api.tokenUsage.getBudgetStatus();
          if (alive.current && version === generation.current) acceptStatus(status);
        } catch (error) {
          if (alive.current && version === generation.current)
            setError(error instanceof Error ? error.message : loadErrorMessage);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : saveErrorMessage;
        if (alive.current && version === generation.current) setError(message);
        throw error;
      }
    },
    [acceptStatus, loadErrorMessage, saveErrorMessage]
  );

  return {
    budgetConfig,
    budgetStatus,
    budgetConfigError,
    loaded,
    saveBudgetConfig,
    reloadBudgetConfig,
  };
}
