interface CacheEntry<T> {
  mtimeMs: number;
  size: number;
  value: T;
}

export class BoardTaskActivityParseCache<T> {
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();

  getIfFresh(filePath: string, mtimeMs: number, size: number): T | null {
    const cached = this.cache.get(filePath);
    if (!cached) return null;
    if (cached.mtimeMs !== mtimeMs || cached.size !== size) {
      this.cache.delete(filePath);
      return null;
    }
    return cached.value;
  }

  getInFlight(filePath: string): Promise<T> | null {
    return this.inFlight.get(filePath) ?? null;
  }

  setInFlight(filePath: string, promise: Promise<T>): void {
    this.inFlight.set(filePath, promise);
  }

  clearInFlight(filePath: string): void {
    this.inFlight.delete(filePath);
  }

  set(filePath: string, mtimeMs: number, size: number, value: T): void {
    this.cache.set(filePath, { mtimeMs, size, value });
  }

  clearForPath(filePath: string): void {
    this.cache.delete(filePath);
    this.inFlight.delete(filePath);
  }

  retainOnly(filePaths: Set<string>): void {
    for (const filePath of this.cache.keys()) {
      if (!filePaths.has(filePath)) {
        this.cache.delete(filePath);
      }
    }
    for (const filePath of this.inFlight.keys()) {
      if (!filePaths.has(filePath)) {
        this.inFlight.delete(filePath);
      }
    }
  }
}
