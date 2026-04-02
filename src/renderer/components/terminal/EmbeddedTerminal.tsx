import '@xterm/xterm/css/xterm.css';

import { useEffect, useRef } from 'react';

import { api } from '@renderer/api';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';

import type { PtySpawnOptions } from '@shared/types/terminal';

interface EmbeddedTerminalProps {
  /** Command to run (if not provided, opens default shell) */
  command?: string;
  /** Arguments for the command */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Environment variables merged into the PTY process env */
  env?: Record<string, string>;
  /** Callback when PTY process exits */
  onExit?: (exitCode: number) => void;
  /** CSS class for container */
  className?: string;
}

export const EmbeddedTerminal = ({
  command,
  args,
  cwd,
  env,
  onExit,
  className,
}: EmbeddedTerminalProps): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let ptyId: string | null = null;
    let disposed = false;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#141416',
        foreground: '#fafafa',
        cursor: '#fafafa',
        selectionBackground: 'rgba(255, 255, 255, 0.2)',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // Clickable URLs — opens in external browser
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      void api.openExternal(uri);
    });
    term.loadAddon(webLinksAddon);

    term.open(container);

    // Fit after opening so dimensions are correct
    const rafId = requestAnimationFrame(() => fitAddon.fit());

    // Ctrl+C with selection → copy to clipboard (instead of sending SIGINT)
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.code === 'KeyC' && (event.ctrlKey || event.metaKey)) {
        const selection = term.getSelection();
        if (selection) {
          void navigator.clipboard.writeText(selection);
          return false; // Prevent sending to PTY
        }
      }
      return true;
    });

    // User input → PTY (returns IDisposable — must dispose in cleanup)
    const inputDisposable = term.onData((data) => {
      if (ptyId) api.terminal.write(ptyId, data);
    });

    // PTY output → xterm
    const unsubData = api.terminal.onData((_, id, data) => {
      if (id === ptyId && !disposed) term.write(data);
    });

    // PTY exit
    const unsubExit = api.terminal.onExit((_, id, exitCode) => {
      if (id === ptyId) {
        ptyId = null;
        onExit?.(exitCode);
      }
    });

    // Spawn PTY
    const spawnOptions: PtySpawnOptions = {
      ...(command ? { command } : {}),
      ...(args ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      cols: term.cols,
      rows: term.rows,
    };

    api.terminal
      .spawn(spawnOptions)
      .then((id) => {
        if (disposed) return;
        ptyId = id;
        // Send actual terminal size after spawn (fitAddon.fit() may have
        // changed cols/rows via RAF after spawnOptions was constructed)
        api.terminal.resize(id, term.cols, term.rows);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        term.write(
          `\r\n\x1b[31mFailed to start terminal: ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`
        );
      });

    // ResizeObserver → fitAddon.fit() → pty.resize()
    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      if (ptyId) {
        api.terminal.resize(ptyId, term.cols, term.rows);
      }
    });
    observer.observe(container);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      inputDisposable.dispose();
      unsubData();
      unsubExit();
      if (ptyId) api.terminal.kill(ptyId);
      observer.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally run once on mount
  }, []);

  return (
    <div
      ref={containerRef}
      className={`min-h-0 flex-1 ${className ?? ''}`}
      style={{ overflow: 'hidden' }}
    />
  );
};
