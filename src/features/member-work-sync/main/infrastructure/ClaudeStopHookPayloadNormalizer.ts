import {
  buildRuntimeTurnSettledSourceId,
  type RuntimeTurnSettledProvider,
} from '../../core/domain';

import type {
  MemberWorkSyncHashPort,
  RuntimeTurnSettledPayloadNormalization,
  RuntimeTurnSettledPayloadNormalizerPort,
} from '../../core/application';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

export class ClaudeStopHookPayloadNormalizer implements RuntimeTurnSettledPayloadNormalizerPort {
  constructor(private readonly hash: MemberWorkSyncHashPort) {}

  normalize(input: {
    provider: RuntimeTurnSettledProvider;
    raw: string;
    recordedAt: string;
  }): RuntimeTurnSettledPayloadNormalization {
    if (input.provider !== 'claude') {
      return { ok: false, reason: 'unsupported_provider' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(input.raw);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }

    const payload = asRecord(parsed);
    if (!payload) {
      return { ok: false, reason: 'payload_not_object' };
    }

    const hookEventName = getString(payload, 'hook_event_name', 'hookEventName');
    if (hookEventName !== 'Stop') {
      return { ok: false, reason: 'not_stop_hook' };
    }

    const payloadHash = this.hash.sha256Hex(input.raw);
    const event = {
      schemaVersion: 1 as const,
      provider: 'claude' as const,
      hookEventName: 'Stop' as const,
      payloadHash,
      recordedAt: input.recordedAt,
      sourceId: buildRuntimeTurnSettledSourceId({
        provider: 'claude',
        sessionId: getString(payload, 'session_id', 'sessionId'),
        turnId: getString(payload, 'turn_id', 'turnId'),
        transcriptPath: getString(payload, 'transcript_path', 'transcriptPath'),
        payloadHash,
      }),
      sessionId: getString(payload, 'session_id', 'sessionId'),
      turnId: getString(payload, 'turn_id', 'turnId'),
      transcriptPath: getString(payload, 'transcript_path', 'transcriptPath'),
      cwd: getString(payload, 'cwd'),
    };

    if (!event.sessionId && !event.transcriptPath) {
      return { ok: false, reason: 'missing_session_identity' };
    }

    return { ok: true, event };
  }
}
