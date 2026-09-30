import { useEffect } from 'react';

export function useHostedDashboardPaletteShortcut(
  page: 'dashboard' | 'chooser' | 'team',
  paletteOpen: boolean,
  open: () => void
): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== 'k' ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        paletteOpen ||
        page !== 'dashboard'
      )
        return;
      event.preventDefault();
      open();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [page, paletteOpen, open]);
}
