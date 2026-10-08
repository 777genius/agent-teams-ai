import { useAppTranslation } from '@features/localization/renderer';

import type { TerminalCommandContextMenuState } from '../adapters/terminalCommandContextMenu';

export const TerminalCommandContextMenu = ({
  menu,
  onClose,
  onCopy,
}: {
  menu: TerminalCommandContextMenuState;
  onClose: () => void;
  onCopy: (text: string) => void | Promise<void>;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  return (
    <div
      role="menu"
      aria-label={t('terminalWorkspace.terminalCommandActions')}
      tabIndex={-1}
      className="fixed z-[10000] min-w-56 rounded-md border border-white/10 bg-[#181a1f] p-1 text-[13px] text-slate-100 shadow-[0_18px_44px_rgba(0,0,0,0.46)] outline-none"
      data-testid="agent-team-terminal-command-context-menu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <TerminalCommandContextMenuItem
        label={t('terminalWorkspace.copy')}
        shortcut="⌘C"
        testId="agent-team-terminal-command-context-copy"
        text={menu.blockText}
        onCopy={onCopy}
      />
      <TerminalCommandContextMenuItem
        label={t('terminalWorkspace.copyCommand')}
        shortcut="⇧⌘C"
        testId="agent-team-terminal-command-context-copy-command"
        text={menu.commandText}
        onCopy={onCopy}
      />
      <TerminalCommandContextMenuItem
        disabled={!menu.outputText}
        label={t('terminalWorkspace.copyOutput')}
        shortcut="⌥⇧⌘C"
        testId="agent-team-terminal-command-context-copy-output"
        text={menu.outputText}
        onCopy={onCopy}
      />
    </div>
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
  onCopy: (text: string) => void | Promise<void>;
}): React.JSX.Element => (
  <button
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
