import type { CodexModelCatalogDto } from '@features/codex-model-catalog/contracts';

interface CacheEntry {
  value: CodexModelCatalogDto;
  observedAt: number;
}

export class InMemoryCodexModelCatalogCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(key: string, maxAgeMs: number): CodexModelCatalogDto | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.observedAt > maxAgeMs) {
      return null;
    }
    return structuredClone(entry.value);
  }

  getLatest(key: string): CodexModelCatalogDto | null {
    const entry = this.entries.get(key);
    return entry ? structuredClone(entry.value) : null;
  }

  set(key: string, value: CodexModelCatalogDto): void {
    this.entries.set(key, {
      value: structuredClone(value),
      observedAt: Date.now(),
    });
  }

  clear(): void {
    this.entries.clear();
  }
}
