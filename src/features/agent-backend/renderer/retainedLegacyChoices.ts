import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
  subscribeContextScopedRequestEpoch,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import {
  captureRetainedLegacyTransport,
  RetainedLegacyLaunchError,
  retainedLegacyValue,
} from './retainedLegacyTransport';

import type {
  RetainedLegacyLaunchChoice,
  RetainedLegacyLaunchResult,
} from '../contracts/retainedLegacyLaunch';
import type { RetainedLegacyTransport } from './retainedLegacyTransport';

interface ChoiceOwner {
  send: RetainedLegacyTransport;
  teamName: string;
  epoch: number;
  intentId?: string;
  closed: boolean;
  closing?: Promise<boolean>;
}
interface OpenIntent {
  send: RetainedLegacyTransport;
  teamName: string;
  epoch: number;
  intentId: string;
  pending: boolean;
  cancelled: boolean;
  scopeId?: string;
  closing?: Promise<boolean>;
  cleanup: Set<() => void>;
}
const choiceOwners = new Map<string, ChoiceOwner>();
const openIntents = new Map<string, OpenIntent>();
function forgetOpen(key: string, intent: OpenIntent) {
  if (openIntents.get(key) === intent) openIntents.delete(key);
  for (const cleanup of intent.cleanup) cleanup();
  intent.cleanup.clear();
}
function forgetChoice(scopeId: string, owner: ChoiceOwner) {
  if (choiceOwners.get(scopeId) === owner) choiceOwners.delete(scopeId);
  for (const [key, intent] of openIntents) if (intent.scopeId === scopeId) forgetOpen(key, intent);
}
async function closeOpenIntent(key: string, intent: OpenIntent): Promise<boolean> {
  intent.cancelled = true;
  if (intent.closing) return intent.closing;
  intent.closing = (async () => {
    try {
      const result = await intent.send({
        action: 'closeIntent',
        teamName: intent.teamName,
        intentId: intent.intentId,
      });
      if (!result.ok || result.action !== 'closeIntent') return false;
      if (intent.scopeId) {
        const owner = choiceOwners.get(intent.scopeId);
        if (owner) forgetChoice(intent.scopeId, owner);
      }
      forgetOpen(key, intent);
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    intent.closing = undefined;
  });
  return intent.closing;
}
async function closeOwnedChoice(scopeId: string, owner: ChoiceOwner): Promise<boolean> {
  owner.closed = true;
  if (owner.closing) return owner.closing;
  owner.closing = (async () => {
    try {
      if (owner.intentId) {
        if (
          !(await closeRetainedLegacyIntent(
            owner.teamName,
            owner.intentId,
            owner.send,
            owner.epoch
          ))
        )
          return false;
      } else {
        const result = await owner.send({ action: 'close', scopeId });
        if (!result.ok || result.action !== 'close') return false;
      }
      forgetChoice(scopeId, owner);
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    owner.closing = undefined;
  });
  return owner.closing;
}
/** Exact stop-only intent cleanup also works when the allocation response was lost. */
export function closeRetainedLegacyIntent(
  teamName: string,
  intentId: string,
  send: RetainedLegacyTransport,
  epoch = captureContextScopedRequestEpoch()
): Promise<boolean> {
  for (const [key, intent] of openIntents) {
    if (intent.teamName === teamName && intent.intentId === intentId && intent.send === send)
      return closeOpenIntent(key, intent);
  }
  const key = JSON.stringify(['cleanup', epoch, teamName, intentId]);
  const intent: OpenIntent = {
    send,
    teamName,
    epoch,
    intentId,
    pending: false,
    cancelled: true,
    cleanup: new Set(),
  };
  openIntents.set(key, intent);
  return closeOpenIntent(key, intent);
}
export function retainLegacyChoice(
  choice: RetainedLegacyLaunchChoice,
  send: RetainedLegacyTransport,
  intentId?: string,
  epoch = captureContextScopedRequestEpoch()
): void {
  choiceOwners.set(choice.scopeId, {
    send,
    teamName: choice.teamName,
    intentId,
    epoch,
    closed: false,
  });
}
export function capturedLegacyChoiceTransport(
  choice: RetainedLegacyLaunchChoice
): RetainedLegacyTransport | undefined {
  const owner = choiceOwners.get(choice.scopeId);
  return owner && !owner.closed && owner.teamName === choice.teamName ? owner.send : undefined;
}
export function isRetainedLegacyChoice(
  choice: RetainedLegacyLaunchChoice,
  teamName: string
): boolean {
  return (
    !!choice &&
    choice.mode === 'original-runtime' &&
    choice.teamName === teamName &&
    typeof choice.scopeId === 'string' &&
    !!choice.scopeId &&
    typeof choice.projectPath === 'string' &&
    !!choice.projectPath.trim() &&
    Number.isFinite(choice.expiresAt) &&
    choice.expiresAt > Date.now()
  );
}
/** Explicit opening or recovery only; UNKNOWN keeps the same original transport and intent. */
export async function openRetainedLegacyLaunch(
  teamName: string,
  signal?: AbortSignal
): Promise<RetainedLegacyLaunchChoice> {
  const epoch = captureContextScopedRequestEpoch();
  const key = JSON.stringify([epoch, teamName]);
  for (const [pendingKey, pendingIntent] of openIntents) {
    if (
      pendingIntent.teamName !== teamName ||
      pendingIntent.epoch !== epoch ||
      !pendingIntent.cancelled
    )
      continue;
    if (!(await closeOpenIntent(pendingKey, pendingIntent)))
      throw new RetainedLegacyLaunchError(
        'unknown',
        'The previous Launch choice could not be closed. Reopen Launch to recover it.'
      );
  }
  for (const [scopeId, owner] of choiceOwners) {
    if (owner.teamName !== teamName || owner.epoch !== epoch) continue;
    if (!owner.closed)
      throw new RetainedLegacyLaunchError(
        'not-dispatched',
        'An original runtime Launch is already open for this team. Close it first.'
      );
    if (!(await closeOwnedChoice(scopeId, owner)))
      throw new RetainedLegacyLaunchError(
        'unknown',
        'The previous Launch choice could not be closed. Reopen Launch to recover it.'
      );
  }
  let intent = openIntents.get(key);
  if (intent?.cancelled) {
    if (!(await closeOpenIntent(key, intent)))
      throw new RetainedLegacyLaunchError(
        'unknown',
        'The previous opening could not be cancelled. Reopen Launch to recover it.'
      );
    intent = undefined;
  }
  if (signal?.aborted || !isContextScopedRequestEpochCurrent(epoch))
    throw new RetainedLegacyLaunchError('not-dispatched', 'Launch was closed.');
  if (intent?.pending)
    throw new RetainedLegacyLaunchError(
      'not-dispatched',
      'Original runtime choice is opening. Wait for it to finish.'
    );
  if (!intent) {
    intent = {
      send: captureRetainedLegacyTransport(),
      teamName,
      epoch,
      intentId: crypto.randomUUID(),
      pending: false,
      cancelled: false,
      cleanup: new Set(),
    };
    openIntents.set(key, intent);
    const captured = intent;
    captured.cleanup.add(
      subscribeContextScopedRequestEpoch(() => {
        if (!isContextScopedRequestEpochCurrent(epoch)) void closeOpenIntent(key, captured);
      })
    );
  }
  const captured = intent;
  const abort = () => {
    void closeOpenIntent(key, captured);
  };
  if (signal) {
    signal.addEventListener('abort', abort, { once: true });
    intent.cleanup.add(() => signal.removeEventListener('abort', abort));
  }
  intent.pending = true;
  let result: RetainedLegacyLaunchResult;
  try {
    result = await intent.send({ action: 'open', teamName, intentId: intent.intentId });
  } catch {
    throw new RetainedLegacyLaunchError(
      'unknown',
      'Original runtime response was lost. Reopen Launch to recover the same choice.'
    );
  } finally {
    intent.pending = false;
  }
  if (!result.ok && result.outcome === 'not-dispatched') forgetOpen(key, intent);
  const choice = retainedLegacyValue(result, 'open');
  if (
    !isRetainedLegacyChoice(choice, teamName) ||
    intent.cancelled ||
    signal?.aborted ||
    !isContextScopedRequestEpochCurrent(epoch)
  ) {
    if (choice?.scopeId) {
      retainLegacyChoice(choice, intent.send, intent.intentId, epoch);
      await closeRetainedLegacyLaunch(choice);
    }
    await closeOpenIntent(key, intent);
    throw new RetainedLegacyLaunchError(
      'not-dispatched',
      'Team context changed or Launch was closed. Reopen Launch.'
    );
  }
  intent.scopeId = choice.scopeId;
  retainLegacyChoice(choice, intent.send, intent.intentId, epoch);
  return choice;
}
export async function closeRetainedLegacyLaunch(
  choice: RetainedLegacyLaunchChoice | undefined
): Promise<void> {
  if (!choice) return;
  const owner = choiceOwners.get(choice.scopeId);
  if (owner) await closeOwnedChoice(choice.scopeId, owner);
}
