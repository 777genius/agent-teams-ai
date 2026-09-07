import type { Socket } from 'node:net';
import { canonicalJson, sha256 } from './canonical';

export const SELECTED_LAUNCH_PHASE = 'agent-teams.hosted-owner-selected-launch/v1';
export const SELECTED_LAUNCH_MAXIMUM = 256 * 1024;

/** The native launch stage constructs this from its retained inputs and native
 * events. This transport supplies no signer or public-key authority. */
export function encodeSelectedLaunchPhase(launch: Readonly<Record<string, unknown>>, sealed: unknown): Buffer {
  const bytes = Buffer.from(canonicalJson({ contract: SELECTED_LAUNCH_PHASE, launch, sealed }));
  if (bytes.length === 0 || bytes.length > SELECTED_LAUNCH_MAXIMUM) {
    throw new Error('owner_selected_launch_phase_bound');
  }
  const header = Buffer.alloc(8);
  header.writeUInt32BE(0x48534c31, 0); header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

/** Flush exactly one prelude before transferring the same socket to Product.
 * No reply is read: authenticated lifecycle readiness is the phase barrier. */
export async function writeSelectedLaunchPhase(socket: Socket, frame: Buffer,
  deadline: number, signal?: AbortSignal) {
  if (frame.length < 9 || frame.length > SELECTED_LAUNCH_MAXIMUM + 8 ||
    frame.readUInt32BE(0) !== 0x48534c31 || frame.readUInt32BE(4) !== frame.length - 8 ||
    socket.destroyed || !socket.writable || performance.now() >= deadline) {
    throw new Error('owner_selected_launch_phase_write');
  }
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      socket.off('error', failed); socket.off('close', closed);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const failed = () => finish(new Error('owner_selected_launch_phase_io'));
    const closed = () => finish(new Error('owner_selected_launch_phase_closed'));
    const aborted = () => finish(new Error('owner_selected_launch_phase_cancelled'));
    const timer = setTimeout(() => finish(new Error('owner_selected_launch_phase_deadline')),
      Math.max(1, deadline - performance.now()));
    socket.once('error', failed); socket.once('close', closed);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    try { socket.write(frame, error => finish(error ? new Error('owner_selected_launch_phase_io') : undefined)); }
    catch { failed(); }
  });
  return Object.freeze({ contract: SELECTED_LAUNCH_PHASE, byteLength: frame.length,
    sha256: sha256(frame), writtenMonotonicNs: process.hrtime.bigint().toString() });
}
