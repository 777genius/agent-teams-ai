/**
 * useSettingsConfig - Hook for managing settings configuration state.
 * Handles loading, saving, and providing safe defaults for config.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import type { AppConfig } from '@renderer/types/data';

// Get the setState function from the store to update appConfig globally
const setStoreState = useStore.setState;

interface PendingConfigUpdate {
  section: keyof AppConfig;
  data: Partial<AppConfig[keyof AppConfig]>;
}

function applyConfigUpdate(config: AppConfig, update: PendingConfigUpdate): AppConfig {
  return {
    ...config,
    [update.section]: { ...config[update.section], ...update.data },
  };
}

/** Repository item for ignored repositories list */
export interface RepositoryDropdownItem {
  id: string;
  name: string;
  path: string;
  worktreeCount: number;
  totalSessions: number;
}

export interface SafeConfig {
  general: {
    launchAtLogin: boolean;
    showDockIcon: boolean;
    theme: 'dark' | 'light' | 'system';
    defaultTab: 'dashboard' | 'last-session';
    multimodelEnabled: boolean;
    claudeRootPath: string | null;
    agentLanguage: string;
    appLocale: string;
    autoExpandAIGroups: boolean;
    useNativeTitleBar: boolean;
    telemetryEnabled: boolean;
    externalAgentCdpEnabled: boolean;
  };
  notifications: {
    enabled: boolean;
    soundEnabled: boolean;
    ignoredRegex: string[];
    ignoredRepositories: string[];
    snoozedUntil: number | null;
    snoozeMinutes: number;
    includeSubagentErrors: boolean;
    notifyOnLeadInbox: boolean;
    notifyOnUserInbox: boolean;
    notifyOnClarifications: boolean;
    notifyOnStatusChange: boolean;
    notifyOnTaskComments: boolean;
    notifyOnTaskCreated: boolean;
    notifyOnAllTasksCompleted: boolean;
    notifyOnCrossTeamMessage: boolean;
    notifyOnTeamLaunched: boolean;
    notifyOnToolApproval: boolean;
    notifyOnUsageBudgetAlerts: boolean;
    notifyOnUsageBudgetWarning: boolean;
    notifyOnUsageBudgetCritical: boolean;
    notifyOnUsageBudgetNativeToast: boolean;
    autoResumeOnRateLimit: boolean;
    statusChangeOnlySolo: boolean;
    statusChangeStatuses: string[];
    triggers: AppConfig['notifications']['triggers'];
  };
  teamRuntimeRecovery: {
    transientErrorsEnabled: boolean;
    rateLimitsEnabled: boolean;
    initialDelaySeconds: number;
    maxAttempts: number;
  };
  display: {
    showTimestamps: boolean;
    compactMode: boolean;
    syntaxHighlighting: boolean;
  };
}

interface UseSettingsConfigReturn {
  config: AppConfig | null;
  safeConfig: SafeConfig;
  loading: boolean;
  saving: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  setSaving: (saving: boolean) => void;
  setConfig: (config: AppConfig | null) => void;
  setOptimisticConfig: React.Dispatch<React.SetStateAction<AppConfig | null>>;
  updateConfig: (
    section: keyof AppConfig,
    data: Partial<AppConfig[keyof AppConfig]>
  ) => Promise<void>;
  ignoredRepositoryItems: RepositoryDropdownItem[];
  excludedRepositoryIds: string[];
  isSnoozed: boolean;
}

export function useSettingsConfig(): UseSettingsConfigReturn {
  const { repositoryGroups, fetchRepositoryGroups } = useStore(
    useShallow((s) => ({
      repositoryGroups: s.repositoryGroups,
      fetchRepositoryGroups: s.fetchRepositoryGroups,
    }))
  );

  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedConfigRef = useRef<AppConfig | null>(null);
  const pendingUpdatesRef = useRef<PendingConfigUpdate[]>([]);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Local optimistic state for immediate visual feedback on toggles
  const [optimisticConfig, setOptimisticConfig] = useState<AppConfig | null>(null);

  // Fetch config on mount
  useEffect(() => {
    const loadConfig = async (): Promise<void> => {
      try {
        setLoading(true);
        setError(null);
        const loadedConfig = await api.config.get();
        savedConfigRef.current = loadedConfig;
        setConfig(loadedConfig);
        setOptimisticConfig(loadedConfig);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load settings');
      } finally {
        setLoading(false);
      }
    };

    void loadConfig();
  }, []);

  // Other settings handlers can also replace the confirmed config.
  useEffect(() => {
    if (pendingUpdatesRef.current.length === 0) savedConfigRef.current = config;
  }, [config]);

  // Fetch repository groups for ignored repositories dropdown
  useEffect(() => {
    if (repositoryGroups.length === 0) {
      void fetchRepositoryGroups();
    }
  }, [repositoryGroups.length, fetchRepositoryGroups]);

  // Serialize saves; each preview is rebuilt from the last confirmed config and queued edits.
  const updateConfig = useCallback(
    (section: keyof AppConfig, data: Partial<AppConfig[keyof AppConfig]>): Promise<void> => {
      const pending = { section, data };
      pendingUpdatesRef.current.push(pending);
      setSaving(true);
      setError(null);
      setOptimisticConfig((prev) => (prev ? applyConfigUpdate(prev, pending) : prev));

      const operation = saveQueueRef.current.then(async () => {
        try {
          const updatedConfig = await api.config.update(section, data as object);
          savedConfigRef.current = updatedConfig;
          setConfig(updatedConfig);
          setStoreState({ appConfig: updatedConfig });
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to save settings');
          throw err;
        } finally {
          pendingUpdatesRef.current = pendingUpdatesRef.current.filter((item) => item !== pending);
          const lastSaved = savedConfigRef.current;
          setOptimisticConfig(
            lastSaved
              ? pendingUpdatesRef.current.reduce(applyConfigUpdate, lastSaved)
              : null
          );
          setSaving(pendingUpdatesRef.current.length > 0);
        }
      });
      // A failed save must not discard the later, already-queued user change.
      saveQueueRef.current = operation.catch(() => undefined);
      return operation;
    },
    []
  );

  // Use optimistic config for UI display (falls back to config if not set)
  const displayConfig = optimisticConfig ?? config;

  // Create safe config with defaults to prevent null reference errors
  const safeConfig = useMemo(
    (): SafeConfig => ({
      general: {
        launchAtLogin: displayConfig?.general?.launchAtLogin ?? false,
        showDockIcon: displayConfig?.general?.showDockIcon ?? true,
        theme: displayConfig?.general?.theme ?? 'dark',
        defaultTab: displayConfig?.general?.defaultTab ?? 'dashboard',
        multimodelEnabled: displayConfig?.general?.multimodelEnabled ?? true,
        claudeRootPath: displayConfig?.general?.claudeRootPath ?? null,
        agentLanguage: displayConfig?.general?.agentLanguage ?? 'system',
        appLocale: displayConfig?.general?.appLocale ?? 'system',
        autoExpandAIGroups: displayConfig?.general?.autoExpandAIGroups ?? false,
        useNativeTitleBar: displayConfig?.general?.useNativeTitleBar ?? false,
        telemetryEnabled: displayConfig?.general?.telemetryEnabled ?? true,
        externalAgentCdpEnabled: displayConfig?.general?.externalAgentCdpEnabled ?? false,
      },
      notifications: {
        enabled: displayConfig?.notifications?.enabled ?? true,
        soundEnabled: displayConfig?.notifications?.soundEnabled ?? true,
        ignoredRegex: displayConfig?.notifications?.ignoredRegex ?? [],
        ignoredRepositories: displayConfig?.notifications?.ignoredRepositories ?? [],
        snoozedUntil: displayConfig?.notifications?.snoozedUntil ?? null,
        snoozeMinutes: displayConfig?.notifications?.snoozeMinutes ?? 30,
        includeSubagentErrors: displayConfig?.notifications?.includeSubagentErrors ?? false,
        notifyOnLeadInbox: displayConfig?.notifications?.notifyOnLeadInbox ?? false,
        notifyOnUserInbox: displayConfig?.notifications?.notifyOnUserInbox ?? true,
        notifyOnClarifications: displayConfig?.notifications?.notifyOnClarifications ?? true,
        notifyOnStatusChange: displayConfig?.notifications?.notifyOnStatusChange ?? true,
        notifyOnTaskComments: displayConfig?.notifications?.notifyOnTaskComments ?? true,
        notifyOnTaskCreated: displayConfig?.notifications?.notifyOnTaskCreated ?? true,
        notifyOnAllTasksCompleted: displayConfig?.notifications?.notifyOnAllTasksCompleted ?? true,
        notifyOnCrossTeamMessage: displayConfig?.notifications?.notifyOnCrossTeamMessage ?? true,
        notifyOnTeamLaunched: displayConfig?.notifications?.notifyOnTeamLaunched ?? true,
        notifyOnToolApproval: displayConfig?.notifications?.notifyOnToolApproval ?? true,
        notifyOnUsageBudgetAlerts: displayConfig?.notifications?.notifyOnUsageBudgetAlerts ?? true,
        notifyOnUsageBudgetWarning:
          displayConfig?.notifications?.notifyOnUsageBudgetWarning ?? true,
        notifyOnUsageBudgetCritical:
          displayConfig?.notifications?.notifyOnUsageBudgetCritical ?? true,
        notifyOnUsageBudgetNativeToast:
          displayConfig?.notifications?.notifyOnUsageBudgetNativeToast ?? true,
        autoResumeOnRateLimit: displayConfig?.notifications?.autoResumeOnRateLimit ?? false,
        statusChangeOnlySolo: displayConfig?.notifications?.statusChangeOnlySolo ?? true,
        statusChangeStatuses: displayConfig?.notifications?.statusChangeStatuses ?? [
          'in_progress',
          'completed',
        ],
        triggers: displayConfig?.notifications?.triggers ?? [],
      },
      teamRuntimeRecovery: {
        transientErrorsEnabled: displayConfig?.teamRuntimeRecovery?.transientErrorsEnabled ?? false,
        rateLimitsEnabled:
          displayConfig?.teamRuntimeRecovery?.rateLimitsEnabled ??
          displayConfig?.notifications?.autoResumeOnRateLimit ??
          false,
        initialDelaySeconds: displayConfig?.teamRuntimeRecovery?.initialDelaySeconds ?? 60,
        maxAttempts: displayConfig?.teamRuntimeRecovery?.maxAttempts ?? 2,
      },
      display: {
        showTimestamps: displayConfig?.display?.showTimestamps ?? true,
        compactMode: displayConfig?.display?.compactMode ?? false,
        syntaxHighlighting: displayConfig?.display?.syntaxHighlighting ?? true,
      },
    }),
    [displayConfig]
  );

  // Convert ignored repository IDs to RepositoryDropdownItem[] for display
  const ignoredRepositoryItems = useMemo((): RepositoryDropdownItem[] => {
    const items: RepositoryDropdownItem[] = [];
    const ignoredRepositories = safeConfig.notifications.ignoredRepositories;

    for (const repositoryId of ignoredRepositories) {
      // Find repository group by ID
      const group = repositoryGroups.find((g) => g.id === repositoryId);
      if (group) {
        items.push({
          id: group.id,
          name: group.name,
          path: group.worktrees[0]?.path ?? '',
          worktreeCount: group.worktrees.length,
          totalSessions: group.totalSessions,
        });
      } else {
        // If not found, create a placeholder item
        items.push({
          id: repositoryId,
          name: repositoryId,
          path: '',
          worktreeCount: 0,
          totalSessions: 0,
        });
      }
    }

    return items;
  }, [safeConfig.notifications.ignoredRepositories, repositoryGroups]);

  // Get excluded repository IDs for dropdown
  const excludedRepositoryIds = safeConfig.notifications.ignoredRepositories;

  // Check if snoozed
  const isSnoozed =
    safeConfig.notifications.snoozedUntil !== null &&
    safeConfig.notifications.snoozedUntil > Date.now();

  return {
    config,
    safeConfig,
    loading,
    saving,
    error,
    setError,
    setSaving,
    setConfig,
    setOptimisticConfig,
    updateConfig,
    ignoredRepositoryItems,
    excludedRepositoryIds,
    isSnoozed,
  };
}
