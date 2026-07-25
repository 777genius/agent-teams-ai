import { useLayoutEffect, useRef } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import { shortcutLabel } from '@renderer/utils/platformKeys';

import type { TerminalCommandContextMenuSnapshot } from '../adapters/terminalCommandContextMenu';

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
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const restoreFocusTargetRef = useRef(resolveDeepActiveElement());
  const didRestoreFocusRef = useRef(false);
  const shouldRestoreFocusRef = useRef(true);

  useLayoutEffect(() => {
    triggerRef.current?.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        button: 2,
        cancelable: true,
        clientX: menu.x,
        clientY: menu.y,
      })
    );
  }, [menu.x, menu.y]);

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

  return (
    <ContextMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          restoreFocus();
        }
        onOpenChange(open);
      }}
    >
      <ContextMenuTrigger asChild>
        <span ref={triggerRef} aria-hidden className="pointer-events-none fixed h-px w-px" />
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label={t('terminalWorkspace.terminalCommandActions')}
        avoidCollisions
        collisionPadding={8}
        loop
        sticky="always"
        className="z-[10000] max-h-none w-auto min-w-56 overflow-visible border-white/10 bg-[#181a1f] p-1 text-[13px] text-slate-100 shadow-[0_18px_44px_rgba(0,0,0,0.46)]"
        data-testid="agent-team-terminal-command-context-menu"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDownOutside={() => {
          shouldRestoreFocusRef.current = false;
        }}
      >
        <TerminalCommandContextMenuItem
          label={t('terminalWorkspace.copy')}
          shortcut={shortcutLabel('⌘C', 'Ctrl+C')}
          testId="agent-team-terminal-command-context-copy"
          text={menu.blockText}
          onCopy={copyMenuText}
        />
        <TerminalCommandContextMenuItem
          label={t('terminalWorkspace.copyCommand')}
          shortcut={shortcutLabel('⇧⌘C', 'Shift+Ctrl+C')}
          testId="agent-team-terminal-command-context-copy-command"
          text={menu.commandText}
          onCopy={copyMenuText}
        />
        <TerminalCommandContextMenuItem
          disabled={!menu.outputText}
          label={t('terminalWorkspace.copyOutput')}
          shortcut={shortcutLabel('⌥⇧⌘C', 'Alt+Shift+Ctrl+C')}
          testId="agent-team-terminal-command-context-copy-output"
          text={menu.outputText}
          onCopy={copyMenuText}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
};

const TerminalCommandContextMenuItem = ({
  disabled = false,
  label,
  shortcut,
  testId,
  text,
  onCopy,
}: {
  disabled?: boolean;
  label: string;
  shortcut: string;
  testId: string;
  text: string;
  onCopy: (text: string) => Promise<boolean>;
}): React.JSX.Element => (
  <ContextMenuItem
    className="flex w-full items-center justify-between gap-6 rounded px-3 py-2 text-left text-slate-100 outline-none transition-colors hover:bg-white/[0.07] focus:bg-white/[0.07] data-[disabled]:cursor-not-allowed data-[disabled]:text-slate-500"
    data-testid={testId}
    disabled={disabled}
    onSelect={() => void onCopy(text)}
  >
    <span>{label}</span>
    <span className="font-mono text-[12px] text-slate-500">{shortcut}</span>
  </ContextMenuItem>
);

function resolveDeepActiveElement(): HTMLElement | null {
  let activeElement: Element | null = document.activeElement;
  while (activeElement instanceof HTMLElement) {
    const shadowActiveElement = activeElement.shadowRoot?.activeElement;
    if (!(shadowActiveElement instanceof HTMLElement)) {
      return activeElement;
    }
    activeElement = shadowActiveElement;
  }
  return null;
}
