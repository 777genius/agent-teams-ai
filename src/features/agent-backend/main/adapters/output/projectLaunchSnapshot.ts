import type { BackendLaunchSnapshot } from '../../../contracts/launch';

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid launch');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))
    throw new Error('Invalid launch');
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error('Invalid launch');
  return value as T;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid launch');
  return value;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 256)
    throw new Error('Invalid launch');
  return Number(value);
}
function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 8_640_000_000_000_000)
    throw new Error('Invalid launch timestamp');
  return Number(value);
}

/** Project the authoritative roster, never private native configuration or host incarnation. */
export function projectLaunchSnapshot(value: unknown): BackendLaunchSnapshot {
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw new Error('Oversized launch');
  const source = row(value);
  if (!Array.isArray(source.members) || source.members.length > 256)
    throw new Error('Invalid launch');
  const members = source.members.map((value) => {
    const member = row(value),
      attempt = row(member.attempt),
      memberId = text(member.memberId);
    const binding = member.binding === null ? null : row(member.binding);
    if (binding && binding.memberId !== memberId) throw new Error('Wrong launch member');
    return {
      memberId,
      generation: binding ? text(binding.generation) : null,
      attemptId: text(attempt.attemptId),
      status: choice(attempt.status, [
        'not-started',
        'pending-bootstrap',
        'pending-human',
        'ready',
        'failed',
        'unknown',
        'skipped',
      ] as const),
      nativeReady: boolean(attempt.nativeReady),
      usable: boolean(attempt.usable),
      controlAvailable: boolean(attempt.controlAvailable),
      noAllocation: boolean(attempt.noAllocation),
      reason: choice(attempt.reason, [
        'opening',
        'runtime-unconfigured',
        'observation-unavailable',
        'no-allocation',
        'stopped',
        'binding-mismatch',
        'retained-interaction-unavailable',
        'custody-unresolved',
        'interaction-expired',
        'human-decision',
        'context-applied',
        'bootstrap-timeout',
        'dependency-unavailable',
        'context-unconfirmed',
        'launch-policy',
        'not-started',
      ] as const),
    };
  });
  const expected = count(source.expected),
    ready = count(source.ready);
  if (
    expected !== members.length ||
    ready !== members.filter((member) => member.usable).length ||
    new Set(members.map((member) => member.memberId)).size !== members.length
  )
    throw new Error('Invalid launch roster');
  return {
    launchId: text(source.launchId),
    rosterRevision: text(source.rosterRevision),
    ...(source.observedAtMs === undefined && source.startedAtMs === undefined
      ? {}
      : {
          observedAtMs: timestamp(source.observedAtMs),
          startedAtMs: source.startedAtMs === null ? null : timestamp(source.startedAtMs),
        }),
    status: choice(source.status, ['ready', 'pending', 'partial', 'failed'] as const),
    ready,
    expected,
    retryCapability: choice(source.retryCapability, ['same-binding-no-allocation-only'] as const),
    ...(source.admission === undefined
      ? {}
      : {
          admission: {
            commandId: text(row(source.admission).commandId),
            sourceRosterRevision: text(row(source.admission).sourceRosterRevision),
          },
        }),
    members,
  };
}
