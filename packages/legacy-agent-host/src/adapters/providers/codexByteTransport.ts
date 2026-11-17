import type { ObservableNativeProcess } from '../../owned-process/processFacade.js';
import type { CodexAppServerTransport } from '@agent-teams/provider-implementations/codex';

/** Byte IO only; do not parse, correlate, inspect or dispatch native frames here. */
export function codexByteTransport(child: Pick<ObservableNativeProcess, 'stdin' | 'stdout'>): CodexAppServerTransport {
  // Writes report errors through their callback; a late pipe error must not crash the Host.
  child.stdin.on('error', () => {});
  return {
    async *read(signal) {
      const abort = () => {
        child.stdin.end();
        child.stdout.destroy();
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) return;
        for await (const chunk of child.stdout) {
          signal.throwIfAborted();
          yield Buffer.from(chunk as Uint8Array);
        }
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
    write(frame, signal) {
      signal.throwIfAborted();
      return new Promise<void>((resolve, reject) => {
        const abort = () => {
          finish(new Error('Native write unavailable'));
        };
        const finish = (error?: Error | null) => {
          signal.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve();
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        child.stdin.write(frame, finish);
      });
    },
  };
}
