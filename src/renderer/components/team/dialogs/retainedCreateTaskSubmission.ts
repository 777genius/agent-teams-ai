import { HostTaskSubmissionRefusal } from '@features/agent-backend/contracts';
import { acknowledgeHostTaskSubmission } from '@features/agent-backend/renderer';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { IpcError } from '@renderer/utils/unwrapIpc';

import type { CreateTaskRequest } from '@shared/types';
import type { InlineChip } from '@shared/types/inlineChip';

export interface RetainedCreateTaskDraft {
  subject: string;
  description: string;
  prompt: string;
  chips: InlineChip[];
  owner: string;
  groupChatId: string | null;
  blockedBy: string[];
  related: string[];
  startImmediately: boolean;
}
interface Intent {
  signature: string;
  owner: string;
  teamName: string;
  request: CreateTaskRequest;
  draft: RetainedCreateTaskDraft;
  inFlight: boolean;
}
// The existing single Create Task form retains one app-lifetime unresolved obligation.
// This does not persist command state or promise recovery after renderer reload.
let submitted: Intent | null = null;
let activeForm: object | null = null;
/** A replacement open owns the restored draft; an older completion must not clear it. */
export function registerRetainedCreateTaskForm(): () => boolean {
  const token = {};
  activeForm = token;
  return () => activeForm === token;
}
function currentOwner(): string | null {
  const state = useStore.getState();
  return state.isContextSwitching
    ? null
    : JSON.stringify([
        state.activeContextId,
        state.targetContextId,
        state.connectionMode,
        state.connectedHost,
        state.appConfig?.general?.claudeRootPath,
      ]);
}
export function retainedCreateTaskDraft(teamName: string): RetainedCreateTaskDraft | null {
  return submitted?.teamName === teamName && submitted.owner === currentOwner()
    ? structuredClone(submitted.draft)
    : null;
}
export async function submitRetainedTaskCreate(
  teamName: string,
  request: CreateTaskRequest,
  draft: RetainedCreateTaskDraft,
  create: (request: CreateTaskRequest) => Promise<void>,
  isFormCurrent: () => boolean
): Promise<void> {
  const owner = currentOwner();
  if (owner === null)
    throw new Error('Team context is switching. Wait before retrying Create Task.');
  const signature = JSON.stringify([owner, teamName, draft]);
  if (submitted && submitted.signature !== signature)
    throw new Error(
      'Previous Create Task result is uncertain. Retry the unchanged original draft at its original owner.'
    );
  if (submitted?.inFlight)
    throw new Error('Previous Create Task is still pending. Wait for its result.');
  const commandId = submitted?.request.command?.commandId ?? crypto.randomUUID();
  const intent = submitted ?? {
    signature,
    owner,
    teamName,
    request: structuredClone({ ...request, command: { commandId, idempotencyKey: commandId } }),
    draft: structuredClone(draft),
    inFlight: false,
  };
  submitted = intent;
  intent.inFlight = true;
  const epoch = captureContextScopedRequestEpoch();
  const current = () =>
    currentOwner() === owner && isContextScopedRequestEpochCurrent(epoch) && submitted === intent;
  try {
    await create(structuredClone(intent.request));
    if (!current() || !isFormCurrent())
      throw new Error('Create Task owner or form changed. Original result remains retained.');
    acknowledgeHostTaskSubmission(teamName, commandId);
    submitted = null;
  } catch (error) {
    const refusal = error instanceof IpcError ? error.causeError : error;
    if (
      current() &&
      refusal instanceof HostTaskSubmissionRefusal &&
      refusal.commandId === commandId
    )
      submitted = null;
    throw error;
  } finally {
    intent.inFlight = false;
  }
}
export function __resetRetainedCreateTaskSubmissionForTests(): void {
  submitted = null;
  activeForm = null;
}
