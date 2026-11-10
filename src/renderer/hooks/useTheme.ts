import { useEffect, useSyncExternalStore } from 'react';

import { useShallow } from 'zustand/react/shallow';

import { useStore } from '../store';

type Theme = 'dark' | 'light' | 'system';
type ResolvedTheme = 'dark' | 'light';

const THEME_CACHE_KEY = 'agent-teams-theme-cache';
const LEGACY_THEME_CACHE_KEY = 'claude-devtools-theme-cache';

function parseCachedTheme(value: string | null): ResolvedTheme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

function readSystemResolvedTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function readCachedResolvedTheme(storage: Storage = localStorage): ResolvedTheme | null {
  try {
    return (
      parseCachedTheme(storage.getItem(THEME_CACHE_KEY)) ??
      parseCachedTheme(storage.getItem(LEGACY_THEME_CACHE_KEY))
    );
  } catch {
    return null;
  }
}

export function writeCachedResolvedTheme(
  resolvedTheme: ResolvedTheme,
  storage: Storage = localStorage
): void {
  try {
    storage.setItem(THEME_CACHE_KEY, resolvedTheme);
  } catch {
    // localStorage may not be available
  }
}

let systemThemeSnapshot: ResolvedTheme | null = null;
let systemThemeQuery: MediaQueryList | null = null;
const systemThemeListeners = new Set<() => void>();

function selectConfiguredTheme(state: {
  appConfig: { general?: { theme?: Theme } } | null;
}): Theme {
  return state.appConfig?.general?.theme ?? 'system';
}

function getSystemThemeSnapshot(): ResolvedTheme {
  systemThemeSnapshot ??= readCachedResolvedTheme() ?? readSystemResolvedTheme();
  return systemThemeSnapshot;
}

function updateSystemThemeSnapshot(): void {
  const next = readSystemResolvedTheme();
  if (systemThemeSnapshot === next) {
    return;
  }
  systemThemeSnapshot = next;
  for (const listener of systemThemeListeners) {
    listener();
  }
}

function subscribeSystemTheme(listener: () => void): () => void {
  systemThemeListeners.add(listener);
  if (!systemThemeQuery) {
    systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    systemThemeQuery.addEventListener('change', updateSystemThemeSnapshot);
    window.queueMicrotask(updateSystemThemeSnapshot);
  }
  return () => {
    systemThemeListeners.delete(listener);
    if (systemThemeListeners.size === 0 && systemThemeQuery) {
      systemThemeQuery.removeEventListener('change', updateSystemThemeSnapshot);
      systemThemeQuery = null;
    }
  };
}

function useSystemTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeSystemTheme, getSystemThemeSnapshot, getSystemThemeSnapshot);
}

/**
 * Hook to read theme state. App-level side effects live in useThemeController.
 */
export function useTheme(): {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  isDark: boolean;
  isLight: boolean;
} {
  const configuredTheme = useStore(selectConfiguredTheme);
  const systemTheme = useSystemTheme();
  const resolvedTheme = configuredTheme === 'system' ? systemTheme : configuredTheme;

  return {
    theme: configuredTheme,
    resolvedTheme,
    isDark: resolvedTheme === 'dark',
    isLight: resolvedTheme === 'light',
  };
}

/**
 * App-level theme side effects. Keep this mounted once at the root.
 */
export function useThemeController(): ReturnType<typeof useTheme> {
  const themeState = useTheme();
  const { appConfig, configLoading, fetchConfig } = useStore(
    useShallow((s) => ({
      appConfig: s.appConfig,
      configLoading: s.configLoading,
      fetchConfig: s.fetchConfig,
    }))
  );
  const { resolvedTheme } = themeState;

  // Fetch config on mount if not loaded.
  // The centralized init chain also calls fetchConfig - configLoading guard
  // in the store action prevents duplicate IPC calls.
  useEffect(() => {
    if (!appConfig && !configLoading) {
      void fetchConfig();
    }
  }, [appConfig, configLoading, fetchConfig]);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;

    body.classList.add('theme-transitioning');

    // Remove existing theme classes
    root.classList.remove('dark', 'light');

    // Add new theme class
    root.classList.add(resolvedTheme);

    const timer = window.setTimeout(() => {
      body.classList.remove('theme-transitioning');
    }, 250);

    return () => {
      window.clearTimeout(timer);
      body.classList.remove('theme-transitioning');
    };
  }, [resolvedTheme]);

  useEffect(() => {
    writeCachedResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  return themeState;
}
