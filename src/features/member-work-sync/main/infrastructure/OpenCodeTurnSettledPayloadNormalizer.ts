import {
  buildRuntimeTurnSettledSourceId,
  type RuntimeTurnSettledProvider,
} from '../../core/domain';

import type {
  MemberWorkSyncHashPort,
  RuntimeTurnSettledPayloadNormalization,
  RuntimeTurnSettledPayloadNormalizerPort,
} from '../../core/application';

const SUPPORTED_SOURCE = 'agent-teams-orchestrator-opencode';

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

function deriveOpenCodeCompletedGeneration(identity: string): number {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class OpenCodeTurnSettledPayloadNormalizer implements RuntimeTurnSettledPayloadNormalizerPort {
  constructor(private readonly hash: MemberWorkSyncHashPort) {}

  normalize(input: {
    provider: RuntimeTurnSettledProvider;
    raw: string;
    recordedAt: string;
  }): RuntimeTurnSettledPayloadNormalization {
    if (input.provider !== 'opencode') {
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
    if (provider !== 'opencode') {
      return { ok: false, reason: 'provider_mismatch' };
    }

    const source = getString(payload, 'source');
    if (source !== SUPPORTED_SOURCE) {
      return { ok: false, reason: 'source_mismatch' };
    }

    const eventName = getString(payload, 'eventName', 'event_name');
    const hookEventName = getString(payload, 'hookEventName', 'hook_event_name');
    if (eventName !== 'runtime_turn_settled' && hookEventName !== 'Stop') {
      return { ok: false, reason: 'not_turn_settled_event' };
    }

    const sessionId = getString(payload, 'sessionId', 'session_id', 'opencodeSessionId');
    const teamName = getString(payload, 'teamName', 'team_name', 'teamId', 'team_id');
    const memberName = getString(payload, 'memberName', 'member_name', 'agentName', 'agent_name');
    if (!sessionId) {
      return { ok: false, reason: 'missing_session_identity' };
    }
    if (!teamName || !memberName) {
      return { ok: false, reason: 'missing_team_member_identity' };
    }

    const payloadHash = this.hash.sha256Hex(input.raw);
    const promptMessageId = getString(
      payload,
      'runtimePromptMessageId',
      'runtime_prompt_message_id',
      'promptMessageId',
      'prompt_message_id'
    );
    const turnId = getString(payload, 'turnId', 'turn_id') ?? promptMessageId;
    const cwd = getString(payload, 'cwd', 'projectPath', 'project_path');
    const agentId = getString(payload, 'agentId', 'agent_id', 'laneId', 'lane_id');
    const outcome = getString(payload, 'outcome');
    const laneId = getString(payload, 'laneId', 'lane_id', 'agentId', 'agent_id');
    const runtimeInstanceId =
      getString(payload, 'runtimeInstanceId', 'runtime_instance_id') ??
      (laneId && sessionId
        ? `opencode:${laneId}:${sessionId}`
        : laneId
          ? `opencode:${laneId}`
          : `opencode:${sessionId}`);
    const completedGenerationRaw = payload.completedGeneration ?? payload.completed_generation;
    const completedGeneration =
      typeof completedGenerationRaw === 'number' && Number.isInteger(completedGenerationRaw)
        ? completedGenerationRaw
        : deriveOpenCodeCompletedGeneration(turnId ?? sessionId);

    return {
      ok: true,
      event: {
        schemaVersion: 1,
        provider: 'opencode',
        hookEventName: 'Stop',
        payloadHash,
        recordedAt:
          getString(payload, 'recordedAt', 'recorded_at', 'observedAt', 'observed_at') ??
          input.recordedAt,
        sourceId: buildRuntimeTurnSettledSourceId({
          provider: 'opencode',
          sessionId,
          turnId,
          payloadHash,
        }),
        sessionId,
        ...(turnId ? { turnId } : {}),
        ...(cwd ? { cwd } : {}),
        teamName,
        memberName,
        ...(agentId ? { agentId } : {}),
        ...(promptMessageId ? { threadId: promptMessageId } : {}),
        ...(outcome ? { outcome } : {}),
        runtimeInstanceId,
        completedGeneration,
      },
    };
  }
}
