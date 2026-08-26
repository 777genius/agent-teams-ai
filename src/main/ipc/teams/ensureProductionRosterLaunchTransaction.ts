import {
  assignProductionRosterTransactionId,
  authorizeProductionTeamCreateRequest,
  authorizeProductionTeamLaunchRequest,
  claimProductionLaunchAdmission,
  fingerprintProductionLaunchRequest,
  type ProductionLaunchAdmissionLease,
  verifyProductionTeamCreateRequest,
  verifyProductionTeamLaunchRequest,
} from './authorizeProductionTeamCreateRequest';
import {
  createRosterAuthorizedLaunchContext,
  type RosterAuthorizedLaunchContext,
} from './rosterAuthorizedLaunch';

import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { TeamCreateRequest, TeamLaunchRequest, TeamMember } from '@shared/types';

interface ProductionRosterLaunchTransaction {
  transactionId: string | undefined;
  admission: ProductionLaunchAdmissionLease | undefined;
  shouldBegin: boolean;
}

export interface AdmittedProductionRosterLaunch<T> {
  request: T;
  context: Extract<RosterAuthorizedLaunchContext, { valid: true }>;
}

export async function ensureProductionRosterLaunchTransaction(
  service: TeamDataService,
  teamName: string,
  transactionId: string | undefined,
  proofRequired: boolean,
  members: readonly TeamMember[] | (() => Promise<readonly TeamMember[]>),
  request: TeamCreateRequest | TeamLaunchRequest
): Promise<ProductionRosterLaunchTransaction> {
  const durableMembers = typeof members === 'function' ? await members() : members;
  const admission = claimProductionLaunchAdmission(request, durableMembers, proofRequired);
  if (transactionId !== undefined || !proofRequired) {
    return { transactionId, admission, shouldBegin: false };
  }
  if (!request.rosterTransactionId) {
    throw new Error('Production roster launch admission omitted its durable transaction ID');
  }
  return { transactionId: request.rosterTransactionId, admission, shouldBegin: true };
}

async function commitProductionRosterLaunchTransaction(
  service: TeamDataService,
  teamName: string,
  transaction: ProductionRosterLaunchTransaction,
  members: readonly TeamMember[],
  request: TeamCreateRequest | TeamLaunchRequest
): Promise<{ transactionId: string | undefined; ownsTransaction: boolean }> {
  if (!transaction.shouldBegin || !transaction.admission || !transaction.transactionId) {
    return { transactionId: transaction.transactionId, ownsTransaction: false };
  }
  const begun = await service.beginRosterAuthorizationTransaction(
    teamName,
    transaction.transactionId,
    {
      members: [...members],
    },
    fingerprintProductionLaunchRequest(request, members)
  );
  if (begun.status !== 'applied') {
    throw new Error(`Roster authorization transaction is ${begun.status}`);
  }
  return {
    transactionId: begun.transactionId,
    ownsTransaction: begun.transactionId === transaction.transactionId,
  };
}

export async function createProductionRosterLaunchContext(
  service: TeamDataService,
  teamName: string,
  transactionId: string | undefined,
  proofRequired: boolean,
  members: readonly TeamMember[] | (() => Promise<readonly TeamMember[]>),
  request: TeamCreateRequest | TeamLaunchRequest
): Promise<Extract<RosterAuthorizedLaunchContext, { valid: true }>> {
  const durableMembers = typeof members === 'function' ? await members() : members;
  const transaction = await ensureProductionRosterLaunchTransaction(
    service,
    teamName,
    transactionId,
    proofRequired,
    durableMembers,
    request
  );
  const durableTransaction = await commitProductionRosterLaunchTransaction(
    service,
    teamName,
    transaction,
    durableMembers,
    request
  );
  const context = createRosterAuthorizedLaunchContext(
    service,
    teamName,
    durableTransaction.transactionId,
    transaction.admission,
    durableTransaction.ownsTransaction
  );
  if (!context.valid) throw new Error(context.error);
  return context;
}

export async function admitProductionTeamCreateRosterLaunch(
  service: TeamDataService,
  request: TeamCreateRequest,
  existingTransactionId: string | undefined,
  proofRequired: boolean,
  members: readonly TeamMember[]
): Promise<AdmittedProductionRosterLaunch<TeamCreateRequest>> {
  if (!verifyProductionTeamCreateRequest(request, proofRequired)) {
    throw new Error('Fresh authoritative launch authorization is required');
  }
  const admittedRequest = authorizeProductionTeamCreateRequest(
    assignProductionRosterTransactionId(request, proofRequired),
    proofRequired
  );
  const context = await createProductionRosterLaunchContext(
    service,
    request.teamName,
    existingTransactionId,
    proofRequired,
    members,
    admittedRequest
  );
  return {
    request: { ...admittedRequest, rosterTransactionId: context.transactionId },
    context,
  };
}

export async function admitProductionTeamRosterLaunch(
  service: TeamDataService,
  request: TeamLaunchRequest,
  existingTransactionId: string | undefined,
  proofRequired: boolean,
  members: readonly TeamMember[]
): Promise<AdmittedProductionRosterLaunch<TeamLaunchRequest>> {
  if (!verifyProductionTeamLaunchRequest(request, members, proofRequired)) {
    throw new Error('Fresh authoritative launch authorization is required');
  }
  const admittedRequest = authorizeProductionTeamLaunchRequest(
    assignProductionRosterTransactionId(request, proofRequired),
    members,
    proofRequired
  );
  const context = await createProductionRosterLaunchContext(
    service,
    request.teamName,
    existingTransactionId,
    proofRequired,
    members,
    admittedRequest
  );
  return {
    request: { ...admittedRequest, rosterTransactionId: context.transactionId },
    context,
  };
}
