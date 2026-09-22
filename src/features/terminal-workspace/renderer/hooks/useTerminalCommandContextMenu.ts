import { useCallback, useEffect, useState } from 'react';

import {
  copyTerminalCommandContextText,
  resolveTerminalCommandContextMenuSnapshot,
  type TerminalCommandContextMenuSnapshot,
} from '../adapters/terminalCommandContextMenu';

import type { MouseEvent as ReactMouseEvent } from 'react';

type CopyTerminalCommandContextText = (text: string) => Promise<boolean>;

interface UseTerminalCommandContextMenuResult {
  closeMenu: () => void;
  copyMenuText: (text: string) => Promise<boolean>;
  handleContextMenuCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
  handleOpenChange: (open: boolean) => void;
  menu: TerminalCommandContextMenuSnapshot | null;
}

export function useTerminalCommandContextMenu({
  contextKey,
  copyText = copyTerminalCommandContextText,
}: Readonly<{
  contextKey: string;
  copyText?: CopyTerminalCommandContextText;
}>): UseTerminalCommandContextMenuResult {
  const [menu, setMenu] = useState<TerminalCommandContextMenuSnapshot | null>(null);

  const closeMenu = useCallback((): void => {
    setMenu(null);
  }, []);

  const copyMenuText = useCallback(
    async (text: string): Promise<boolean> => {
      closeMenu();
      if (!text.trim()) {
        return false;
      }

      try {
        return await copyText(text);
      } catch {
        return false;
      }
    },
    [closeMenu, copyText]
  );

  const handleContextMenuCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      const nextMenu = resolveTerminalCommandContextMenuSnapshot(event.nativeEvent);
      if (!nextMenu) {
        closeMenu();
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setMenu(nextMenu);
    },
    [closeMenu]
  );

  const handleOpenChange = useCallback(
    (open: boolean): void => {
      if (!open) {
        closeMenu();
      }
    },
    [closeMenu]
  );

  useEffect(() => {
    closeMenu();
  }, [closeMenu, contextKey]);

  useEffect(() => {
    if (!menu) {
      return undefined;
    }

    window.addEventListener('resize', closeMenu);
    return () => window.removeEventListener('resize', closeMenu);
  }, [closeMenu, menu]);

  return {
    closeMenu,
    copyMenuText,
    handleContextMenuCapture,
    handleOpenChange,
    menu,
  };
}
