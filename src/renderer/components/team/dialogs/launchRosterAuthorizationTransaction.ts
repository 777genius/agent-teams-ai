import {
  executeAuthorizedProvisioningLaunch,
  isProvisioningLaunchAuthorized,
  type ProvisioningLaunchAuthorizationInput,
} from './provisioningLaunchAuthorization';
import { isTeamRelaunchKnownPreDispatchFailure } from './teamRelaunchFlow';

import type {
  AuthoritativeModelExecutionProof,
  RosterAuthorizationTransactionOutcome,
} from '@shared/types';

type TransactionOperation = () => Promise<RosterAuthorizationTransactionOutcome>;

function requireRollback(outcome: RosterAuthorizationTransactionOutcome): void {
  if (outcome.status !== 'rolled-back') {
    throw new Error(
      `The roster authorization transaction could not be safely rolled back (${outcome.status}). ${outcome.message ?? 'Newer roster state was preserved.'}`
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasSameExecutionProof(
  submitted: AuthoritativeModelExecutionProof | null | undefined,
  current: AuthoritativeModelExecutionProof | null | undefined
): boolean {
  return (
    submitted != null &&
    current != null &&
    submitted.authorityId === current.authorityId &&
    submitted.generation === current.generation &&
    submitted.completedAt === current.completedAt &&
    submitted.expiresAt === current.expiresAt &&
    submitted.requestDigest === current.requestDigest
  );
}

function hasSameImmutableLaunchAuthorization(
  submitted: ProvisioningLaunchAuthorizationInput,
  current: ProvisioningLaunchAuthorizationInput
): boolean {
  return (
    submitted.preparedRequestSignature === current.preparedRequestSignature &&
    submitted.currentRequestSignature === current.currentRequestSignature &&
    submitted.preparedGeneration === current.preparedGeneration &&
    submitted.currentGeneration === current.currentGeneration &&
    submitted.providerProofExpiresAtMs === current.providerProofExpiresAtMs &&
    hasSameExecutionProof(submitted.executionProof, current.executionProof)
  );
}

async function rollbackKnownPreDispatchFailure(
  failure: Error,
  rollback: TransactionOperation
): Promise<never> {
  try {
    requireRollback(await rollback());
  } catch (rollbackError) {
    throw new Error(
      `${failure.message}; immediate roster rollback failed: ${describeError(rollbackError)}`,
      { cause: new AggregateError([failure, rollbackError], failure.message) }
    );
  }
  throw failure;
}

export async function executeLaunchTeamDialogSubmissionWithRecheck(
  getAuthorization: () => ProvisioningLaunchAuthorizationInput,
  begin: TransactionOperation,
  getOutcome: TransactionOperation,
  submit: (proof: AuthoritativeModelExecutionProof) => void | Promise<void>,
  rollback: TransactionOperation,
  isCurrent: () => boolean = () => true
): Promise<boolean> {
  // Bind the transaction to request/roster A. A later render must not let proof
  // B authorize A, and a stale proof A must not survive a revoked live status.
  const submittedAuthorization = getAuthorization();
  if (!(await executeAuthorizedProvisioningLaunch(submittedAuthorization, () => undefined))) {
    return false;
  }
  if (!isCurrent()) return false;

  let began: RosterAuthorizationTransactionOutcome;
  try {
    began = await begin();
  } catch (beginError) {
    const resolved = await getOutcome();
    if (resolved.status === 'applied') {
      requireRollback(await rollback());
      throw new Error(
        'The roster update response was lost. The exact prior roster was restored; review authorization and retry.',
        { cause: beginError }
      );
    }
    if (resolved.status === 'pending' || resolved.status === 'unknown') {
      throw new Error(
        `The roster update outcome is ${resolved.status}. Launch was not attempted; retry after the transaction can be resolved.`,
        { cause: beginError }
      );
    }
    throw beginError;
  }

  if (began.status !== 'applied') {
    throw new Error(
      `The roster authorization transaction is ${began.status}; launch was not attempted.`
    );
  }
  if (!isCurrent()) {
    requireRollback(await rollback());
    return false;
  }
  const confirmed = await getOutcome();
  if (confirmed.status !== 'applied') {
    throw new Error(
      `The applied roster could not be confirmed (${confirmed.status}); launch was not attempted.`
    );
  }
  if (!isCurrent()) {
    requireRollback(await rollback());
    return false;
  }
  let currentAuthorization: ProvisioningLaunchAuthorizationInput;
  try {
    currentAuthorization = getAuthorization();
  } catch (error) {
    return rollbackKnownPreDispatchFailure(
      new Error('Launch authorization could not be refreshed immediately before submit.', {
        cause: error,
      }),
      rollback
    );
  }
  if (
    !hasSameImmutableLaunchAuthorization(submittedAuthorization, currentAuthorization) ||
    !isProvisioningLaunchAuthorized(currentAuthorization)
  ) {
    requireRollback(await rollback());
    return false;
  }
  try {
    if (!(await executeAuthorizedProvisioningLaunch(currentAuthorization, submit))) {
      requireRollback(await rollback());
      return false;
    }
  } catch (error) {
    if (isTeamRelaunchKnownPreDispatchFailure(error)) {
      return rollbackKnownPreDispatchFailure(error, rollback);
    }
    let reconciled: RosterAuthorizationTransactionOutcome;
    try {
      reconciled = await getOutcome();
    } catch {
      throw error;
    }
    if (reconciled.status === 'committed') return true;
    throw error;
  }

  // The desktop launch IPC owns prepare + launch-result finalization. Reading the
  // durable result also recovers a renderer response loss without retrying launch.
  const finalized = await getOutcome();
  if (finalized.status === 'rolled-back') return false;
  if (finalized.status === 'prepared' || finalized.status === 'launch-unknown') {
    throw new Error(
      `The launch outcome is ${finalized.status}; the roster remains reserved and launch will not be retried automatically.`
    );
  }
  if (finalized.status !== 'committed') {
    throw new Error(
      `The launch result was not transaction-bound (${finalized.status}). The roster remains reserved for main-process recovery.`
    );
  }
  return true;
}
