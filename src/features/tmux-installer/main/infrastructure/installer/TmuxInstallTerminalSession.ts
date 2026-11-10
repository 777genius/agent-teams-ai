import { createLogger } from '@shared/utils/logger';

import type { TmuxCommandSpec } from './TmuxCommandRunner';
import type { IPty } from 'node-pty';
import type * as NodePty from 'node-pty';

const logger = createLogger('Feature:tmux-installer:pty');

type NodePtyModule = typeof NodePty;

let nodePty: NodePtyModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pty is optional native addon
  nodePty = require('node-pty') as NodePtyModule;
} catch {
  logger.warn('node-pty not available - interactive tmux installer terminal input disabled');
}

interface RunTerminalOptions {
  onLine: (line: string) => void;
  onChunk?: (chunk: string) => void;
}

export class TmuxInstallTerminalSession {
  #pty: IPty | null = null;

  static isSupported(): boolean {
    return nodePty !== null;
  }

  async run(spec: TmuxCommandSpec, options: RunTerminalOptions): Promise<{ exitCode: number }> {
    if (!nodePty) {
      throw new Error('Interactive tmux installer terminal is unavailable in this build.');
    }

    return new Promise((resolve) => {
      const pty = nodePty.spawn(spec.command, spec.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: spec.cwd,
        env: spec.env as Record<string, string>,
      });
      this.#pty = pty;

      let pending = '';
      const emitLine = (line: string): void => {
        const normalized = line.replace(/\r$/, '');
        if (normalized.trim()) {
          options.onLine(normalized);
        }
      };

      pty.onData((chunk) => {
        options.onChunk?.(chunk);
        pending += chunk;
        const normalizedPending = pending.replace(/\r/g, '\n');
        const lines = normalizedPending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          emitLine(line);
        }
      });
      pty.onExit(({ exitCode }) => {
        if (pending.trim()) {
          emitLine(pending.trimEnd());
        }
        this.#pty = null;
        resolve({ exitCode });
      });
    });
  }

  writeLine(input: string): void {
    if (!this.#pty) {
      throw new Error('Interactive tmux installer terminal is not running.');
    }
    this.#pty.write(`${input}\r`);
  }

  cancel(): void {
    if (!this.#pty) {
      return;
    }
    this.#pty.kill();
    this.#pty = null;
  }
}
