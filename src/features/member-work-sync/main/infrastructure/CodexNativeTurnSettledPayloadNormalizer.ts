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

export class CodexNativeTurnSettledPayloadNormalizer implements RuntimeTurnSettledPayloadNormalizerPort {
  constructor(private readonly hash: MemberWorkSyncHashPort) {}

  normalize(input: {
    provider: RuntimeTurnSettledProvider;
    raw: string;
    recordedAt: string;
  }): RuntimeTurnSettledPayloadNormalization {
    if (input.provider !== 'codex') {
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

    const provider = getString(payload, 'provider');
    if (provider !== 'codex') {
      return { ok: false, reason: 'provider_mismatch' };
    }
    const source = getString(payload, 'source');
    if (source !== 'agent-teams-orchestrator-codex-native') {
      return { ok: false, reason: 'source_mismatch' };
    }

    const eventName = getString(payload, 'eventName', 'event_name');
    const hookEventName = getString(payload, 'hookEventName', 'hook_event_name');
    if (eventName !== 'runtime_turn_settled' && hookEventName !== 'Stop') {
      return { ok: false, reason: 'not_turn_settled_event' };
    }

    const sessionId = getString(payload, 'sessionId', 'session_id');
    const teamName = getString(payload, 'teamName', 'team_name');
    const memberName = getString(payload, 'memberName', 'member_name', 'agentName', 'agent_name');
    if (!sessionId) {
      return { ok: false, reason: 'missing_session_identity' };
    }
    if (!teamName || !memberName) {
      return { ok: false, reason: 'missing_team_member_identity' };
    }

    const payloadHash = this.hash.sha256Hex(input.raw);
    const threadId = getString(payload, 'threadId', 'thread_id');
    const turnId = getString(payload, 'turnId', 'turn_id');
    const runtimeInstanceId = getString(payload, 'runtimeInstanceId', 'runtime_instance_id');
    const completedGenerationRaw = payload.completedGeneration ?? payload.completed_generation;
    const completedGeneration =
      typeof completedGenerationRaw === 'number' && Number.isInteger(completedGenerationRaw)
        ? completedGenerationRaw
        : undefined;
    const cwd = getString(payload, 'cwd');
    const agentId = getString(payload, 'agentId', 'agent_id');
    const outcome = getString(payload, 'outcome');
    return {
      ok: true,
      event: {
        schemaVersion: 1,
        provider: 'codex',
        hookEventName: 'Stop',
        payloadHash,
        recordedAt: getString(payload, 'recordedAt', 'recorded_at') ?? input.recordedAt,
        sourceId: buildRuntimeTurnSettledSourceId({
          provider: 'codex',
          sessionId,
          turnId:
            turnId ??
            (runtimeInstanceId && completedGeneration != null
              ? `${runtimeInstanceId}:${completedGeneration}`
              : undefined),
          payloadHash,
        }),
        sessionId,
        ...(turnId ? { turnId } : {}),
        ...(cwd ? { cwd } : {}),
        teamName,
        memberName,
        ...(agentId ? { agentId } : {}),
        ...(threadId ? { threadId } : {}),
        ...(outcome ? { outcome } : {}),
        ...(runtimeInstanceId ? { runtimeInstanceId } : {}),
        ...(completedGeneration != null ? { completedGeneration } : {}),
      },
    };
  }
}
