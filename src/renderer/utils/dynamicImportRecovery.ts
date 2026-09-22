const LAST_RELOAD_AT_KEY = 'agent-teams-ai:dynamic-import-recovery:last-reload-at';
const RELOAD_THROTTLE_MS = 10_000;

interface DynamicImportRecoveryOptions {
  now?: () => number;
  reload?: () => void;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

function readLastReloadAt(storage: DynamicImportRecoveryOptions['storage']): number {
  if (!storage) {
    return 0;
  }

  try {
    const value = Number(storage.getItem(LAST_RELOAD_AT_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeLastReloadAt(
  storage: DynamicImportRecoveryOptions['storage'],
  timestamp: number
): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(LAST_RELOAD_AT_KEY, String(timestamp));
  } catch {
    // Session storage can be unavailable in constrained renderer contexts.
  }
}

export function registerDynamicImportRecovery({
  now = () => Date.now(),
  reload = () => window.location.reload(),
  storage = window.sessionStorage,
}: DynamicImportRecoveryOptions = {}): () => void {
  const handlePreloadError = (event: Event): void => {
    event.preventDefault();

    const timestamp = now();
    const lastReloadAt = readLastReloadAt(storage);
    if (lastReloadAt > 0 && timestamp - lastReloadAt < RELOAD_THROTTLE_MS) {
      return;
    }

    writeLastReloadAt(storage, timestamp);
    window.setTimeout(reload, 0);
  };

  window.addEventListener('vite:preloadError', handlePreloadError);

  return () => {
    window.removeEventListener('vite:preloadError', handlePreloadError);
  };
}
