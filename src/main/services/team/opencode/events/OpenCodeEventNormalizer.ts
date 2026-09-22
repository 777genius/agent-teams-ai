export type OpenCodeEventScope = 'instance' | 'global';

export type OpenCodeNormalizedStatusType = 'idle' | 'busy' | 'retry' | 'error' | 'unknown';

export interface OpenCodeNormalizedSessionStatus {
  type: OpenCodeNormalizedStatusType;
  retryAttempt: number | null;
  retryMessage: string | null;
  retryNextAt: number | null;
  rawShape: 'v1.14' | 'legacy-string' | 'unknown';
  raw: unknown;
}

export type OpenCodeDurableSessionState =
  | 'idle'
  | 'running'
  | 'retrying'
  | 'blocked'
  | 'reply_pending'
  | 'error'
  | 'unknown';

export type OpenCodeNormalizedEvent =
  | {
      kind: 'server_connected' | 'server_heartbeat';
      scope: OpenCodeEventScope;
      directory: string | null;
      raw: unknown;
    }
  | {
      kind: 'session_status';
      sessionId: string;
      status: OpenCodeNormalizedSessionStatus;
      scope: OpenCodeEventScope;
      directory: string | null;
      raw: unknown;
    }
  | {
      kind: 'session_error';
      sessionId: string | null;
      errorName: string | null;
      errorMessage: string | null;
      scope: OpenCodeEventScope;
      directory: string | null;
      raw: unknown;
    }
  | {
      kind: 'message_updated';
      sessionId: string;
      messageId: string | null;
      role: 'assistant' | 'user' | 'system' | 'unknown';
      info: Record<string, unknown>;
      scope: OpenCodeEventScope;
      directory: string | null;
      raw: unknown;
    }
  | {
      kind: 'message_part_updated';
      sessionId: string;
      messageId: string | null;
      partId: string | null;
      partType: string | null;
      textSnapshot: string | null;
      part: Record<string, unknown>;
      scope: OpenCodeEventScope;
      directory: string | null;
      raw: unknown;
    }
  | {
      kind: 'message_part_delta';
      sessionId: string;
      messageId: string;
      partId: string;
      field: string;
      delta: string;
      scope: OpenCodeEventScope;
      directory: string | null;
      raw: unknown;
    }
  | {
      kind: 'message_part_removed';
      sessionId: string;
      messageId: string;
      partId: string;
      scope: OpenCodeEventScope;
      directory: string | null;
      raw: unknown;
    }
  | {
      kind: 'permission_asked' | 'permission_replied';
      sessionId: string | null;
      requestId: string | null;
      scope: OpenCodeEventScope;
      directory: string | null;
      raw: unknown;
    }
  | {
      kind: 'unknown';
      type: string;
      scope: OpenCodeEventScope;
      directory: string | null;
      raw: unknown;
    };

export interface OpenCodeSseEventEnvelope {
  type: string;
  properties: Record<string, unknown>;
  scope: OpenCodeEventScope;
  directory: string | null;
  raw: unknown;
}

export interface OpenCodeDurableStateProjection {
  hasPendingPermission: boolean;
  hasLatestAssistantError: boolean;
  replyPendingSinceMessageId: string | null;
}

export function normalizeOpenCodeSessionStatus(raw: unknown): OpenCodeNormalizedSessionStatus {
  if (typeof raw === 'string') {
    return {
      type: normalizeLegacyStatusType(raw),
      retryAttempt: null,
      retryMessage: null,
      retryNextAt: null,
      rawShape: 'legacy-string',
      raw,
    };
  }

  const record = asRecord(raw);
  const statusType = asString(record?.type);
  if (
    statusType === 'idle' ||
    statusType === 'busy' ||
    statusType === 'retry' ||
    statusType === 'error'
  ) {
    return {
      type: statusType,
      retryAttempt: asNumber(record?.attempt),
      retryMessage: asString(record?.message),
      retryNextAt: asNumber(record?.next),
      rawShape: 'v1.14',
      raw,
    };
  }

  return {
    type: 'unknown',
    retryAttempt: null,
    retryMessage: null,
    retryNextAt: null,
    rawShape: 'unknown',
    raw,
  };
}

export function mapOpenCodeStatusToDurableState(
  status: OpenCodeNormalizedSessionStatus | null,
  projection: OpenCodeDurableStateProjection
): OpenCodeDurableSessionState {
  if (projection.hasPendingPermission) {
    return 'blocked';
  }
  if (projection.hasLatestAssistantError || status?.type === 'error') {
    return 'error';
  }
  if (status?.type === 'retry') {
    return 'retrying';
  }
  if (status?.type === 'busy') {
    return 'running';
  }
  if (projection.replyPendingSinceMessageId) {
    return 'reply_pending';
  }
  if (status?.type === 'idle') {
    return 'idle';
  }
  return 'unknown';
}

export function unwrapOpenCodeEventEnvelope(raw: unknown): OpenCodeSseEventEnvelope | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const directType = asString(record.type);
  if (directType) {
    return {
      type: directType,
      properties: asRecord(record.properties) ?? {},
      scope: 'instance',
      directory: null,
      raw,
    };
  }

  const payload = asRecord(record.payload);
  const payloadType = asString(payload?.type);
  if (!payloadType) {
    return null;
  }

  return {
    type: payloadType,
    properties: asRecord(payload?.properties) ?? {},
    scope: 'global',
    directory: asString(record.directory),
    raw,
  };
}

export function normalizeOpenCodeEvent(raw: unknown): OpenCodeNormalizedEvent | null {
  const event = unwrapOpenCodeEventEnvelope(raw);
  if (!event) {
    return null;
  }

  const props = event.properties;

  if (event.type === 'server.connected' || event.type === 'server.heartbeat') {
    return {
      kind: event.type === 'server.connected' ? 'server_connected' : 'server_heartbeat',
      scope: event.scope,
      directory: event.directory,
      raw,
    };
  }

  if (event.type === 'session.status') {
    const sessionId = asString(props.sessionID) ?? asString(props.sessionId);
    if (!sessionId) {
      return unknownEvent(event);
    }
    return {
      kind: 'session_status',
      sessionId,
      status: normalizeOpenCodeSessionStatus(props.status),
      scope: event.scope,
      directory: event.directory,
      raw,
    };
  }

  if (event.type === 'session.idle') {
    const sessionId = asString(props.sessionID) ?? asString(props.sessionId);
    if (!sessionId) {
      return unknownEvent(event);
    }
    return {
      kind: 'session_status',
      sessionId,
      status: normalizeOpenCodeSessionStatus({ type: 'idle' }),
      scope: event.scope,
      directory: event.directory,
      raw,
    };
  }

  if (event.type === 'session.error') {
    const error = asRecord(props.error);
    return {
      kind: 'session_error',
      sessionId: asString(props.sessionID) ?? asString(props.sessionId),
      errorName: asString(error?.name) ?? asString(props.name),
      errorMessage: asString(error?.message) ?? asString(props.message),
      scope: event.scope,
      directory: event.directory,
      raw,
    };
  }

  if (event.type === 'message.updated') {
    const info = asRecord(props.info) ?? {};
    const sessionId =
      asString(props.sessionID) ?? asString(props.sessionId) ?? asString(info.sessionID);
    if (!sessionId) {
      return unknownEvent(event);
    }
    return {
      kind: 'message_updated',
      sessionId,
      messageId: asString(info.id) ?? asString(info.messageID),
      role: normalizeMessageRole(asString(info.role)),
      info,
      scope: event.scope,
      directory: event.directory,
      raw,
    };
  }

  if (event.type === 'message.part.updated') {
    const part = asRecord(props.part) ?? {};
    const sessionId =
      asString(props.sessionID) ?? asString(props.sessionId) ?? asString(part.sessionID);
    if (!sessionId) {
      return unknownEvent(event);
    }
    return {
      kind: 'message_part_updated',
      sessionId,
      messageId: asString(part.messageID) ?? asString(part.messageId),
      partId: asString(part.id) ?? asString(part.partID) ?? asString(part.partId),
      partType: asString(part.type),
      textSnapshot: asStringAllowEmpty(part.text),
      part,
      scope: event.scope,
      directory: event.directory,
      raw,
    };
  }

  if (event.type === 'message.part.delta') {
    const sessionId = asString(props.sessionID) ?? asString(props.sessionId);
    const messageId = asString(props.messageID) ?? asString(props.messageId);
    const partId = asString(props.partID) ?? asString(props.partId);
    const field = asString(props.field);
    const delta = asStringAllowEmpty(props.delta);
    if (!sessionId || !messageId || !partId || !field || delta === null) {
      return unknownEvent(event);
    }
    return {
      kind: 'message_part_delta',
      sessionId,
      messageId,
      partId,
      field,
      delta,
      scope: event.scope,
      directory: event.directory,
      raw,
    };
  }

  if (event.type === 'message.part.removed') {
    const sessionId = asString(props.sessionID) ?? asString(props.sessionId);
    const messageId = asString(props.messageID) ?? asString(props.messageId);
    const partId = asString(props.partID) ?? asString(props.partId);
    if (!sessionId || !messageId || !partId) {
      return unknownEvent(event);
    }
    return {
      kind: 'message_part_removed',
      sessionId,
      messageId,
      partId,
      scope: event.scope,
      directory: event.directory,
      raw,
    };
  }

  if (event.type === 'permission.asked' || event.type === 'permission.replied') {
    return {
      kind: event.type === 'permission.asked' ? 'permission_asked' : 'permission_replied',
      sessionId: asString(props.sessionID) ?? asString(props.sessionId),
      requestId: asString(props.id) ?? asString(props.requestID) ?? asString(props.requestId),
      scope: event.scope,
      directory: event.directory,
      raw,
    };
  }

  return unknownEvent(event);
}

function normalizeLegacyStatusType(raw: string): OpenCodeNormalizedStatusType {
  if (raw === 'active') {
    return 'busy';
  }
  if (raw === 'idle' || raw === 'busy' || raw === 'retry' || raw === 'error') {
    return raw;
  }
  return 'unknown';
}

function normalizeMessageRole(role: string | null): 'assistant' | 'user' | 'system' | 'unknown' {
  if (role === 'assistant' || role === 'user' || role === 'system') {
    return role;
  }
  return 'unknown';
}

function unknownEvent(event: OpenCodeSseEventEnvelope): OpenCodeNormalizedEvent {
  return {
    kind: 'unknown',
    type: event.type,
    scope: event.scope,
    directory: event.directory,
    raw: event.raw,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asStringAllowEmpty(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
