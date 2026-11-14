import { createHash } from 'node:crypto';

import { createLogger } from '@shared/utils/logger';

let startupProbeCount = 0;
export const observeCapturedHostStartup = (
  phase:
    | 'profile-validation-start'
    | 'profile-validation-complete'
    | 'child-captured'
    | 'ready'
    | 'request-timeout'
    | 'request-admitted'
    | 'response-accepted'
    | 'owner-start'
    | 'owner-started'
    | 'read-start'
    | 'read-complete',
  kind: 'handshake' | 'rpc' | 'registry-list' | 'retirement-read' = 'handshake'
): void => {
  if (process.env.LEGACY_DESKTOP_STARTUP_DIAGNOSTICS !== '1' || startupProbeCount >= 128) return;
  startupProbeCount++;
  try {
    createLogger('TEST:HostStartup').diagnostic('Host startup observation', {
      phase,
      kind,
      observation: startupProbeCount,
      elapsedMs: Math.round(performance.now()),
    });
  } catch {
    /* Passive diagnostics cannot change transport outcomes. */
  }
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function valueType(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return typeof value;
  return typeof value === 'object' ? 'object' : 'invalid';
}

function cardinality(count: number): 0 | 1 | 'multiple' {
  return count === 0 ? 0 : count === 1 ? 1 : 'multiple';
}

function fields(value: unknown, known: readonly string[]): {
  type: string;
  known: Record<string, string> | null;
  unknownKeys: 0 | 1 | 'multiple' | null;
} {
  const object = record(value);
  return {
    type: valueType(value),
    known: object
      ? Object.fromEntries(
          known.map((key) => [
            key,
            valueType(Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined),
          ])
        )
      : null,
    unknownKeys: object
      ? cardinality(Object.keys(object).filter((key) => !known.includes(key)).length)
      : null,
  };
}

function digest(value: unknown): string | null {
  const serialized = JSON.stringify(value);
  return serialized === undefined
    ? null
    : createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/** Failure-only projection of the already bounded original transport frame. */
export function observeCapturedRosterRejection(frame: Buffer): void {
  try {
    const raw: unknown = JSON.parse(frame.toString('utf8'));
    const wire = record(raw);
    const params = record(wire?.params);
    const payload = record(params?.payload);
    const binding = record(params?.binding);
    const liveRoster = record(params?.liveRoster);
    const phase = liveRoster?.phase;
    const remainingMs = liveRoster?.remainingMs;
    const observation = {
      tag: 'HOST_ROSTER_REJECTED_WIRE',
      hashes: {
        frame: createHash('sha256').update(frame).digest('hex'),
        params: digest(wire?.params),
        payload: digest(params?.payload),
        commandId: digest(params?.commandId),
        binding: digest(params?.binding),
        owner: digest(binding?.owner),
        scope: digest(binding?.scope),
      },
      fields: {
        params: fields(wire?.params, [
          'commandId', 'binding', 'payload', 'liveRoster', 'localModelReadinessOrigin',
          'localModelReadinessTransfer', 'localModelReadinessCapture',
        ]),
        payload: fields(params?.payload, [
          'expectedRevision', 'members', 'savedSettings', 'memberSettingsRelaunch',
        ]),
        savedSettings: fields(payload?.savedSettings, [
          'runtimeSelectionVersion', 'cwd', 'displayName', 'description', 'color', 'prompt',
          'providerId', 'providerBackendId', 'model', 'effort', 'fastMode', 'syncModelsWithLead',
          'limitContext', 'skipPermissions', 'worktree', 'extraCliArgs',
          'allowExperimentalLocalModels',
        ]),
        binding: fields(params?.binding, ['schemaVersion', 'handleId', 'owner', 'scope']),
        owner: fields(binding?.owner, [
          'ownerId', 'revision', 'storageRoot', 'profileId', 'protocolVersion', 'buildId',
          'nodeSha256', 'hostEntrySha256',
        ]),
        scope: fields(binding?.scope, [
          'projectId', 'workspaceId', 'teamId', 'runId', 'memberId', 'generation',
        ]),
        liveRoster: fields(params?.liveRoster, ['phase', 'remainingMs', 'captureDigest']),
      },
      members:
        payload && Array.isArray(payload.members) ? cardinality(payload.members.length) : null,
      liveRoster: {
        phase:
          phase === undefined
            ? 'absent'
            : phase === 'capture' || phase === 'continue' || phase === 'read'
              ? phase
              : 'invalid',
        remainingMs: {
          present: !!liveRoster && Object.prototype.hasOwnProperty.call(liveRoster, 'remainingMs'),
          type: valueType(remainingMs),
          integer: typeof remainingMs === 'number' && Number.isInteger(remainingMs),
          inRange: typeof remainingMs === 'number' && remainingMs >= 1 && remainingMs <= 100_000,
        },
      },
    };
    const serialized = JSON.stringify(observation);
    if (Buffer.byteLength(serialized, 'utf8') <= 4096)
      createLogger('TEST:HostRosterWire').error(serialized);
  } catch {
    /* Passive diagnostics cannot change transport outcomes. */
  }
}
