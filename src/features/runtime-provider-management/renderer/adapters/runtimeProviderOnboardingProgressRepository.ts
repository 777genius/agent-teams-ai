import { normalizeRuntimeProviderOnboardingProgress } from '../../core/domain';

import type { RuntimeProviderOnboardingProgress } from '../../core/domain';

export interface RuntimeProviderOnboardingProgressRepository {
  load(): RuntimeProviderOnboardingProgress | null;
  save(progress: RuntimeProviderOnboardingProgress): void;
  clear(): void;
}

const STORAGE_KEY = 'agentTeams.runtimeProviderOnboarding.v1';

export class BrowserRuntimeProviderOnboardingProgressRepository implements RuntimeProviderOnboardingProgressRepository {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {}

  load(): RuntimeProviderOnboardingProgress | null {
    try {
      const serialized = this.storage.getItem(STORAGE_KEY);
      if (!serialized) {
        return null;
      }
      const progress = normalizeRuntimeProviderOnboardingProgress(JSON.parse(serialized));
      if (!progress) {
        this.clear();
      }
      return progress;
    } catch {
      return null;
    }
  }

  save(progress: RuntimeProviderOnboardingProgress): void {
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(progress));
    } catch {
      // Progress persistence is best-effort and never blocks provider setup.
    }
  }

  clear(): void {
    try {
      this.storage.removeItem(STORAGE_KEY);
    } catch {
      // Storage may be unavailable in hardened browser environments.
    }
  }
}

export function createRuntimeProviderOnboardingProgressRepository(): RuntimeProviderOnboardingProgressRepository {
  return new BrowserRuntimeProviderOnboardingProgressRepository(window.localStorage);
}
