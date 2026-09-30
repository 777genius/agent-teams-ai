import { AsyncLocalStorage } from 'node:async_hooks';

import type { TeamBackupService } from '../TeamBackupService';

export type TeamWriterAdmissionOwner = Pick<TeamBackupService, 'workSyncIdentity'>;
const WORKFLOW_WRITE_DEADLINE_MS = 30_000;
interface CapturedWriterIdentity {
  identityId: string;
  writeDeadlineMs: number;
}
const workflowIdentities = new AsyncLocalStorage<ReadonlyMap<string, CapturedWriterIdentity>>();

/**
 * Cooperative app-owned writer contract: capture one team generation at ingress, keep
 * provider I/O outside the fence, and admit each local commit against that generation.
 * A queued continuation must retain this async context or pass its captured identity.
 * This contract cannot authorize deletion of a pathname controlled by another process.
 */

async function observeWriterIdentity(
  owner: TeamWriterAdmissionOwner | undefined,
  teamName: string
): Promise<string> {
  if (!owner) {
    throw new Error('operator_required: durable team writer admission is unavailable');
  }
  const initial = await owner.workSyncIdentity.readCurrent(teamName);
  const observed =
    initial.status === 'unidentified' && initial.reason === 'missing_marker'
      ? await owner.workSyncIdentity.adoptLegacy(teamName)
      : initial;
  if (observed.status !== 'identified') {
    throw new Error(`operator_required: team writer identity is unavailable: ${teamName}`);
  }
  return observed.identityId;
}

/** Capture a generation once across provider I/O and queued continuations. */
export async function withCapturedTeamWriterIdentity<T>(
  owner: TeamWriterAdmissionOwner | undefined,
  teamName: string,
  operation: () => Promise<T>
): Promise<T> {
  const parent = workflowIdentities.getStore();
  const captured = parent?.get(teamName) ?? {
    identityId: await observeWriterIdentity(owner, teamName),
    writeDeadlineMs: Date.now() + WORKFLOW_WRITE_DEADLINE_MS,
  };
  await withTeamWriterAdmission(owner, teamName, async () => undefined, captured);
  const identities = new Map(parent ?? []);
  identities.set(teamName, captured);
  return workflowIdentities.run(identities, operation);
}

/** Bind a local persistence commit to the identity observed when work began. */
export function withTeamWriterAdmission<T>(
  owner: TeamWriterAdmissionOwner | undefined,
  teamName: string,
  operation: () => Promise<T>,
  expectedIdentity?: CapturedWriterIdentity
): Promise<T> {
  if (!owner) {
    throw new Error('operator_required: durable team writer admission is unavailable');
  }
  const captured = expectedIdentity ?? workflowIdentities.getStore()?.get(teamName);
  return (
    captured
      ? Promise.resolve(captured)
      : observeWriterIdentity(owner, teamName).then((identityId) => ({
          identityId,
          writeDeadlineMs: Date.now() + WORKFLOW_WRITE_DEADLINE_MS,
        }))
  ).then(async ({ identityId, writeDeadlineMs }) => {
    const admitted = await owner.workSyncIdentity.withCurrent(teamName, identityId, () => {
      if (Date.now() > writeDeadlineMs) {
        throw new Error(`operator_required: team writer workflow expired: ${teamName}`);
      }
      return operation();
    });
    if (!admitted.current) {
      throw new Error(`operator_required: team writer admission changed: ${teamName}`);
    }
    return admitted.value;
  });
}

/** Check authority without holding the identity lock across provider I/O. */
export async function sendWithTeamWriterPreflight<T>(
  owner: TeamWriterAdmissionOwner | undefined,
  teamName: string,
  send: () => Promise<T>
): Promise<T> {
  if (!owner) {
    throw new Error('operator_required: durable team writer admission is unavailable');
  }
  return owner.workSyncIdentity.withWriterWorkflowLease(teamName, () =>
    withCapturedTeamWriterIdentity(owner, teamName, send)
  );
}
