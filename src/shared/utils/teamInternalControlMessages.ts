const NATIVE_APP_MANAGED_BOOTSTRAP_CHECK_OPEN = '<agent_teams_native_app_managed_bootstrap_check>';
const NATIVE_APP_MANAGED_BOOTSTRAP_CHECK_CLOSE =
  '</agent_teams_native_app_managed_bootstrap_check>';
const NATIVE_BOOTSTRAP_CONTROL_OPEN = '<agent_teams_native_bootstrap_control>';
const LEAD_INBOX_RELAY_PROMPT_OPEN = 'You have new inbox messages addressed to you (team lead ';
const TEAMMATE_MESSAGE_OPEN_RE = /^<teammate-message\s/i;

const INTERNAL_CONTROL_MESSAGE_SOURCES = new Set([
  'lead_process',
  'lead_session',
  'runtime_delivery',
  'system_notification',
]);
const INTERNAL_BOOTSTRAP_AUTHORS = new Set(['team-lead', 'lead', 'orchestrator']);

export function stripTranscriptSpeakerPrefix(value: string): string {
  let normalized = value.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = normalized.replace(/^(?:Human|User):\s*/i, '').trimStart();
    if (next === normalized) break;
    normalized = next;
  }
  return normalized;
}

export function isTranscriptSpeakerPlaceholderText(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return /^(?:(?:Human|User):\s*)+$/i.test(trimmed);
}

export function isNativeAppManagedBootstrapCheckText(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    stripTranscriptSpeakerPrefix(value).startsWith(NATIVE_APP_MANAGED_BOOTSTRAP_CHECK_OPEN)
  );
}

export function buildNativeAppManagedBootstrapCheckText(): string {
  return [NATIVE_APP_MANAGED_BOOTSTRAP_CHECK_OPEN, NATIVE_APP_MANAGED_BOOTSTRAP_CHECK_CLOSE].join(
    '\n'
  );
}

export function isNativeBootstrapControlText(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const text = stripTranscriptSpeakerPrefix(value);
  return (
    text.startsWith(NATIVE_APP_MANAGED_BOOTSTRAP_CHECK_OPEN) ||
    text.startsWith(NATIVE_BOOTSTRAP_CONTROL_OPEN)
  );
}

export function isLeadInboxRelayControlPromptText(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const text = stripTranscriptSpeakerPrefix(value);
  return (
    text.startsWith(LEAD_INBOX_RELAY_PROMPT_OPEN) &&
    text.includes('Process them in order (oldest first).') &&
    text.includes('\nMessages:')
  );
}

export function isTeammateProtocolControlText(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  return TEAMMATE_MESSAGE_OPEN_RE.test(stripTranscriptSpeakerPrefix(value));
}

export function isTeamInternalControlMessageText(value: unknown): boolean {
  return (
    isTranscriptSpeakerPlaceholderText(value) ||
    isNativeBootstrapControlText(value) ||
    isLeadInboxRelayControlPromptText(value) ||
    isTeammateProtocolControlText(value)
  );
}

export function isTeamInternalControlMessageEnvelope(message: {
  text?: unknown;
  source?: unknown;
  from?: unknown;
}): boolean {
  if (isNativeBootstrapControlText(message.text)) {
    if (typeof message.source === 'string') {
      return INTERNAL_CONTROL_MESSAGE_SOURCES.has(message.source);
    }
    return (
      typeof message.from === 'string' &&
      INTERNAL_BOOTSTRAP_AUTHORS.has(message.from.trim().toLowerCase())
    );
  }
  if (!isTeamInternalControlMessageText(message.text)) {
    return false;
  }
  return typeof message.source === 'string' && INTERNAL_CONTROL_MESSAGE_SOURCES.has(message.source);
}

export function stripExactInternalControlEchoPrefix(
  value: string,
  expectedControlText: string
): string {
  const text = stripTranscriptSpeakerPrefix(value);
  const expected = stripTranscriptSpeakerPrefix(expectedControlText);
  if (!expected || !text.startsWith(expected)) {
    return value.trim();
  }
  return text.slice(expected.length).trim();
}
