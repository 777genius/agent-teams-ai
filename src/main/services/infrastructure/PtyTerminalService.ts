/**
 * PtyTerminalService — manages node-pty terminal instances.
 *
 * Provides PTY spawning, IO, and lifecycle management for the embedded terminal.
 * Events (data, exit) are forwarded to the renderer via mainWindow.webContents.send().
 */

import crypto from 'node:crypto';

import { getHomeDir } from '@main/utils/pathDecoder';
// eslint-disable-next-line boundaries/element-types -- IPC channel constants shared between main and preload
import { TERMINAL_DATA, TERMINAL_EXIT } from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';

import type { PtySpawnOptions } from '@shared/types/terminal';
import type { BrowserWindow } from 'electron';

const logger = createLogger('PtyTerminalService');

// Graceful import: node-pty is a native addon that may not be available
// if electron-rebuild was not run or native build tools are missing.
import type { IPty } from 'node-pty';
import type * as NodePty from 'node-pty';
type NodePtyModule = typeof NodePty;

let nodePty: NodePtyModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pty is optional native addon
  nodePty = require('node-pty') as NodePtyModule;
} catch {
  logger.warn('node-pty not available — terminal features disabled');
}

export class PtyTerminalService {
  private ptys = new Map<string, IPty>();
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * Spawn a new PTY process.
   * @returns Unique PTY ID for subsequent write/resize/kill calls.
   * @throws If node-pty native module is not available.
   */
  spawn(options?: PtySpawnOptions): string {
    if (!nodePty) {
      throw new Error(
        'Terminal not available: node-pty native module not found. Run: pnpm install'
      );
    }

    const id = crypto.randomUUID();
    const shell =
      options?.command ??
      (process.platform === 'win32'
        ? (process.env.COMSPEC ?? 'powershell.exe')
        : (process.env.SHELL ?? '/bin/bash'));

    const home = getHomeDir();
    const pty = nodePty.spawn(shell, options?.args ?? [], {
      name: 'xterm-256color',
      cols: options?.cols ?? 80,
      rows: options?.rows ?? 24,
      cwd: options?.cwd ?? home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ...options?.env,
      } as Record<string, string>,
    });

    pty.onData((data) => this.send(TERMINAL_DATA, id, data));
    pty.onExit(({ exitCode }) => {
      this.send(TERMINAL_EXIT, id, exitCode);
      this.ptys.delete(id);
    });

    this.ptys.set(id, pty);
    logger.info(`PTY spawned: ${id} (${shell})`);
    return id;
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.ptys.get(id)?.resize(cols, rows);
  }

  kill(id: string): void {
    const pty = this.ptys.get(id);
    if (pty) {
      pty.kill();
      this.ptys.delete(id);
      logger.info(`PTY killed: ${id}`);
    }
  }

  /** Kill all PTY processes. Called on app shutdown. */
  killAll(): void {
    const count = this.ptys.size;
    if (count > 0) {
      logger.info(`Killing ${count} PTY processes on shutdown`);
    }
    this.ptys.forEach((pty) => pty.kill());
    this.ptys.clear();
  }

  private send(channel: string, ...args: unknown[]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, ...args);
    }
  }
}
