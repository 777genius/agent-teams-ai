import { createRequire } from 'node:module';

import { createLogger } from '@shared/utils/logger';

import type {
  PtyKeyAction,
  PtyProcessPort,
  PtySessionPort,
  PtySpawnInput,
  PtySpawnResult,
  TerminalSnapshot,
} from '../../../core/application';
import type { IPty } from 'node-pty';
import type * as NodePty from 'node-pty';

const logger = createLogger('WorkspaceTrustNodePtyProcessAdapter');
const MAX_TRANSCRIPT_CHARS = 64 * 1024;
const requireNativeAddon = createRequire(import.meta.url);

type NodePtyModule = typeof NodePty;

let nodePty: NodePtyModule | null | undefined;

function loadNodePty(): NodePtyModule | null {
  if (nodePty !== undefined) {
    return nodePty;
  }
  try {
    nodePty = requireNativeAddon('node-pty') as NodePtyModule;
  } catch (error) {
    logger.warn(`node-pty unavailable for workspace trust preflight: ${String(error)}`);
    nodePty = null;
  }
  return nodePty;
}

class NodePtySession implements PtySessionPort {
  #transcript = '';
  #exited = false;

  constructor(private readonly pty: IPty) {
    this.pty.onData((chunk) => {
      this.#transcript = (this.#transcript + chunk).slice(-MAX_TRANSCRIPT_CHARS);
    });
    this.pty.onExit(() => {
      this.#exited = true;
    });
  }

  async readSnapshot(timeoutMs: number): Promise<TerminalSnapshot | null> {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    if (!this.#transcript && this.#exited) {
      return null;
    }
    return {
      text: this.#transcript,
      capturedAtMs: Date.now(),
    };
  }

  async writeAction(action: PtyKeyAction): Promise<void> {
    this.pty.write(action.sequence);
  }

  async kill(): Promise<void> {
    try {
      this.pty.kill();
    } catch {
      /* already exited */
    }
  }
}

export class NodePtyProcessAdapter implements PtyProcessPort {
  async spawn(input: PtySpawnInput): Promise<PtySpawnResult> {
    const ptyModule = loadNodePty();
    if (!ptyModule) {
      return {
        ok: false,
        code: 'node_pty_unavailable',
        message: 'node-pty is unavailable for workspace trust preflight.',
      };
    }

    try {
      const pty = ptyModule.spawn(input.command, input.args, {
        name: input.name ?? 'xterm-256color',
        cols: input.cols ?? 120,
        rows: input.rows ?? 36,
        cwd: input.cwd,
        env: input.env,
      });
      return { ok: true, session: new NodePtySession(pty) };
    } catch (error) {
      return {
        ok: false,
        code: 'node_pty_spawn_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
