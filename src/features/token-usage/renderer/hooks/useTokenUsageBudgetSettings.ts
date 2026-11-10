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
  const statusOrder = useRef<TokenUsageBudgetStatusDto['statusOrder']>(undefined);
  const retiredStatusEpochs = useRef(new Set<string>());
  const statusEventEpoch = useRef(0);
  const generation = useRef(0);
  const alive = useRef(true);

  const acceptStatus = useCallback((status: TokenUsageBudgetStatusDto) => {
    if (!alive.current) return false;
    const revision = saved.current.updatedAt;
    if (revision && (!status.settingsUpdatedAt || status.settingsUpdatedAt < revision))
      return false;
    const order = status.statusOrder;
    const acceptedOrder = statusOrder.current;
    if (!order && acceptedOrder) return false;
    if (order) {
      if (retiredStatusEpochs.current.has(order.epoch)) return false;
      if (acceptedOrder) {
        if (order.epoch === acceptedOrder.epoch && order.sequence <= acceptedOrder.sequence)
          return false;
        if (order.epoch !== acceptedOrder.epoch)
          retiredStatusEpochs.current.add(acceptedOrder.epoch);
      }
      statusOrder.current = order;
    }
    setBudgetStatus(status);
    return true;
  }, []);

  const acceptStatusEvent = useCallback(
    (status: TokenUsageBudgetStatusDto) => {
      // Fence legacy reads too; wall-clock timestamps may move backwards.
      if (acceptStatus(status)) statusEventEpoch.current++;
    },
    [acceptStatus]
  );

  const acceptStatusRead = useCallback(
    (status: TokenUsageBudgetStatusDto, eventEpoch: number) => {
      // Same-instance sequence order resolves GET/event races in either direction.
      if (
        eventEpoch !== statusEventEpoch.current &&
        (!status.statusOrder || status.statusOrder.epoch !== statusOrder.current?.epoch)
      )
        return;
      acceptStatus(status);
    },
    [acceptStatus]
  );

  const reloadBudgetConfig = useCallback(async () => {
    const version = ++generation.current;
    const eventEpoch = statusEventEpoch.current;
    try {
      const [settings, status] = await Promise.all([
        api.tokenUsage.getBudgetSettings(),
        api.tokenUsage.getBudgetStatus(),
      ]);
      if (!alive.current || version !== generation.current) return null;
      saved.current = settings;
      setBudgetConfig(settings);
      setLoaded(true);
      acceptStatusRead(status, eventEpoch);
      setError(null);
      return settings;
    } catch (error) {
      if (alive.current && version === generation.current)
        setError(error instanceof Error ? error.message : loadErrorMessage);
      return null;
    }
  }, [acceptStatusRead, loadErrorMessage]);

  useEffect(() => {
    const aliveRef = alive;
    const generationRef = generation;
    aliveRef.current = true;
    void reloadBudgetConfig();
    const unsubscribe = api.tokenUsage.onBudgetStatusChanged(acceptStatusEvent);
    return () => {
      aliveRef.current = false;
      generationRef.current++;
      unsubscribe();
    };
  }, [acceptStatusEvent, reloadBudgetConfig]);

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
          const eventEpoch = statusEventEpoch.current;
          const status = await api.tokenUsage.getBudgetStatus();
          if (alive.current && version === generation.current) acceptStatusRead(status, eventEpoch);
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
    [acceptStatusRead, loadErrorMessage, saveErrorMessage]
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
