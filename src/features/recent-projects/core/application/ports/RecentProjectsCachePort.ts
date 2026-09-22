export interface RecentProjectsCachePort<T> {
  get(key: string): Promise<T | null>;
  getStale(key: string): Promise<T | null>;
  set(key: string, value: T, ttlMs: number): Promise<void>;
}
