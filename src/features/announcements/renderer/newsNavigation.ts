const listeners = new Set<() => void>();
export function openAnnouncementHistory(): void {
  listeners.forEach((listener) => listener());
}
export function subscribeAnnouncementHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
