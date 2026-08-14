import { createHash } from 'node:crypto';

import { bindTrustedEventAttribution } from '@features/coordination-events';

import type {
  ExternalFileReconciliationResult,
  ExternalFileSourceFingerprint,
} from '@features/external-writer-coordination';
import type { TeamIdentityRecord } from '@features/internal-storage/contracts';
import type { ExternalWriterReconciliationStorageGateway } from '@features/internal-storage/main';
import type {
  HostedMessageExternalWriterAuthority,
  HostedMessageExternalWriterReconciliationCommit,
  HostedMessageExternalWriterTarget,
} from '@features/team-message-delivery';
import type {
  HostedTaskExternalWriterAuthority,
  HostedTaskExternalWriterReconciliationCommit,
  HostedTaskExternalWriterTarget,
} from '@features/team-task-board';
import type { TeamId } from '@shared/contracts/hosted';

type ExternalCommit =
  | HostedTaskExternalWriterReconciliationCommit
  | HostedMessageExternalWriterReconciliationCommit;

interface ExternalWriterAuthorityDependencies {
  readonly deploymentId: string;
  readonly storage: ExternalWriterReconciliationStorageGateway;
  readonly notifyDurableCommit: () => Promise<void>;
  readonly teamIdentities: {
    getTeamIdentity(teamId: TeamId): Promise<TeamIdentityRecord | null>;
  };
}

const eventId = (kind: 'task' | 'inbox', reconciliationId: string): string =>
  `external-${kind}-${createHash('sha256').update(reconciliationId, 'utf8').digest('hex')}`;

function timestamp(fingerprint: ExternalFileSourceFingerprint): string {
  if (!fingerprint.exists || fingerprint.statIdentity === null) return new Date(0).toISOString();
  const nanoseconds = BigInt(fingerprint.statIdentity.changedTimeNs);
  return new Date(Number(nanoseconds / 1_000_000n)).toISOString();
}

function generation(fingerprint: ExternalFileSourceFingerprint): number {
  if (!fingerprint.exists || fingerprint.statIdentity === null) return 0;
  return Number(BigInt(`0x${fingerprint.checksum}`) % BigInt(Number.MAX_SAFE_INTEGER));
}

function resultFromBody(bodyJson: string): ExternalFileReconciliationResult {
  const body = JSON.parse(bodyJson) as {
    readonly resourceRevision?: { readonly generation?: unknown; readonly revision?: unknown };
  };
  const sourceGeneration = body.resourceRevision?.generation;
  const featureRevision = body.resourceRevision?.revision;
  if (
    !Number.isSafeInteger(sourceGeneration) ||
    (sourceGeneration as number) < 0 ||
    !Number.isSafeInteger(featureRevision) ||
    (featureRevision as number) < 0
  ) {
    throw new Error('hosted-external-writer-journal-result-invalid');
  }
  return Object.freeze({
    outcome: 'accepted_change',
    sourceGeneration: sourceGeneration as number,
    featureRevision: featureRevision as number,
  });
}

abstract class HostedExternalWriterAuthorityBase {
  protected constructor(protected readonly dependencies: ExternalWriterAuthorityDependencies) {}

  protected async resolveTeam(teamId: TeamId): Promise<TeamIdentityRecord | null> {
    const identity = await this.dependencies.teamIdentities.getTeamIdentity(teamId);
    return identity?.state === 'active' && identity.workspaceBinding !== null ? identity : null;
  }

  protected async get(reconciliationId: string): Promise<ExternalFileReconciliationResult | null> {
    const receipt = await this.dependencies.storage.getExternalWriterReconciliation({
      deploymentId: this.dependencies.deploymentId,
      reconciliationId,
    });
    return receipt ? resultFromBody(receipt.eventBodyJson) : null;
  }

  protected async commitObserved(input: ExternalCommit): Promise<ExternalFileReconciliationResult> {
    const sourceGeneration = generation(input.observation.fingerprint);
    const featureRevision = input.observation.observationSequence;
    const committed = Object.freeze({
      sourceGeneration,
      featureRevision,
      emittedAt: timestamp(input.observation.fingerprint),
    });
    const command = input.buildCommittedCoordinationEvent(committed);
    const event = bindTrustedEventAttribution(command);
    const inputSha256 = createHash('sha256')
      .update(JSON.stringify({ observation: input.observation, effect: input.effect }), 'utf8')
      .digest('hex');
    const stored = await this.dependencies.storage.commitExternalWriterReconciliation({
      deploymentId: this.dependencies.deploymentId,
      receipt: {
        reconciliationId: input.reconciliationId,
        inputSha256,
        eventId: event.eventId,
        sourceGeneration,
        featureRevision,
        eventBodyJson: '',
        committedAt: event.emittedAt,
      },
      event,
    });
    if (stored.outcome === 'input_conflict') {
      return Object.freeze({ outcome: 'conflict', diagnosticCode: 'reconciliation_id_reused' });
    }
    await this.dependencies.notifyDurableCommit();
    return Object.freeze({ outcome: 'accepted_change', sourceGeneration, featureRevision });
  }
}

export class HostedTaskExternalWriterJournalAuthority
  extends HostedExternalWriterAuthorityBase
  implements HostedTaskExternalWriterAuthority
{
  constructor(dependencies: ExternalWriterAuthorityDependencies) {
    super(dependencies);
  }

  async resolveTaskTarget(input: {
    readonly teamId: TeamId;
    readonly fileKey: string;
  }): Promise<HostedTaskExternalWriterTarget | null> {
    const identity = await this.resolveTeam(input.teamId);
    return identity === null
      ? null
      : Object.freeze({
          workspaceId: identity.workspaceBinding!.workspaceId,
          taskId: input.fileKey,
        });
  }

  createEventId(input: { readonly reconciliationId: string }): string {
    return eventId('task', input.reconciliationId);
  }

  getResult(reconciliationId: string): Promise<ExternalFileReconciliationResult | null> {
    return this.get(reconciliationId);
  }

  commit(
    input: HostedTaskExternalWriterReconciliationCommit
  ): Promise<ExternalFileReconciliationResult> {
    return this.commitObserved(input);
  }
}

export class HostedMessageExternalWriterJournalAuthority
  extends HostedExternalWriterAuthorityBase
  implements HostedMessageExternalWriterAuthority
{
  constructor(dependencies: ExternalWriterAuthorityDependencies) {
    super(dependencies);
  }

  async resolveInboxTarget(input: {
    readonly teamId: TeamId;
    readonly fileKey: string;
  }): Promise<HostedMessageExternalWriterTarget | null> {
    const identity = await this.resolveTeam(input.teamId);
    return identity === null
      ? null
      : Object.freeze({
          workspaceId: identity.workspaceBinding!.workspaceId,
          inboxId: input.fileKey,
        });
  }

  deriveLegacyMessageId(input: {
    readonly from: string;
    readonly timestamp: string;
    readonly text: string;
  }): string {
    return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
  }

  createEventId(input: { readonly reconciliationId: string }): string {
    return eventId('inbox', input.reconciliationId);
  }

  getResult(reconciliationId: string): Promise<ExternalFileReconciliationResult | null> {
    return this.get(reconciliationId);
  }

  commit(
    input: HostedMessageExternalWriterReconciliationCommit
  ): Promise<ExternalFileReconciliationResult> {
    return this.commitObserved(input);
  }
}
