import type {
  RuntimeFailureReasonCode,
  TeamRuntimeRecoveryTargetKind,
  TeamRuntimeRecoveryTaskRef,
} from '../../contracts';

export function buildRuntimeRecoveryMessageId(job: { id: string; attempt: number }): string {
  return `${job.id}-attempt-${job.attempt + 1}`;
}

function formatTaskRefs(taskRefs: readonly TeamRuntimeRecoveryTaskRef[]): string | null {
  const labels = taskRefs
    .map((taskRef) => taskRef.displayId?.trim() || taskRef.taskId.trim())
    .filter(Boolean)
    .map((label) => `#${label}`);
  return labels.length > 0 ? labels.join(', ') : null;
}

export function buildRuntimeRecoveryPrompt(input: {
  recoveryId: string;
  attempt: number;
  maxAttempts: number;
  reasonCode: RuntimeFailureReasonCode;
  targetKind: TeamRuntimeRecoveryTargetKind;
  taskRefs?: readonly TeamRuntimeRecoveryTaskRef[];
  unavailableMemberName?: string;
}): string {
  const taskLabels = formatTaskRefs(input.taskRefs ?? []);
  if (input.unavailableMemberName) {
    return [
      `Automatic runtime recovery escalation (${input.recoveryId}).`,
      `Teammate "${input.unavailableMemberName}" is no longer available after a transient provider failure.`,
      taskLabels ? `Affected tasks: ${taskLabels}.` : null,
      'Inspect the current task state and recent team activity, then safely restart, reassign, or finish the remaining work.',
      'Do not blindly repeat completed commands, tool calls, messages, or external side effects.',
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }

  return [
    `Automatic runtime recovery after ${input.reasonCode} (attempt ${input.attempt}/${input.maxAttempts}, id ${input.recoveryId}).`,
    taskLabels ? `Affected tasks: ${taskLabels}.` : null,
    'Before continuing, inspect the current task state, recent transcript, changed files/diff, and any external actions that may already have completed.',
    'Do not blindly repeat commands, tool calls, messages, writes, or external side effects.',
    input.targetKind === 'lead'
      ? 'Resume coordination from the first incomplete step and verify teammate state before delegating again.'
      : 'Resume your assigned work from the first incomplete step.',
    'If the work is already complete, record and communicate completion instead of redoing it.',
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
