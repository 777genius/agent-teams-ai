import type { ApplicationCommandRequestIdentity, CreateTaskRequest } from '@shared/types';

export interface PendingCreateTaskCommand {
  fingerprint: string;
  identity: ApplicationCommandRequestIdentity;
}

export interface CreateTaskSubmitGate {
  inFlight: boolean;
}

export function tryBeginCreateTaskSubmit(gate: CreateTaskSubmitGate): boolean {
  if (gate.inFlight) {
    return false;
  }
  gate.inFlight = true;
  return true;
}

export function resetCreateTaskSubmit(gate: CreateTaskSubmitGate): void {
  gate.inFlight = false;
}

export function resolveCreateTaskCommand(
  current: PendingCreateTaskCommand | null,
  teamName: string,
  request: CreateTaskRequest,
  createCommandId: () => string = () => crypto.randomUUID()
): PendingCreateTaskCommand {
  const fingerprint = JSON.stringify({
    teamName,
    request: {
      subject: request.subject,
      description: request.description,
      descriptionTaskRefs: request.descriptionTaskRefs,
      owner: request.owner,
      blockedBy: normalizeRelationshipIds(request.blockedBy),
      related: normalizeRelationshipIds(request.related),
      prompt: request.prompt,
      promptTaskRefs: request.promptTaskRefs,
      startImmediately: request.startImmediately,
    },
  });
  if (current?.fingerprint === fingerprint) {
    return current;
  }
  const commandId = createCommandId();
  return {
    fingerprint,
    identity: { commandId, idempotencyKey: commandId },
  };
}

function normalizeRelationshipIds(ids: string[] | undefined): string[] | undefined {
  const normalized = [...new Set(ids?.filter((id) => id.length > 0) ?? [])].sort();
  return normalized.length > 0 ? normalized : undefined;
}
