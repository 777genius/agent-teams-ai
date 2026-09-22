import { spawn } from 'node:child_process';

import { killProcessTree } from '@main/utils/childProcess';

import { decodeInstallerProcessOutput } from '../runtime/decodeInstallerProcessOutput';

import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface TmuxCommandSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

interface RunCommandOptions {
  onLine: (line: string) => void;
}

export class TmuxCommandRunner {
  #activeChild: ChildProcessByStdio<null, Readable, Readable> | null = null;

  get activeChild(): ChildProcessByStdio<null, Readable, Readable> | null {
    return this.#activeChild;
  }

  async run(spec: TmuxCommandSpec, options: RunCommandOptions): Promise<{ exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.#activeChild = child;
      const platform = process.platform;

      const createBufferedLineWriter = (): {
        push: (chunk: Buffer | string) => void;
        flush: () => void;
      } => {
        let pending = '';
        let pendingBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);

        const emitLine = (line: string): void => {
          const normalizedLine = line.replace(/\r$/, '');
          if (normalizedLine.trim()) {
            options.onLine(normalizedLine);
          }
        };

        return {
          push: (chunk: Buffer | string): void => {
            let decodedChunk = '';
            if (typeof chunk === 'string') {
              decodedChunk = chunk;
            } else {
              let nextBuffer =
                pendingBytes.length > 0 ? Buffer.concat([pendingBytes, chunk]) : chunk;
              if (platform === 'win32' && nextBuffer.length % 2 === 1) {
                pendingBytes = nextBuffer.subarray(nextBuffer.length - 1);
                nextBuffer = nextBuffer.subarray(0, nextBuffer.length - 1);
              } else {
                pendingBytes = Buffer.alloc(0);
              }
              if (nextBuffer.length > 0) {
                decodedChunk = decodeInstallerProcessOutput(nextBuffer, platform);
              }
            }
            pending += decodedChunk;
            const normalizedPending = pending.replace(/\r(?!\n)/g, '\n');
            const lines = normalizedPending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) {
              emitLine(line);
            }
          },
          flush: (): void => {
            if (pendingBytes.length > 0) {
              pending += decodeInstallerProcessOutput(pendingBytes, platform);
              pendingBytes = Buffer.alloc(0);
            }
            if (!pending) {
              return;
            }
            emitLine(pending.trimEnd());
            pending = '';
          },
        };
      };

      const stdoutWriter = createBufferedLineWriter();
      const stderrWriter = createBufferedLineWriter();

      child.stdout.on('data', (chunk: Buffer | string) => stdoutWriter.push(chunk));
      child.stderr.on('data', (chunk: Buffer | string) => stderrWriter.push(chunk));
      child.on('error', (error) => {
        this.#activeChild = null;
        reject(error);
      });
      child.on('close', (exitCode) => {
        stdoutWriter.flush();
        stderrWriter.flush();
        this.#activeChild = null;
        resolve({ exitCode: exitCode ?? 0 });
      });
    });
  }

  cancel(): void {
    killProcessTree(this.#activeChild);
    this.#activeChild = null;
  }
}
