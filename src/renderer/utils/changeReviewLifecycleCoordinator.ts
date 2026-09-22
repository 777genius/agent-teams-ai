import { buildTaskChangeSignature } from './taskChangeRequest';

import type { TaskChangeRequestOptions } from './taskChangeRequest';

export interface ChangeReviewLifecycleIdentity {
  teamName: string;
  mode: 'agent' | 'task';
  memberName?: string;
  taskId?: string;
  taskChangeRequestOptions?: TaskChangeRequestOptions;
}

export interface ChangeReviewLifecycleRegistration {
  hostId: string;
  sessionId: string;
  tabId?: string;
  requestClose: () => Promise<boolean>;
  focus?: () => void;
}

interface ChangeReviewLifecycleReservation {
  hostId: string;
  sessionId: string;
  tabId?: string;
}

interface ChangeReviewLifecycleRegistrationResult {
  accepted: boolean;
  unregister: () => void;
}

let activeOwner: ChangeReviewLifecycleRegistration | null = null;
let reservation: ChangeReviewLifecycleReservation | null = null;
let lifecycleTail: Promise<void> = Promise.resolve();
let pendingLifecycleOperationCount = 0;

export function buildChangeReviewLifecycleSessionId(
  identity: ChangeReviewLifecycleIdentity
): string {
  const target = identity.mode === 'task' ? (identity.taskId ?? '') : (identity.memberName ?? '');
  const signature =
    identity.mode === 'task'
      ? buildTaskChangeSignature(identity.taskChangeRequestOptions ?? {})
      : '';
  return `${identity.teamName}\0${identity.mode}\0${target}\0${signature}`;
}

function enqueueLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
  pendingLifecycleOperationCount += 1;
  const result = lifecycleTail.then(operation, operation);
  const observedResult = result.then(
    (value) => {
      pendingLifecycleOperationCount -= 1;
      return value;
    },
    (error: unknown) => {
      pendingLifecycleOperationCount -= 1;
      throw error;
    }
  );
  lifecycleTail = observedResult.then(
    () => undefined,
    () => undefined
  );
  return observedResult;
}

async function closeActiveOwnerForTransition(): Promise<boolean> {
  const owner = activeOwner;
  if (!owner) return true;
  const closed = await owner.requestClose();
  if (!closed) {
    owner.focus?.();
    return false;
  }
  if (activeOwner === owner) activeOwner = null;
  if (reservation?.hostId === owner.hostId) reservation = null;
  return true;
}

export function requestChangeReviewLifecycleReservation(
  next: ChangeReviewLifecycleReservation
): Promise<boolean> {
  return enqueueLifecycleOperation(async () => {
    if (activeOwner?.hostId === next.hostId && activeOwner.sessionId === next.sessionId) {
      reservation = next;
      return true;
    }
    if (!(await closeActiveOwnerForTransition())) return false;
    reservation = next;
    return true;
  });
}

export function requestCloseChangeReviewLifecycleHost(hostId: string): Promise<boolean> {
  return enqueueLifecycleOperation(async () => {
    if (activeOwner?.hostId !== hostId) return true;
    return closeActiveOwnerForTransition();
  });
}

/**
 * Flushes the mounted Changes owner before an app-wide context reset.
 * An unclaimed reservation has no review state yet, but it must be cancelled so
 * a delayed React layout effect cannot claim ownership after the reset begins.
 */
export function requestCloseActiveChangeReviewLifecycle(): boolean | Promise<boolean> {
  if (pendingLifecycleOperationCount === 0 && !activeOwner) {
    reservation = null;
    return true;
  }
  return enqueueLifecycleOperation(async () => {
    if (!(await closeActiveOwnerForTransition())) return false;
    reservation = null;
    return true;
  });
}

export function registerChangeReviewLifecycleOwner(
  owner: ChangeReviewLifecycleRegistration
): ChangeReviewLifecycleRegistrationResult {
  const reservedForOwner =
    reservation?.hostId === owner.hostId && reservation.sessionId === owner.sessionId;
  const canClaimWithoutReservation = reservation === null && activeOwner === null;
  if (!reservedForOwner && !canClaimWithoutReservation) {
    activeOwner?.focus?.();
    return { accepted: false, unregister: () => undefined };
  }
  activeOwner = owner;
  reservation = {
    hostId: owner.hostId,
    sessionId: owner.sessionId,
    tabId: owner.tabId,
  };
  return {
    accepted: true,
    unregister: () => {
      if (activeOwner === owner) activeOwner = null;
      if (reservation?.hostId === owner.hostId && reservation.sessionId === owner.sessionId) {
        reservation = null;
      }
    },
  };
}

function ownerMatchesTabMutation(tabIds: ReadonlySet<string> | null): boolean {
  if (!activeOwner) return false;
  if (tabIds === null) return true;
  return activeOwner.tabId !== undefined && tabIds.has(activeOwner.tabId);
}

/**
 * Returns true when the synchronous store mutation was deferred behind Changes flush.
 * A null tab set means the mutation closes every tab.
 */
export function deferTabMutationForActiveChangeReview(
  tabIds: ReadonlySet<string> | null,
  mutation: () => void
): boolean {
  if (!ownerMatchesTabMutation(tabIds)) return false;
  void enqueueLifecycleOperation(async () => {
    if (ownerMatchesTabMutation(tabIds) && !(await closeActiveOwnerForTransition())) return;
    mutation();
  });
  return true;
}

export function resetChangeReviewLifecycleCoordinatorForTests(): void {
  activeOwner = null;
  reservation = null;
  lifecycleTail = Promise.resolve();
  pendingLifecycleOperationCount = 0;
}
