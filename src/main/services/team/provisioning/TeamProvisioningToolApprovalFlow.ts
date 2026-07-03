import type {
  ToolApprovalAutoResolved,
  ToolApprovalRequest,
  ToolApprovalTimeoutAction,
} from '@shared/types';

export const TOOL_APPROVAL_TIMEOUT_CONTROL_DENY_MESSAGE = 'Timed out — auto-denied by settings';
export const TOOL_APPROVAL_TIMEOUT_TEAMMATE_DENY_MESSAGE = 'Timed out - auto-denied by settings';

export interface ToolApprovalControlResponsePayload {
  type: 'control_response';
  response: {
    subtype: 'success';
    request_id: string;
    response: Record<string, unknown>;
  };
}

export interface ToolApprovalAutoResolvedEventInput {
  requestId: string;
  runId: string;
  teamName: string;
  reason: ToolApprovalAutoResolved['reason'];
}

export interface ToolApprovalTimeoutAutoResolutionInput {
  timeoutAction: ToolApprovalTimeoutAction;
  requestId: string;
  runId: string;
  teamName: string;
}

export interface ToolApprovalTimeoutAutoResolution {
  allow: boolean;
  event: ToolApprovalAutoResolved;
  teammateDenyMessage?: string;
}

export interface LeadToolApprovalRequestInput {
  requestId: string;
  runId: string;
  teamName: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  teamColor?: string;
  teamDisplayName?: string;
  providerId?: ToolApprovalRequest['providerId'];
  receivedAt?: string;
}

export interface TeammateToolApprovalRequestInput {
  requestId: string;
  runId: string;
  teamName: string;
  source: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  teamColor?: string;
  teamDisplayName?: string;
  permissionSuggestions?: ToolApprovalRequest['permissionSuggestions'];
  receivedAt?: string;
}

export interface LeadToolApprovalDecisionPayloadInput {
  requestId: string;
  approval: Pick<ToolApprovalRequest, 'toolName' | 'toolInput'>;
  allow: boolean;
  message?: string;
}

export interface ToolApprovalNotificationSettingsSnapshot {
  enabled: boolean;
  notifyOnToolApproval: boolean;
  soundEnabled: boolean;
  snoozedUntil?: number | null;
}

export interface ToolApprovalNotificationPlanInput {
  approval: ToolApprovalRequest;
  notifications: ToolApprovalNotificationSettingsSnapshot;
  isWindowFocused: boolean;
  isNotificationSupported: boolean;
  platform: NodeJS.Platform;
  teamLabel?: string;
  iconPath?: string;
  nowMs?: number;
}

export interface ToolApprovalNotificationPlan {
  title: string;
  body: string;
  sound?: 'default';
  icon?: string;
  supportsActions: boolean;
}

export function buildLeadToolApprovalRequest(
  input: LeadToolApprovalRequestInput
): ToolApprovalRequest {
  return {
    requestId: input.requestId,
    runId: input.runId,
    teamName: input.teamName,
    ...(input.providerId ? { providerId: input.providerId } : {}),
    source: 'lead',
    toolName: input.toolName,
    toolInput: input.toolInput,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    teamColor: input.teamColor,
    teamDisplayName: input.teamDisplayName,
  };
}

export function buildTeammateToolApprovalRequest(
  input: TeammateToolApprovalRequestInput
): ToolApprovalRequest {
  return {
    requestId: input.requestId,
    runId: input.runId,
    teamName: input.teamName,
    source: input.source,
    toolName: input.toolName,
    toolInput: input.toolInput,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    teamColor: input.teamColor,
    teamDisplayName: input.teamDisplayName,
    permissionSuggestions:
      input.permissionSuggestions && input.permissionSuggestions.length > 0
        ? input.permissionSuggestions
        : undefined,
  };
}

export function formatToolApprovalBody(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  switch (toolName) {
    case 'AskUserQuestion':
      return formatAskUserQuestionApprovalBody(toolInput);
    case 'Bash':
      return `Bash: ${typeof toolInput.command === 'string' ? toolInput.command.slice(0, 150) : 'command'}`;
    case 'Write':
    case 'Edit':
    case 'Read':
    case 'NotebookEdit':
      return `${toolName}: ${typeof toolInput.file_path === 'string' ? toolInput.file_path : 'file'}`;
    default:
      return `${toolName}: ${JSON.stringify(toolInput).slice(0, 150)}`;
  }
}

export function formatAskUserQuestionApprovalBody(toolInput: Record<string, unknown>): string {
  const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  const questions = rawQuestions
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const question =
        'question' in item && typeof item.question === 'string' ? item.question.trim() : null;
      return question && question.length > 0 ? question.replace(/\s+/g, ' ') : null;
    })
    .filter((question): question is string => Boolean(question));

  if (questions.length === 0) {
    return 'Question: User input is required';
  }

  const firstQuestion = questions[0];
  const truncatedQuestion =
    firstQuestion.length > 140 ? `${firstQuestion.slice(0, 137)}...` : firstQuestion;

  return questions.length === 1
    ? `Question: ${truncatedQuestion}`
    : `Questions (${questions.length}): ${truncatedQuestion}`;
}

export function buildAllowControlResponsePayload(
  requestId: string,
  response: Record<string, unknown> = { behavior: 'allow', updatedInput: {} }
): ToolApprovalControlResponsePayload {
  return buildControlResponsePayload(requestId, response);
}

export function buildLeadToolApprovalDecisionPayload(
  input: LeadToolApprovalDecisionPayloadInput
): ToolApprovalControlResponsePayload {
  if (!input.allow) {
    return buildDenyControlResponsePayload(input.requestId, input.message ?? 'User denied');
  }

  return buildAllowControlResponsePayload(
    input.requestId,
    buildLeadToolApprovalAllowResponse(input.approval, input.message)
  );
}

export function buildLeadToolApprovalAllowResponse(
  approval: Pick<ToolApprovalRequest, 'toolName' | 'toolInput'>,
  message?: string
): Record<string, unknown> {
  const response: Record<string, unknown> = { behavior: 'allow', updatedInput: {} };
  if (approval.toolName !== 'AskUserQuestion' || !message) {
    return response;
  }

  response.updatedInput = buildAskUserQuestionUpdatedInput(approval.toolInput, message);
  return response;
}

export function buildDenyControlResponsePayload(
  requestId: string,
  message: string
): ToolApprovalControlResponsePayload {
  return buildControlResponsePayload(requestId, { behavior: 'deny', message });
}

export function buildTeammatePermissionUpdatedInput(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  message: string | undefined
): Record<string, unknown> | undefined {
  if (!toolInput) return undefined;
  if (toolName !== 'AskUserQuestion' || message === undefined) return toolInput;

  const answers = parseAskUserQuestionAnswers(message, toolInput);
  return Object.keys(answers).length > 0 ? { ...toolInput, answers } : toolInput;
}

export function parseAskUserQuestionAnswers(
  message: string,
  toolInput: Record<string, unknown>
): Record<string, string> {
  try {
    const parsed = JSON.parse(message) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      );
    }
  } catch {
    // Fall back to using the raw message as the first answer.
  }

  const questions = Array.isArray(toolInput.questions)
    ? (toolInput.questions as { question?: unknown }[])
    : [];
  const firstQuestion = questions.find((question) => typeof question.question === 'string');
  return typeof firstQuestion?.question === 'string' ? { [firstQuestion.question]: message } : {};
}

export function buildToolApprovalAutoResolvedEvent(
  input: ToolApprovalAutoResolvedEventInput
): ToolApprovalAutoResolved {
  return {
    autoResolved: true,
    requestId: input.requestId,
    runId: input.runId,
    teamName: input.teamName,
    reason: input.reason,
  };
}

export function resolveToolApprovalTimeoutAutoResolution(
  input: ToolApprovalTimeoutAutoResolutionInput
): ToolApprovalTimeoutAutoResolution | null {
  if (input.timeoutAction === 'wait') {
    return null;
  }

  const allow = input.timeoutAction === 'allow';
  return {
    allow,
    event: buildToolApprovalAutoResolvedEvent({
      requestId: input.requestId,
      runId: input.runId,
      teamName: input.teamName,
      reason: allow ? 'timeout_allow' : 'timeout_deny',
    }),
    ...(allow ? {} : { teammateDenyMessage: TOOL_APPROVAL_TIMEOUT_TEAMMATE_DENY_MESSAGE }),
  };
}

export function planToolApprovalNotification(
  input: ToolApprovalNotificationPlanInput
): ToolApprovalNotificationPlan | null {
  if (input.isWindowFocused) return null;
  if (!input.notifications.enabled || !input.notifications.notifyOnToolApproval) return null;
  const snoozedUntil = input.notifications.snoozedUntil;
  if (snoozedUntil && (input.nowMs ?? Date.now()) < snoozedUntil) return null;
  if (!input.isNotificationSupported) return null;

  const teamLabel = input.teamLabel ?? input.approval.teamDisplayName ?? input.approval.teamName;
  const supportsActions = input.platform !== 'linux';
  return {
    title: `Tool Approval — ${teamLabel}`,
    body: formatToolApprovalBody(input.approval.toolName, input.approval.toolInput),
    ...(input.notifications.soundEnabled ? { sound: 'default' as const } : {}),
    ...(input.iconPath ? { icon: input.iconPath } : {}),
    supportsActions,
  };
}

function buildAskUserQuestionUpdatedInput(
  toolInput: Record<string, unknown>,
  message: string
): Record<string, unknown> {
  try {
    const answers = JSON.parse(message) as Record<string, string>;
    return { ...toolInput, answers };
  } catch {
    const questions = (toolInput.questions as { question?: string }[]) ?? [];
    const answers: Record<string, string> = {};
    if (questions[0]?.question) answers[questions[0].question] = message;
    return { ...toolInput, answers };
  }
}

function buildControlResponsePayload(
  requestId: string,
  response: Record<string, unknown>
): ToolApprovalControlResponsePayload {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response,
    },
  };
}
