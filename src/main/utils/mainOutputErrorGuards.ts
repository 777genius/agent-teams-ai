import type { EventEmitter } from 'node:events';

type OutputChannel = 'stdout' | 'stderr';
type OutputStreams = Readonly<Record<OutputChannel, Pick<EventEmitter, 'on'>>>;
const guardedStreams = new WeakSet<object>();

/** Main-only diagnostic transport guard. Its reporter must never write to the console. */
export function installMainOutputErrorGuards(
  report: (channel: OutputChannel, error: unknown) => void,
  streams: OutputStreams = { stdout: process.stdout, stderr: process.stderr }
): void {
  for (const channel of ['stdout', 'stderr'] as const) {
    const stream = streams[channel];
    if (guardedStreams.has(stream)) continue;
    guardedStreams.add(stream);
    stream.on('error', (error: unknown) => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') return;
      try {
        report(channel, error);
      } catch {
        // A diagnostic failure must not re-enter console-based uncaught exception logging.
      }
    });
  }
}
