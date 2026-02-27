import '@xterm/xterm/css/xterm.css';

import { useEffect, useRef } from 'react';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

interface TerminalLogPanelProps {
  /** Raw output chunks (with ANSI codes) to render */
  chunks: string[];
  /** CSS class for container */
  className?: string;
}

export const TerminalLogPanel = ({
  chunks,
  className,
}: TerminalLogPanelProps): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const writtenRef = useRef(0);

  // Create xterm instance once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 200,
      theme: {
        background: '#141416',
        foreground: '#fafafa',
        cursor: 'transparent',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    const rafId = requestAnimationFrame(() => fitAddon.fit());

    const observer = new ResizeObserver(() => fitAddon.fit());
    observer.observe(container);

    termRef.current = term;
    writtenRef.current = 0;

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      writtenRef.current = 0;
    };
  }, []);

  // Write new chunks incrementally
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    for (let i = writtenRef.current; i < chunks.length; i++) {
      term.write(chunks[i]);
    }
    writtenRef.current = chunks.length;
  }, [chunks]);

  return (
    <div
      ref={containerRef}
      className={`mt-2 overflow-hidden rounded border ${className ?? ''}`}
      style={{
        borderColor: 'var(--color-border)',
        height: '120px',
      }}
    />
  );
};
