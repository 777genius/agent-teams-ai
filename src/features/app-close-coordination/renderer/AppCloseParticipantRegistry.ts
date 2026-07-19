import type {
  AppCloseCoordinationElectronApi,
  AppCloseReadinessRequest,
} from '../contracts';

export interface AppCloseParticipantResult {
  ok: boolean;
  blocker?: string;
}

export type AppCloseParticipant = (
  request: AppCloseReadinessRequest
) => Promise<AppCloseParticipantResult>;

interface RegisteredParticipant {
  token: symbol;
  handler: AppCloseParticipant;
}

const participants = new Map<string, RegisteredParticipant>();
let removeReadinessListener: (() => void) | null = null;

export function registerAppCloseParticipant(
  id: string,
  handler: AppCloseParticipant
): () => void {
  const token = Symbol(id);
  participants.set(id, { token, handler });
  return (): void => {
    if (Object.is(participants.get(id)?.token, token)) participants.delete(id);
  };
}

export async function runAppCloseParticipants(
  request: AppCloseReadinessRequest
): Promise<{ ok: boolean; blockers: string[] }> {
  const entries = [...participants.entries()];
  const settled = await Promise.allSettled(
    entries.map(([, participant]) => participant.handler(request))
  );
  const blockers: string[] = [];
  settled.forEach((result, index) => {
    const id = entries[index]?.[0] ?? 'unknown';
    if (result.status === 'rejected') {
      blockers.push(
        `${id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
      );
    } else if (!result.value.ok) {
      blockers.push(result.value.blocker?.trim() || `${id} is not ready to close.`);
    }
  });
  return { ok: blockers.length === 0, blockers };
}

export function initializeAppCloseCoordination(
  api: AppCloseCoordinationElectronApi | null | undefined
): () => void {
  removeReadinessListener?.();
  removeReadinessListener = api?.onReadinessRequest(runAppCloseParticipants) ?? null;
  return (): void => {
    removeReadinessListener?.();
    removeReadinessListener = null;
  };
}
