import { RosterLaunchKnownNoStartError } from '@main/services/team/provisioning/TeamProvisioningRosterLaunchOutcome';
import {
  bindAuthoritativeModelExecutionProof,
  claimAuthoritativeModelExecutionProofInvocation,
  verifyAuthoritativeModelExecutionProofForRequest,
} from '@main/services/team/TeamLaunchExecutionProofAuthority';
import { runWithRosterReservation } from '@main/services/team/TeamMembersMetaStore';

import {
  consumeProductionLaunchAdmission,
  fingerprintProductionLaunchRequest,
} from './authorizeProductionTeamCreateRequest';

import type { ProductionLaunchAdmissionLease } from './authorizeProductionTeamCreateRequest';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type {
  IpcResult,
  RosterAuthorizedLaunchBinding,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamMember,
} from '@shared/types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRosterTransactionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export async function rejectRosterLaunchBeforeDispatch(
  service: TeamDataService,
  teamName: string,
  transactionId: string | undefined,
  error: string
): Promise<IpcResult<TeamLaunchResponse>> {
  if (transactionId) {
    const rollback = await service.rollbackRosterAuthorizationTransaction(teamName, transactionId);
    if (rollback.status !== 'rolled-back' && rollback.status !== 'not-started') {
      return {
        success: false,
        error: `${error}; roster transaction recovery is ${rollback.status}`,
      };
    }
  }
  return { success: false, error };
}

export async function rollbackRosterLaunchIfSafe(
  service: TeamDataService,
  teamName: string,
  transactionId: string | undefined
): Promise<void> {
  if (transactionId) await service.rollbackRosterAuthorizationTransaction(teamName, transactionId);
}

export async function runBeforeRosterLaunchDispatch<T>(
  service: TeamDataService,
  teamName: string,
  transactionId: string | undefined,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await rollbackRosterLaunchIfSafe(service, teamName, transactionId);
    throw error;
  }
}

export function composeRosterAuthorizedCreateRequest(
  request: TeamCreateRequest,
  transactionId: string | undefined,
  authorizedRoster: readonly TeamMember[] | undefined,
  binding?: RosterAuthorizedLaunchBinding
): TeamCreateRequest {
  return {
    ...request,
    ...(transactionId ? { rosterTransactionId: transactionId } : {}),
    ...(binding ? { rosterLaunchBinding: binding } : {}),
    members: authorizedRoster
      ? authorizedRoster.filter((member) => member.removedAt == null)
      : request.members,
  };
}

export function runRosterAuthorizedCreate<T extends TeamLaunchResponse>(
  service: TeamDataService,
  teamName: string,
  transactionId: string | undefined,
  request: TeamCreateRequest,
  create: (request: TeamCreateRequest) => Promise<T>,
  admission?: ProductionLaunchAdmissionLease
): Promise<T> {
  if (!transactionId) return create(request);
  return authorizeRosterRequest(service, teamName, transactionId, request, admission).then(
    ({ proof, launchRequestFingerprint }) =>
      runRosterLaunch(
        service,
        teamName,
        transactionId,
        (authorizedRoster, binding) =>
          create({
            ...composeRosterAuthorizedCreateRequest(
              request,
              transactionId,
              authorizedRoster,
              binding
            ),
            executionProof: binding?.executionProof,
          }),
        proof,
        launchRequestFingerprint
      )
  );
}

export type RosterAuthorizedLaunchContext =
  | { valid: false; error: string }
  | {
      valid: true;
      transactionId: string | undefined;
      reject(error: string): Promise<IpcResult<TeamLaunchResponse>>;
      before<T>(operation: () => Promise<T>): Promise<T>;
      rollback(): Promise<void>;
      run<T extends TeamLaunchResponse>(
        request: TeamLaunchRequest,
        launch: (request: TeamLaunchRequest) => Promise<T>
      ): Promise<T>;
      runCreate<T extends TeamLaunchResponse>(
        request: TeamCreateRequest,
        create: (request: TeamCreateRequest) => Promise<T>
      ): Promise<T>;
    };

export function createRosterAuthorizedLaunchContext(
  service: TeamDataService,
  teamName: string,
  value: unknown,
  admission?: ProductionLaunchAdmissionLease,
  ownsTransaction = false
): RosterAuthorizedLaunchContext {
  if (value !== undefined && !isRosterTransactionId(value)) {
    return { valid: false, error: 'Invalid rosterTransactionId' };
  }
  const transactionId = value;
  // Rollback is an invocation capability, not something possession of a
  // durable transaction ID confers. Replays and restarted callers may resume
  // an admitted transaction but cannot undo it on unrelated rejection paths.
  const ownedTransactionId = ownsTransaction ? transactionId : undefined;
  return {
    valid: true,
    transactionId,
    reject: (error) =>
      rejectRosterLaunchBeforeDispatch(service, teamName, ownedTransactionId, error),
    before: (operation) =>
      runBeforeRosterLaunchDispatch(service, teamName, ownedTransactionId, operation),
    rollback: () => rollbackRosterLaunchIfSafe(service, teamName, ownedTransactionId),
    run: (request, launch) => {
      if (!transactionId) return launch(request);
      return authorizeRosterRequest(service, teamName, transactionId, request, admission).then(
        ({ proof, launchRequestFingerprint }) =>
          runRosterLaunch(
            service,
            teamName,
            transactionId,
            (_roster, binding) =>
              launch({
                ...request,
                executionProof: binding?.executionProof,
                rosterLaunchBinding: binding,
              }),
            proof,
            launchRequestFingerprint
          )
      );
    },
    runCreate: (request, create) =>
      runRosterAuthorizedCreate(service, teamName, transactionId, request, create, admission),
  };
}

export async function runRosterLaunch<T extends TeamLaunchResponse>(
  service: TeamDataService,
  teamName: string,
  transactionId: string | undefined,
  launch: (
    authorizedRoster?: readonly TeamMember[],
    binding?: RosterAuthorizedLaunchBinding
  ) => Promise<T>,
  executionProof?: import('@shared/types').AuthoritativeModelExecutionProof,
  launchRequestFingerprint?: string
): Promise<T> {
  if (transactionId !== undefined && !isRosterTransactionId(transactionId)) {
    throw new Error('Invalid rosterTransactionId');
  }
  if (!transactionId) return launch();
  const transactions = service.rosterAuthorizationTransactions;
  const prepared = await transactions.prepare(
    teamName,
    transactionId,
    transactionId,
    executionProof,
    launchRequestFingerprint
  );
  if (prepared.status !== 'prepared') {
    throw new Error(`Roster authorization transaction is ${prepared.status}`);
  }
  const binding = prepared.launchBinding;
  if (!binding) {
    throw new Error('Roster authorization prepare omitted the exact durable launch binding');
  }
  const intent = await transactions.prepareLaunchInvocationIntent(teamName, transactionId);
  if (intent.status !== 'prepared') {
    throw new Error(`Roster authorization transaction is ${intent.status}`);
  }
  let response: T;
  try {
    response = await runWithRosterReservation(
      transactionId,
      () => launch(prepared.authorizedRoster, binding),
      async () => {
        const invocationLease = claimAuthoritativeModelExecutionProofInvocation(
          binding.executionProof
        );
        if (!invocationLease) {
          throw new RosterLaunchKnownNoStartError(
            'Launch authorization expired or was invalidated before dispatch'
          );
        }
        try {
          const dispatched = await transactions.recordLaunchDispatched(teamName, transactionId);
          if (!invocationLease.isCurrent()) {
            throw new RosterLaunchKnownNoStartError(
              'Launch authorization expired or was invalidated during durable dispatch'
            );
          }
          if (dispatched.status !== 'launch-unknown') {
            throw new RosterLaunchKnownNoStartError(
              `Roster authorization transaction is ${dispatched.status} before dispatch`
            );
          }
          return invocationLease;
        } catch (error) {
          invocationLease.close();
          throw error;
        }
      }
    );
  } catch (error) {
    if (error instanceof RosterLaunchKnownNoStartError) {
      await transactions.recordKnownLaunchFailure(teamName, transactionId, error.message);
      throw error;
    }
    await transactions.recordUnknownLaunchTransport(
      teamName,
      transactionId,
      `Launch dispatch failed without authoritative no-dispatch evidence: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    throw error;
  }
  const authoritativeOutcome =
    response?.rosterLaunchOutcome ??
    (response?.launchStatus === 'started' || response?.launchStatus === 'not_started'
      ? {
          ...binding,
          runId: response.runId,
          attemptId: response.runId,
          launchStatus: response.launchStatus,
        }
      : undefined);
  if (!authoritativeOutcome) {
    if (
      response?.launchStatus === 'already_launching' ||
      response?.launchStatus === 'already_running' ||
      response?.alreadyLaunching === true ||
      response?.alreadyRunning === true
    ) {
      await transactions.recordKnownLaunchFailure(
        teamName,
        transactionId,
        'Launch was a duplicate/no-op and created no member for this command'
      );
      return response;
    }
    await transactions.recordUnknownLaunchTransport(
      teamName,
      transactionId,
      'Production launch boundary omitted transaction-bound execution proof'
    );
    return response;
  }
  await transactions.recordLaunchResult(teamName, transactionId, authoritativeOutcome);
  return response;
}

async function authorizeRosterRequest(
  service: TeamDataService,
  teamName: string,
  transactionId: string,
  request: TeamCreateRequest | TeamLaunchRequest,
  admission?: ProductionLaunchAdmissionLease
): Promise<{
  proof: import('@shared/types').AuthoritativeModelExecutionProof;
  roster: readonly TeamMember[];
  rosterRevision: string;
  launchRequestFingerprint: string;
}> {
  const consumedAdmission = admission ? consumeProductionLaunchAdmission(admission) : undefined;
  if (
    consumedAdmission &&
    !(await service.rosterAuthorizationTransactions.validateLaunchAdmission(
      teamName,
      transactionId,
      consumedAdmission.launchRequestFingerprint
    ))
  ) {
    throw new Error('Roster authorization transaction does not admit this exact launch request');
  }
  const outcome = await service.getRosterAuthorizationTransactionOutcome(teamName, transactionId);
  const roster = outcome.authorizedRoster ?? ('members' in request ? request.members : []);
  const rosterRevision = outcome.rosterRevision;
  if (!rosterRevision) {
    throw new Error('Roster authorization omitted its immutable revision');
  }
  if (consumedAdmission) {
    return {
      proof: consumedAdmission.executionProof,
      roster,
      rosterRevision,
      launchRequestFingerprint: consumedAdmission.launchRequestFingerprint,
    };
  }
  const proof = request.executionProof;
  if (!proof || !verifyAuthoritativeModelExecutionProofForRequest(proof, request, roster)) {
    throw new Error('Fresh authoritative launch authorization is required');
  }
  const launchRequestFingerprint = fingerprintProductionLaunchRequest(request, roster);
  return {
    proof: bindAuthoritativeModelExecutionProof(proof, launchRequestFingerprint, rosterRevision),
    roster,
    rosterRevision,
    launchRequestFingerprint,
  };
}
