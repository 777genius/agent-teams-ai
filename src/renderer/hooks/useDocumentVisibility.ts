import { useSyncExternalStore } from 'react';

function subscribe(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

function getSnapshot(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

export function useDocumentVisibility(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
