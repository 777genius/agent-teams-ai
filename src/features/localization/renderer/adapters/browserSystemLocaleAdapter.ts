export function getBrowserSystemLocale(): string | null {
  return globalThis.navigator?.language ?? null;
}
