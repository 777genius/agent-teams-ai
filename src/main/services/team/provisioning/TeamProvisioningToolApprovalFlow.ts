import type { ToolApprovalAutoResolved, ToolApprovalTimeoutAction } from '@shared/types';

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

export function buildDenyControlResponsePayload(
  requestId: string,
  message: string
): ToolApprovalControlResponsePayload {
  return buildControlResponsePayload(requestId, { behavior: 'deny', message });
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
