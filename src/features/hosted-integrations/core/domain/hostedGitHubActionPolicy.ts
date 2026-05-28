import { hostedIntegrationError, throwHostedIntegrationError } from './hostedIntegrationErrors';

import type {
  HostedGitHubActionCommandDto,
  HostedGitHubActionRequestEnvelopeDto,
  HostedGitHubActionRuntimeMemberDto,
} from '../../contracts';

export const HOSTED_GITHUB_ACTION_MARKER = 'agent-teams-action';
export const HOSTED_GITHUB_ACTION_MAX_RAW_BODY_LENGTH = 60_000;
export const HOSTED_GITHUB_ACTION_ATTRIBUTION_RESERVE_LENGTH = 2_000;

export interface AgentGithubActionEnvelopeInput extends HostedGitHubActionCommandDto {
  readonly requestId: string;
}

export function buildTrustedAgentGithubActionEnvelope(
  input: AgentGithubActionEnvelopeInput
): HostedGitHubActionRequestEnvelopeDto {
  assertNonEmpty(input.targetId, 'targetId');
  assertNonEmpty(input.localAttemptId, 'localAttemptId');
  assertNonEmpty(input.requestId, 'requestId');
  assertSafePayload(input.payload);

  const runtimeMember = normalizeRuntimeMember(input.runtimeMember);
  const agentSubjectId = toPolicySubjectId('agent', runtimeMember.agentId);
  const teamSubjectId = toPolicySubjectId('team', runtimeMember.teamId);
  const avatarUrl = normalizeAvatarUrl(runtimeMember.avatarUrl);

  return {
    requestId: input.requestId,
    targetId: input.targetId.trim(),
    actionType: input.actionType,
    requestedBy: {
      subjectKind: 'agent',
      subjectId: agentSubjectId,
      agentId: agentSubjectId,
      teamId: teamSubjectId,
    },
    attribution: {
      agentDisplayName: runtimeMember.agentName,
      ...(avatarUrl ? { agentAvatarUrl: avatarUrl } : {}),
      teamDisplayName: runtimeMember.teamName,
    },
    payload: input.payload,
    ...(input.correlationId?.trim() ? { correlationId: input.correlationId.trim() } : {}),
  };
}

export function createStableGithubActionRequestId(input: {
  readonly localAttemptId: string;
  readonly targetId: string;
  readonly actionType: string;
  readonly payloadFingerprint: string;
}): string {
  const parts = [
    'github-action',
    sanitizeIdPart(input.localAttemptId),
    sanitizeIdPart(input.targetId),
    sanitizeIdPart(input.actionType),
    sanitizeIdPart(input.payloadFingerprint),
  ].filter(Boolean);
  if (parts.length < 5) {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_GITHUB_ACTION_REQUEST_ID_INPUT_INVALID',
        'GitHub action request id input is incomplete.',
        'validation'
      )
    );
  }
  return parts.join(':').slice(0, 180);
}

export function toPolicySubjectId(kind: 'agent' | 'team', rawId: string | undefined): string {
  const normalized = rawId?.trim() || '';
  if (!normalized) {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_GITHUB_ACTION_SUBJECT_ID_REQUIRED',
        'Trusted GitHub action subject id is required.',
        'validation',
        { kind }
      )
    );
  }
  const unprefixed = normalized.startsWith(`${kind}:`)
    ? normalized.slice(kind.length + 1)
    : normalized;
  const safe = sanitizeIdPart(unprefixed);
  if (!safe) {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_GITHUB_ACTION_SUBJECT_ID_INVALID',
        'Trusted GitHub action subject id is invalid.',
        'validation',
        { kind }
      )
    );
  }
  return `${kind}:${safe}`;
}

export function redactHostedIntegrationSecrets(input: string): string {
  return input
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/agtcp_[^\s"']+/g, 'agtcp_[redacted]')
    .replace(/code=[^&\s]+/gi, 'code=[redacted]')
    .replace(/claimContinuationToken["'=:\s]+[^\s"'<>]+/gi, 'claimContinuationToken=[redacted]');
}

function normalizeRuntimeMember(
  input: HostedGitHubActionRuntimeMemberDto
): Required<
  Pick<HostedGitHubActionRuntimeMemberDto, 'agentId' | 'agentName' | 'teamId' | 'teamName'>
> &
  Pick<HostedGitHubActionRuntimeMemberDto, 'avatarUrl' | 'memberName' | 'role'> {
  const agentName = input.agentName?.trim() || input.memberName?.trim();
  const teamName = input.teamName?.trim();
  if (!agentName || !teamName) {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_GITHUB_ACTION_ATTRIBUTION_REQUIRED',
        'Trusted GitHub action attribution is incomplete.',
        'validation'
      )
    );
  }
  const fallbackAgentId = `${agentName}@${teamName}`;
  return {
    agentId: input.agentId?.trim() || fallbackAgentId,
    agentName,
    teamId: input.teamId?.trim() || teamName,
    teamName,
    ...(input.avatarUrl?.trim() ? { avatarUrl: input.avatarUrl.trim() } : {}),
    ...(input.memberName?.trim() ? { memberName: input.memberName.trim() } : {}),
    ...(input.role?.trim() ? { role: input.role.trim() } : {}),
  };
}

function assertSafePayload(payload: unknown): void {
  const text = collectPotentialBodies(payload).join('\n');
  if (text.includes(HOSTED_GITHUB_ACTION_MARKER)) {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_GITHUB_ACTION_RESERVED_MARKER_COLLISION',
        'GitHub action body contains a reserved Agent Teams marker.',
        'validation'
      )
    );
  }
  if (
    text.length + HOSTED_GITHUB_ACTION_ATTRIBUTION_RESERVE_LENGTH >
    HOSTED_GITHUB_ACTION_MAX_RAW_BODY_LENGTH
  ) {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_GITHUB_ACTION_BODY_TOO_LARGE',
        'GitHub action body is too large after attribution overhead.',
        'validation',
        { maxBodyLength: HOSTED_GITHUB_ACTION_MAX_RAW_BODY_LENGTH }
      )
    );
  }
}

function collectPotentialBodies(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(collectPotentialBodies);
  const record = value as Record<string, unknown>;
  return ['body', 'summary', 'text', 'markdown', 'title', 'details'].flatMap((key) =>
    collectPotentialBodies(record[key])
  );
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim()) return;
  throwHostedIntegrationError(
    hostedIntegrationError(
      'HOSTED_GITHUB_ACTION_REQUIRED_FIELD_MISSING',
      'GitHub action request is missing a required field.',
      'validation',
      { field }
    )
  );
}

function normalizeAvatarUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_GITHUB_ACTION_AVATAR_URL_INVALID',
        'Agent avatar URL is invalid.',
        'validation'
      )
    );
  }
  if (parsed.protocol !== 'https:') {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_GITHUB_ACTION_AVATAR_URL_SCHEME_REJECTED',
        'Agent avatar URL must use HTTPS.',
        'security'
      )
    );
  }
  return parsed.href;
}

function sanitizeIdPart(value: string): string {
  return trimHyphens(
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.:@-]+/g, '-')
  );
}

function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}
