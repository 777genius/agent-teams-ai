type StructuredAgentMessage = Record<string, unknown>;

const NOISE_TYPES = new Set([
  'idle_notification',
  'shutdown_approved',
  'teammate_terminated',
  'shutdown_request',
]);

const TYPE_LABELS: Record<string, string> = {
  idle_notification: 'Idle',
  shutdown_approved: 'Shutdown confirmed',
  teammate_terminated: 'Terminated',
  shutdown_request: 'Shutdown requested',
  shutdown_response: 'Shutdown response',
  message: 'Message',
  broadcast: 'Broadcast',
};

export function parseStructuredAgentMessage(content: string): StructuredAgentMessage | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as StructuredAgentMessage;
    }
  } catch {
    return null;
  }

  return null;
}

export function getMessageTypeLabel(type: string | null): string | null {
  if (!type) {
    return null;
  }
  return TYPE_LABELS[type] ?? type;
}

function getStringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function detectOperationalNoise(content: string, teammateId: string): string | null {
  const trimmed = content.trim();
  const parsed = parseStructuredAgentMessage(trimmed);
  const type = getStringField(parsed?.type);

  if (type && NOISE_TYPES.has(type)) {
    const message = getStringField(parsed?.message);
    return message ?? getMessageTypeLabel(type) ?? type;
  }

  if (teammateId === 'system') {
    return trimmed.length < 200 ? trimmed : null;
  }

  return null;
}

export function getStructuredMessageSummary(parsed: StructuredAgentMessage): string {
  const explicitSummary = getStringField(parsed.summary);
  if (explicitSummary) {
    return explicitSummary;
  }

  const message = getStringField(parsed.message);
  if (message) {
    return message;
  }

  const type = getStringField(parsed.type);
  return getMessageTypeLabel(type) ?? 'Structured message';
}
