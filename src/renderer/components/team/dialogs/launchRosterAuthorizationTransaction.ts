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

function hasExpectedTransaction(
  expectedTransactionId: string,
  outcome: RosterAuthorizationTransactionOutcome
): boolean {
  return outcome.transactionId === expectedTransactionId;
}

function requireRollback(
  expectedTransactionId: string,
  outcome: RosterAuthorizationTransactionOutcome
): void {
  if (!hasExpectedTransaction(expectedTransactionId, outcome) || outcome.status !== 'rolled-back') {
    throw new Error(
      `The roster authorization transaction could not be safely rolled back (${hasExpectedTransaction(expectedTransactionId, outcome) ? outcome.status : 'foreign'}). ${outcome.message ?? 'Newer roster state was preserved.'}`
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
  expectedTransactionId: string,
  failure: Error,
  rollback: TransactionOperation
): Promise<never> {
  try {
    requireRollback(expectedTransactionId, await rollback());
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
  expectedTransactionId: string,
  begin: TransactionOperation,
  getOutcome: TransactionOperation,
  submit: (proof: AuthoritativeModelExecutionProof) => void | Promise<void>,
  rollback: TransactionOperation,
  isCurrent: () => boolean = () => true,
  onKnownNoDispatch: () => void = () => undefined
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
    if (hasExpectedTransaction(expectedTransactionId, resolved) && resolved.status === 'applied') {
      requireRollback(expectedTransactionId, await rollback());
      throw new Error(
        'The roster update response was lost. The exact prior roster was restored; review authorization and retry.',
        { cause: beginError }
      );
    }
    if (
      hasExpectedTransaction(expectedTransactionId, resolved) &&
      (resolved.status === 'pending' || resolved.status === 'unknown')
    ) {
      throw new Error(
        `The roster update outcome is ${resolved.status}. Launch was not attempted; retry after the transaction can be resolved.`,
        { cause: beginError }
      );
    }
    throw beginError;
  }

  if (!hasExpectedTransaction(expectedTransactionId, began) || began.status !== 'applied') {
    throw new Error(
      `The roster authorization transaction is ${hasExpectedTransaction(expectedTransactionId, began) ? began.status : 'foreign'}; launch was not attempted.`
    );
  }
  if (!isCurrent()) {
    requireRollback(expectedTransactionId, await rollback());
    return false;
  }
  const confirmed = await getOutcome();
  if (!hasExpectedTransaction(expectedTransactionId, confirmed) || confirmed.status !== 'applied') {
    throw new Error(
      `The applied roster could not be confirmed (${hasExpectedTransaction(expectedTransactionId, confirmed) ? confirmed.status : 'foreign'}); launch was not attempted.`
    );
  }
  if (!isCurrent()) {
    requireRollback(expectedTransactionId, await rollback());
    return false;
  }
  let currentAuthorization: ProvisioningLaunchAuthorizationInput;
  try {
    currentAuthorization = getAuthorization();
  } catch (error) {
    return rollbackKnownPreDispatchFailure(
      expectedTransactionId,
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
    requireRollback(expectedTransactionId, await rollback());
    return false;
  }
  try {
    if (!(await executeAuthorizedProvisioningLaunch(currentAuthorization, submit))) {
      requireRollback(expectedTransactionId, await rollback());
      return false;
    }
  } catch (error) {
    if (isTeamRelaunchKnownPreDispatchFailure(error)) {
      return rollbackKnownPreDispatchFailure(expectedTransactionId, error, rollback);
    }
    let reconciled: RosterAuthorizationTransactionOutcome;
    try {
      reconciled = await getOutcome();
    } catch {
      throw error;
    }
    if (!hasExpectedTransaction(expectedTransactionId, reconciled)) throw error;
    if (reconciled.status === 'committed') return true;
    if (reconciled.status === 'rolled-back' || reconciled.status === 'not-started') {
      onKnownNoDispatch();
      return false;
    }
    throw error;
  }

  // The desktop launch IPC owns prepare + launch-result finalization. Reading the
  // durable result also recovers a renderer response loss without retrying launch.
  const finalized = await getOutcome();
  if (!hasExpectedTransaction(expectedTransactionId, finalized)) {
    throw new Error(
      'The launch result belongs to a different roster transaction. The roster remains reserved for main-process recovery.'
    );
  }
  if (finalized.status === 'rolled-back' || finalized.status === 'not-started') {
    onKnownNoDispatch();
    return false;
  }
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
