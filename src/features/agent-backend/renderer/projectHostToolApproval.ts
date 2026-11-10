import type { BackendActivitySnapshot, BackendOperationPayloads } from '../contracts/operations';
import type { ToolApprovalRequest } from '@shared/types/team';

export interface HostPendingInteraction {
  interactionRef: string;
  inputId: string;
  kind: 'permission' | 'question';
  expiresAt: number;
  toolName: string;
  toolInput: Record<string, unknown>;
}

function data(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== 'string' || !('value' in descriptors[key])
    )
  )
    return undefined;
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
  );
}

function renderableQuestions(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 100 &&
    value.every((item) => {
      const question = data(item);
      if (
        !question ||
        typeof question.question !== 'string' ||
        !question.question ||
        question.question.length > 256 ||
        (question.header !== undefined && typeof question.header !== 'string') ||
        (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') ||
        !Array.isArray(question.options) ||
        question.options.length > 64
      )
        return false;
      return question.options.every((value) => {
        const option = data(value);
        return (
          option &&
          typeof option.label === 'string' &&
          option.label.length > 0 &&
          (option.description === undefined || typeof option.description === 'string')
        );
      });
    })
  );
}

/** Normalized Host content is joined only to its exact currently pending Runtime fact. */
export function pendingHostToolInteractions(
  snapshot: BackendActivitySnapshot,
  now: number
): HostPendingInteraction[] {
  const state = snapshot.state;
  if (
    !state ||
    (snapshot.gap && !['retention', 'incarnation', 'cursor'].includes(snapshot.gap.reason)) ||
    state.sealed ||
    state.phase !== 'allocated' ||
    state.custody !== 'owned' ||
    state.control
  )
    return [];
  return state.interactions.flatMap((fact) => {
    if (fact.phase !== 'pending' || fact.expiresAt <= now) return [];
    const matching = snapshot.latest.interactions.filter(
      (event) =>
        event.inputId === fact.inputId &&
        event.data.kind === 'interaction' &&
        event.data.interactionRef === fact.interactionRef
    );
    if (matching.length !== 1) return [];
    const event = matching[0];
    if (event.data.kind !== 'interaction' || event.data.request.kind !== fact.kind) return [];
    const request = event.data.request;
    if (request.kind === 'question' && !renderableQuestions(request.questions)) return [];
    if (request.kind === 'permission' && request.tool === 'AskUserQuestion') return [];
    return [
      {
        interactionRef: fact.interactionRef,
        inputId: fact.inputId,
        kind: fact.kind,
        expiresAt: fact.expiresAt,
        toolName: request.kind === 'question' ? 'AskUserQuestion' : request.tool,
        toolInput:
          request.kind === 'question'
            ? { questions: structuredClone(request.questions) }
            : (data(request.input) ?? {
                input: structuredClone(request.input),
              }),
      },
    ];
  });
}

export function projectHostToolApproval(
  pending: HostPendingInteraction,
  scope: {
    teamName: string;
    teamDisplayName: string;
    memberName: string;
    runId: string;
    requestId: string;
  },
  observedAt: number
): ToolApprovalRequest {
  return {
    requestId: scope.requestId,
    runId: scope.runId,
    teamName: scope.teamName,
    teamDisplayName: scope.teamDisplayName,
    source: scope.memberName,
    toolName: pending.toolName,
    toolInput: structuredClone(pending.toolInput),
    receivedAt: new Date(observedAt).toISOString(),
  };
}

/** Existing Sheet answers are JSON data, never permission promotion or input interruption. */
export function captureHostToolReply(
  pending: HostPendingInteraction,
  allow: boolean,
  message?: string
): BackendOperationPayloads['runtime.interaction']['reply'] {
  if (!allow || pending.kind === 'permission') {
    if (message !== undefined) throw new Error('Unexpected interaction answer');
    return pending.kind === 'question'
      ? { kind: 'question', decision: 'deny' }
      : { kind: 'permission', decision: allow ? 'allow' : 'deny' };
  }
  if (typeof message !== 'string' || message.length > 64 * 1024)
    throw new Error('Select an answer before submitting');
  const parsed = data(JSON.parse(message));
  if (!parsed || Object.keys(parsed).length === 0 || Object.keys(parsed).length > 100)
    throw new Error('Invalid question answers');
  const questions = pending.toolInput.questions;
  if (!Array.isArray(questions)) throw new Error('Question choices are unavailable');
  const labels = new Set(
    questions
      .map((question) => data(question)?.question)
      .filter((value): value is string => typeof value === 'string')
  );
  const answers = Object.fromEntries(
    Object.entries(parsed).map(([question, answer]) => {
      if (
        !labels.has(question) ||
        question.length > 256 ||
        question.includes('\0') ||
        typeof answer !== 'string' ||
        !answer ||
        answer.length > 20_000 ||
        answer.includes('\0')
      )
        throw new Error('Invalid question answer');
      return [question, answer];
    })
  );
  return { kind: 'question', answers };
}
