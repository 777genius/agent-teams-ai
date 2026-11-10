import { useEffect, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';

/**
 * Returns whether the window is in native fullscreen (macOS green button).
 * When true, traffic light padding should be 0 so content can use the full width.
 */
export function useFullScreen(): boolean {
  const [isFullScreen, setIsFullScreen] = useState(false);

  useEffect(() => {
    if (!isElectronMode()) return;

    const { isFullScreen: isFullScreenFn } = api.windowControls;
    if (typeof isFullScreenFn !== 'function') return;

    let cancelled = false;

    void isFullScreenFn().then((full) => {
      if (!cancelled) setIsFullScreen(full);
    });

    const unsub =
      typeof api.onFullScreenChange === 'function'
        ? api.onFullScreenChange((full) => {
            if (!cancelled) setIsFullScreen(full);
          })
        : () => {};

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return isFullScreen;
}
