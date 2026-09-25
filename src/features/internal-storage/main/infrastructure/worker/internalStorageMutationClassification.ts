import type { InternalStorageWorkerOp } from './internalStorageWorkerProtocol';

const READ_ONLY_APPLICATION_COMMAND_OPS = new Set<InternalStorageWorkerOp>([
  'appCommandLedger.getByCommandId',
  'appCommandLedger.getByIdempotencyKey',
  'appCommandLedger.listByScope',
  'appCommandLedger.durable.getStatus',
  'appCommandLedger.durable.getByClaim',
  'appCommandLedger.durable.listOutbox',
  'appCommandLedger.durable.getConsumerProjection',
]);

const READ_ONLY_MEMBER_WORK_SYNC_OPS = new Set<InternalStorageWorkerOp>([
  'mws.status.read',
  'mws.status.list',
  'mws.metricEvents.list',
  'mws.reports.listPending',
  'mws.outbox.countRecentDelivered',
  'mws.outbox.countDeliveredForAgenda',
  'mws.outbox.findDeliveredReviewPickupEventIds',
  'mws.outbox.findRecentRecoveryByIntent',
  'mws.snapshot.list',
]);

const READ_ONLY_COORDINATION_OPS = new Set<InternalStorageWorkerOp>([
  // Initialization performs its own admission check only when metadata is absent.
  'coordinationEvents.initialize',
  'coordinationEvents.getWatermark',
  'coordinationEvents.read',
  'coordinationBackupRuns.get',
  'coordinationBackupRuns.listRecoverable',
  'coordinationBackup.sqlite.verify',
  'coordinationBackup.sqlite.readChunk',
]);

const READ_ONLY_HOSTED_TEAM_APPROVAL_AUTHORITY_OPS = new Set<InternalStorageWorkerOp>([
  'hostedTeamApprovalAuthority.readPending',
  'hostedTeamApprovalAuthority.readPreview',
]);

const READ_ONLY_HOSTED_TEAM_CONFIGURATION_OPS = new Set<InternalStorageWorkerOp>([
  'hostedTeamConfiguration.read',
]);

export function isInternalStorageMutation(op: InternalStorageWorkerOp): boolean {
  switch (op) {
    case 'teamIdentity.snapshot':
    case 'ping':
    case 'stallJournal.load':
    case 'commentJournal.load':
    case 'commentJournal.exists':
    case 'storeImports.has':
    case 'teamIdentity.list':
    case 'teamIdentity.listActive':
    case 'teamIdentity.captureExternalWriterInventory':
    case 'hostedPromotion.lookup':
    case 'hostedPromotion.lookupRosterBinding':
    case 'hostedLifecycleRun.lookup':
    case 'hostedLifecycleRun.lookupByResource':
    case 'hostedLifecycleRun.currentPlanGeneration':
    case 'draftPublication.lookup':
    case 'draftPublication.read':
    case 'teamIdentity.get':
    case 'teamRoster.get':
    case 'externalWriterObservation.load':
    case 'externalWriterReconciliation.get':
    case 'processOwnership.loadByScope':
    case 'processOwnership.loadByProcessRef':
    case 'processOwnership.list':
    case 'close':
      return false;
    default:
      if (op.startsWith('appCommandLedger.')) return !READ_ONLY_APPLICATION_COMMAND_OPS.has(op);
      if (op.startsWith('mws.')) return !READ_ONLY_MEMBER_WORK_SYNC_OPS.has(op);
      if (op.startsWith('coordination')) return !READ_ONLY_COORDINATION_OPS.has(op);
      if (op.startsWith('hostedTeamApprovalAuthority.')) {
        return !READ_ONLY_HOSTED_TEAM_APPROVAL_AUTHORITY_OPS.has(op);
      }
      if (op.startsWith('hostedTeamConfiguration.')) {
        return !READ_ONLY_HOSTED_TEAM_CONFIGURATION_OPS.has(op);
      }
      return true;
  }
}
