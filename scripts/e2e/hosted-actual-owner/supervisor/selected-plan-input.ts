import { Socket } from 'node:net';
import type { SupervisorPlan } from '../processes';
import { canonicalJson } from './canonical';

export const SELECTED_PLAN_MAXIMUM_BYTES = 4 * 1024 * 1024;

/** Consume the existing inherited FD3 plan once, with bounded bytes and time.
 * A decoded plan is untrusted until selected-plan-admission verifies its signed
 * documents against the executable's independently provisioned public roots. */
export async function readSelectedSupervisorPlan(signal: AbortSignal): Promise<SupervisorPlan> {
  signal.throwIfAborted();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  // The selected Linux Node parent supplies a Unix socketpair for stdio[3],
  // like the existing native launch transport. Socket I/O keeps cancellation
  // off a potentially blocked filesystem worker thread.
  const stream = new Socket({ fd: 3, readable: true, writable: false });
  const aborted = () => stream.destroy(new Error('selected_supervisor_plan_cancelled'));
  bounded.addEventListener('abort', aborted, { once: true });
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const part of stream) {
      const bytes = Buffer.from(part as Buffer);
      length += bytes.length;
      if (length > SELECTED_PLAN_MAXIMUM_BYTES) throw new Error('selected_supervisor_plan_bound');
      chunks.push(bytes);
    }
    bounded.throwIfAborted();
    const bytes = Buffer.concat(chunks, length);
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value) || canonicalJson(value) !== source) {
      throw new Error('selected_supervisor_plan_canonical');
    }
    const row = value as Record<string, unknown>;
    if (row.schemaVersion !== 2 || row.protocol !== 'agent-teams.p3c.supervisor-transcript/v1' ||
      !row.supervisorSourceInvocation || !row.supervisorAdmissionDescriptor || !row.supervisorPublicArtifacts) {
      throw new Error('selected_supervisor_plan_native_selection');
    }
    // Structural decoding is not admission. The only launch-eligible receipt
    // comes from admitSelectedSupervisorPlan, never from this cast or FD3.
    return value as SupervisorPlan;
  } finally {
    bounded.removeEventListener('abort', aborted);
    stream.destroy();
  }
}
