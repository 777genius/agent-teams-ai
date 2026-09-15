import { useEffect, useRef, useState } from 'react';

export function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export function useDocumentVisibleEpoch(): number {
  const [visibleEpoch, setVisibleEpoch] = useState(0);
  const wasHiddenRef = useRef(isDocumentHidden());

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      const isHidden = isDocumentHidden();
      if (wasHiddenRef.current && !isHidden) {
        setVisibleEpoch((current) => current + 1);
      }
      wasHiddenRef.current = isHidden;
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  return visibleEpoch;
}
