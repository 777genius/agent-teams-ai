import { Console } from 'node:console';
import { types } from 'node:util';
import { runtimeDigest } from '../runtime/identity.js';

export type RuntimeOpenSource = 'factory' | 'runtime';
export type RuntimeOpenPhase =
  | 'selection' | 'authority' | 'worktree' | 'model-readiness' | 'bindings'
  | 'endpoint' | 'provider-prepare' | 'provider-create' | 'interactions'
  | 'driver-open' | 'driver-wrap' | 'session-ref' | 'publish' | 'observe'
  | 'sealed-close' | 'readiness' | 'readiness-publish';
export type RuntimeOpenCategory =
  | 'invalid' | 'conflict' | 'forbidden' | 'held' | 'busy'
  | 'aborted' | 'deadline' | 'unknown';

const readinessPhases = new Set(['initial-authority', 'read-consumer', 'identity', 'continuation',
  'requirements', 'cutoff', 'reference', 'equality', 'final-authority']);
export interface RuntimeReadinessRefusal {
  readonly phase: 'initial-authority' | 'read-consumer' | 'identity' | 'continuation' |
    'requirements' | 'cutoff' | 'reference' | 'equality' | 'final-authority';
  readonly reason: 'held' | 'threw';
  readonly cutoff: number | null;
  readonly observedAt: number | null;
}

/** Original failed-check scalars only; no clock, authority read or exception inspection. */
export function projectRuntimeReadinessRefusal(value: unknown): RuntimeReadinessRefusal | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return;
    const fields = Object.getOwnPropertyDescriptors(value), keys = ['phase', 'reason', 'cutoff', 'observedAt'];
    if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key =>
      !Object.hasOwn(fields, key) || !fields[key] || !('value' in fields[key]))) return;
    const phase: unknown = fields.phase!.value, reason: unknown = fields.reason!.value;
    const cutoff: unknown = fields.cutoff!.value, observedAt: unknown = fields.observedAt!.value;
    const time = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
    if (typeof phase !== 'string' || !readinessPhases.has(phase) || (reason !== 'held' && reason !== 'threw') ||
        !(cutoff === null && observedAt === null || time(cutoff) && time(observedAt))) return;
    return Object.freeze({ phase: phase as RuntimeReadinessRefusal['phase'], reason,
      cutoff: cutoff as number | null, observedAt: observedAt as number | null });
  } catch { return undefined; }
}

const phases: Record<RuntimeOpenSource, ReadonlySet<RuntimeOpenPhase>> = {
  factory: new Set(['selection', 'authority', 'worktree', 'model-readiness', 'bindings',
    'endpoint', 'provider-prepare', 'provider-create', 'interactions', 'driver-open', 'driver-wrap']),
  runtime: new Set(['authority', 'driver-open', 'session-ref', 'publish', 'observe',
    'sealed-close', 'readiness', 'readiness-publish']),
};
const categories = new Map<string, RuntimeOpenCategory>([
  ['invalid', 'invalid'], ['conflict', 'conflict'], ['forbidden', 'forbidden'],
  ['hold', 'held'], ['held', 'held'], ['busy', 'busy'], ['ABORT_ERR', 'aborted'],
  ['deadline', 'deadline'], ['ETIMEDOUT', 'deadline'],
]);

function ownString(error: unknown, key: 'code' | 'name'): string | undefined {
  if ((!error || typeof error !== 'object') && typeof error !== 'function') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value : undefined;
  } catch { return undefined; }
}
function category(error: unknown): RuntimeOpenCategory {
  const code = ownString(error, 'code');
  if (code !== undefined && categories.has(code)) return categories.get(code)!;
  const name = ownString(error, 'name');
  return name === 'AbortError' ? 'aborted' : name === 'TimeoutError' ? 'deadline' : 'unknown';
}
function writeDefault(line: string): void {
  // A private Console owns this write's error handling; no lasting stderr policy is installed.
  const sink = new Console({
    stdout: process.stderr, stderr: process.stderr, ignoreErrors: true, colorMode: false,
  });
  sink.error(line.slice(0, -1));
}

/** One private refusal observation. Hashing adds bounded work; it grants no execution authority. */
export function createRuntimeOpenDiagnostic(
  selected: { profileId: string; configuration: unknown; source: RuntimeOpenSource },
  write: (line: string) => unknown = writeDefault,
  now: () => number = Date.now
): (phase: RuntimeOpenPhase, error: unknown, readinessRefusal?: unknown) => void {
  let profileHash: string | undefined, configurationHash: string | undefined;
  const source = selected.source;
  try {
    profileHash = runtimeDigest(selected.profileId);
    configurationHash = runtimeDigest(selected.configuration);
  } catch { /* Missing original hashes cannot be replaced with a later configuration. */ }
  let observed = false;
  return (phase, error, readinessRefusal) => {
    if (observed) return;
    observed = true;
    try {
      if (!profileHash || !configurationHash ||
          !(source === 'factory' || source === 'runtime') || !phases[source].has(phase)) return;
      const observedAtMs = now();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) return;
      const detail = source === 'factory' ? projectRuntimeReadinessRefusal(readinessRefusal) : undefined;
      const record = { profileHash, configurationHash, source, phase,
        category: category(error), observedAtMs, ...(detail ? { readinessRefusal: detail } : {}) };
      const line = 'legacy-agent-host: runtime-open ' + JSON.stringify(record) + '\n';
      if (Buffer.byteLength(line, 'utf8') > 8192) return;
      void Promise.resolve(write(line)).catch(() => { /* A diagnostic cannot replace the refusal. */ });
    } catch { /* Preserve the original throw, held publication and cleanup result. */ }
  };
}
