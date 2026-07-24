import { useMemo, useRef } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Popover, PopoverAnchor, PopoverContent } from '@renderer/components/ui/popover';
import { shortcutLabel } from '@renderer/utils/platformKeys';

import type { TerminalCommandContextMenuSnapshot } from '../adapters/terminalCommandContextMenu';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

interface TerminalCommandContextMenuProps {
  menu: TerminalCommandContextMenuSnapshot;
  onCopy: (text: string) => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
}

export const TerminalCommandContextMenu = ({
  menu,
  onCopy,
  onOpenChange,
}: TerminalCommandContextMenuProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const restoreFocusTargetRef = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  const didRestoreFocusRef = useRef(false);
  const shouldRestoreFocusRef = useRef(true);
  const virtualAnchorRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: (): DOMRect => createVirtualAnchorRect(menu.x, menu.y),
      },
    }),
    [menu.x, menu.y]
  );

  const restoreFocus = (): void => {
    if (
      didRestoreFocusRef.current ||
      !shouldRestoreFocusRef.current ||
      !restoreFocusTargetRef.current?.isConnected
    ) {
      return;
    }

    didRestoreFocusRef.current = true;
    restoreFocusTargetRef.current.focus();
  };

  const copyMenuText = (text: string): Promise<boolean> => {
    const result = onCopy(text);
    restoreFocus();
    return result;
  };

  const focusMenuItem = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = itemRefs.current.filter(
      (item): item is HTMLButtonElement => item !== null && !item.disabled
    );
    if (items.length === 0) {
      return;
    }

    const currentIndex = items.findIndex((item) => item === document.activeElement);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    } else if (event.key === 'ArrowUp') {
      nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = items.length - 1;
    }

    if (nextIndex === null) {
      return;
    }

    event.preventDefault();
    items[nextIndex]?.focus();
  };

  return (
    <Popover
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          restoreFocus();
        }
        onOpenChange(open);
      }}
    >
      <PopoverAnchor virtualRef={virtualAnchorRef} />
      <PopoverContent
        role="menu"
        aria-label={t('terminalWorkspace.terminalCommandActions')}
        align="start"
        avoidCollisions
        collisionPadding={8}
        side="bottom"
        sideOffset={0}
        sticky="always"
        className="z-[10000] max-h-none w-auto min-w-56 overflow-visible border-white/10 bg-[#181a1f] p-1 text-[13px] text-slate-100 shadow-[0_18px_44px_rgba(0,0,0,0.46)]"
        data-testid="agent-team-terminal-command-context-menu"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={focusMenuItem}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          itemRefs.current[0]?.focus();
        }}
        onPointerDownOutside={() => {
          shouldRestoreFocusRef.current = false;
        }}
      >
        <TerminalCommandContextMenuItem
          ref={(element) => {
            itemRefs.current[0] = element;
          }}
          label={t('terminalWorkspace.copy')}
          shortcut={shortcutLabel('⌘C', 'Ctrl+C')}
          testId="agent-team-terminal-command-context-copy"
          text={menu.blockText}
          onCopy={copyMenuText}
        />
        <TerminalCommandContextMenuItem
          ref={(element) => {
            itemRefs.current[1] = element;
          }}
          label={t('terminalWorkspace.copyCommand')}
          shortcut={shortcutLabel('⇧⌘C', 'Shift+Ctrl+C')}
          testId="agent-team-terminal-command-context-copy-command"
          text={menu.commandText}
          onCopy={copyMenuText}
        />
        <TerminalCommandContextMenuItem
          ref={(element) => {
            itemRefs.current[2] = element;
          }}
          disabled={!menu.outputText}
          label={t('terminalWorkspace.copyOutput')}
          shortcut={shortcutLabel('⌥⇧⌘C', 'Alt+Shift+Ctrl+C')}
          testId="agent-team-terminal-command-context-copy-output"
          text={menu.outputText}
          onCopy={copyMenuText}
        />
      </PopoverContent>
    </Popover>
  );
};

const TerminalCommandContextMenuItem = ({
  ref,
  disabled = false,
  label,
  shortcut,
  testId,
  text,
  onCopy,
}: {
  ref: (element: HTMLButtonElement | null) => void;
  disabled?: boolean;
  label: string;
  shortcut: string;
  testId: string;
  text: string;
  onCopy: (text: string) => Promise<boolean>;
}): React.JSX.Element => (
  <button
    ref={ref}
    type="button"
    role="menuitem"
    className="flex w-full items-center justify-between gap-6 rounded px-3 py-2 text-left text-slate-100 outline-none transition-colors hover:bg-white/[0.07] focus:bg-white/[0.07] disabled:cursor-not-allowed disabled:text-slate-500"
    data-testid={testId}
    disabled={disabled}
    onClick={() => void onCopy(text)}
  >
    <span>{label}</span>
    <span className="font-mono text-[12px] text-slate-500">{shortcut}</span>
  </button>
);

function createVirtualAnchorRect(x: number, y: number): DOMRect {
  return {
    bottom: y,
    height: 0,
    left: x,
    right: x,
    toJSON: () => ({}),
    top: y,
    width: 0,
    x,
    y,
  };
}
