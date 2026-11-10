// @vitest-environment node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { installMainOutputErrorGuards } from '../../../src/main/utils/mainOutputErrorGuards';

describe('main diagnostic output errors', () => {
  it.skipIf(process.platform === 'win32').each(['stdout', 'stderr'] as const)(
    'keeps event-loop progress after the real %s reader closes',
    async (channel) => {
      const source = `
        import { installMainOutputErrorGuards } from ${JSON.stringify(new URL('../../../src/main/utils/mainOutputErrorGuards.ts', import.meta.url).href)};
        let uncaught = 0;
        const reported = [];
        const writeErrors = [];
        process.on('uncaughtException', () => { uncaught++; });
        installMainOutputErrorGuards((stream, error) => reported.push({ stream, code: error?.code }));
        const deadline = setTimeout(() => {
          process.exitCode = 1;
          if (process.connected) process.disconnect();
        }, 5000);
        process.once('message', () => {
          let writes = 0;
          const next = () => process[${JSON.stringify(channel)}].write('TEST diagnostic output\\n', error => {
            if (error) writeErrors.push(error.code);
            if (++writes < 4) setImmediate(next);
            else setImmediate(() => process.send({ type: 'result', uncaught, reported, writeErrors, writes }, () => {
              clearTimeout(deadline);
              process.disconnect();
            }));
          });
          next();
        });
        process.send({ type: 'ready' });
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const exited = once(child, 'close');
      const messages: Record<string, unknown>[] = [];
      child.on('message', message => messages.push(message as Record<string, unknown>));
      await once(child, 'message');
      expect(messages[0]?.type).toBe('ready');
      const output = child[channel]!;
      const closed = once(output, 'close');
      output.destroy(); // Close only this new TEST child's diagnostic reader; no process signal.
      await closed;
      child.send({ type: 'write' });
      const [code, signal] = await exited;
      const result = messages.find(message => message.type === 'result');
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(result?.writeErrors).toContain('EPIPE');
      expect(result?.writes).toBe(4);
      expect(result?.uncaught).toBe(0);
      expect(result?.reported).toEqual([]);
    },
    15_000
  );

  it('routes unrelated output errors only to the diagnostic reporter', () => {
    const stdout = new PassThrough(), stderr = new PassThrough();
    const report = vi.fn();
    const error = Object.assign(new Error('TEST unrelated output failure'), { code: 'EIO' });
    installMainOutputErrorGuards(report, { stdout, stderr });
    expect(() => stdout.emit('error', error)).not.toThrow();
    expect(report).toHaveBeenCalledExactlyOnceWith('stdout', error);
    expect(() => stderr.emit('error', Object.assign(new Error('TEST destroyed'), {
      code: 'ERR_STREAM_DESTROYED',
    }))).not.toThrow();
    expect(report).toHaveBeenCalledTimes(1);
  });
});
