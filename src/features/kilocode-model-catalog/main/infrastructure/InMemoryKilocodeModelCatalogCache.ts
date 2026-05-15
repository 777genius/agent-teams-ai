import type { KilocodeModelCatalogDto } from '../../contracts';

interface CacheEntry {
  value: KilocodeModelCatalogDto;
  observedAt: number;
}

export class InMemoryKilocodeModelCatalogCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(key: string, maxAgeMs: number): KilocodeModelCatalogDto | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.observedAt > maxAgeMs) {
      return null;
    }
    return structuredClone(entry.value);
  }

  getLatest(key: string): KilocodeModelCatalogDto | null {
    const entry = this.entries.get(key);
    return entry ? structuredClone(entry.value) : null;
  }

  set(key: string, value: KilocodeModelCatalogDto): void {
    this.entries.set(key, {
      value: structuredClone(value),
      observedAt: Date.now(),
    });
  }

  clear(): void {
    this.entries.clear();
  }
}
