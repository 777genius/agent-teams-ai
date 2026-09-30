import {
  parseActorId,
  parseBootId,
  parseDeploymentId,
  parseMemberId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';

import type { InternalStorageWorkerTransport } from './InternalStorageWorkerTransport';
import type { HostedCurrentMemberAdmission } from './worker/hostedCurrentMemberAdmissionOps';

const SHA = /^[0-9a-f]{64}$/u;
const LANE = /^lane_[0-9a-f]{32}$/u;
const PROMOTION = /^promotion_[0-9a-f]{32}$/u;
const FIELDS = [
  'kind',
  'runId',
  'deploymentId',
  'bootId',
  'workspaceId',
  'runtimeWorkspaceId',
  'teamId',
  'actorId',
  'memberId',
  'laneId',
  'laneOrdinal',
  'memberOrdinal',
  'memberName',
  'model',
  'promptSha256',
  'planSha256',
  'rosterBindingSha256',
  'promotionOperationId',
  'grantRevision',
  'grantGeneration',
  'restoreGeneration',
  'mountGeneration',
] as const;

function parseCurrentMemberAdmission(value: unknown): HostedCurrentMemberAdmission | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('hosted-member-admission-result-invalid');
  }
  const row = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(row).length !== FIELDS.length ||
    !FIELDS.every((field) => Object.hasOwn(row, field)) ||
    row.kind !== 'admitted' ||
    typeof row.laneId !== 'string' ||
    !LANE.test(row.laneId) ||
    typeof row.promotionOperationId !== 'string' ||
    !PROMOTION.test(row.promotionOperationId) ||
    typeof row.memberName !== 'string' ||
    row.memberName.length < 1 ||
    Buffer.byteLength(row.memberName, 'utf8') > 256 ||
    typeof row.model !== 'string' ||
    row.model.length < 1 ||
    Buffer.byteLength(row.model, 'utf8') > 256 ||
    ![row.promptSha256, row.planSha256, row.rosterBindingSha256, row.grantRevision].every(
      (field) => typeof field === 'string' && SHA.test(field)
    ) ||
    ![row.laneOrdinal, row.memberOrdinal].every(
      (field) => Number.isSafeInteger(field) && (field as number) >= 0 && (field as number) < 32
    ) ||
    ![row.grantGeneration, row.restoreGeneration].every(
      (field) => Number.isSafeInteger(field) && (field as number) >= 0
    ) ||
    !Number.isSafeInteger(row.mountGeneration) ||
    (row.mountGeneration as number) < 1
  ) {
    throw new TypeError('hosted-member-admission-result-invalid');
  }
  parseRunId(row.runId);
  parseDeploymentId(row.deploymentId);
  parseBootId(row.bootId);
  parseWorkspaceId(row.workspaceId);
  parseWorkspaceId(row.runtimeWorkspaceId);
  parseTeamId(row.teamId);
  parseActorId(row.actorId);
  parseMemberId(row.memberId);
  return Object.freeze({ ...row }) as unknown as HostedCurrentMemberAdmission;
}

/** Internal Product point-in-time query. No browser or launch surface uses it. */
export function createHostedCurrentMemberAdmissionWorkerClient(
  call: InternalStorageWorkerTransport['call']
): { resolve(runId: string, memberId: string): Promise<HostedCurrentMemberAdmission | null> } {
  return Object.freeze({
    async resolve(runId: string, memberId: string): Promise<HostedCurrentMemberAdmission | null> {
      return parseCurrentMemberAdmission(
        await call('hostedLifecycleRun.resolveMember', {
          runId: parseRunId(runId),
          memberId: parseMemberId(memberId),
        })
      );
    },
  });
}
