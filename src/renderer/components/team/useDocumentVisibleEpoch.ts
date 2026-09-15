import { useEffect, useState } from 'react';

export function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export function useDocumentVisibleEpoch(): number {
  const [visibleEpoch, setVisibleEpoch] = useState(0);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (!isDocumentHidden()) {
        setVisibleEpoch((current) => current + 1);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  return visibleEpoch;
}
