/**
 * Terminal types — shared between main, preload, and renderer processes.
 *
 * Used for embedded PTY terminal (xterm.js + node-pty).
 */

// =============================================================================
// PTY Spawn Options
// =============================================================================

/**
 * Options for spawning a new PTY process.
 */
export interface PtySpawnOptions {
  /** Command to run (default: user's shell) */
  command?: string;
  /** Arguments for the command */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Environment variables (merged with process.env) */
  env?: Record<string, string>;
  /** Initial terminal columns */
  cols?: number;
  /** Initial terminal rows */
  rows?: number;
}

// =============================================================================
// Preload API
// =============================================================================

/**
 * Terminal API exposed via preload bridge.
 */
export interface TerminalAPI {
  /** Spawn a new PTY process. Returns unique pty ID. */
  spawn: (options?: PtySpawnOptions) => Promise<string>;
  /** Write data to PTY stdin (fire-and-forget). */
  write: (ptyId: string, data: string) => void;
  /** Resize PTY terminal (fire-and-forget). */
  resize: (ptyId: string, cols: number, rows: number) => void;
  /** Kill PTY process (fire-and-forget). */
  kill: (ptyId: string) => void;
  /** Subscribe to PTY data output. Returns cleanup function. */
  onData: (cb: (event: unknown, ptyId: string, data: string) => void) => () => void;
  /** Subscribe to PTY exit events. Returns cleanup function. */
  onExit: (cb: (event: unknown, ptyId: string, exitCode: number) => void) => () => void;
}
