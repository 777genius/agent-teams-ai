import { createHash, randomUUID } from 'node:crypto';

import { TeamOwnerError } from '../team/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { assertAcceptedNativeWorkSyncInput } from './assertAcceptedNativeWorkSyncInput.js';
import { createNativeMemberWorkSyncAgendaSource } from './createNativeMemberWorkSyncAgendaSource.js';
import { MemberWorkSyncNudgeDispatcher } from './policy/core/application/MemberWorkSyncNudgeDispatcher.js';
import { createNativeMemberWorkSyncPersistence } from './storage/createNativeMemberWorkSyncPersistence.js';
import { createNativeWorkSyncMessagePorts } from './createNativeWorkSyncMessagePorts.js';
import { createNativeWorkSyncOutbox } from './storage/createNativeWorkSyncOutbox.js';

import type { NativeWorkSyncMemberContext } from '../composition/nativeWorkSyncContext.js';
import type { WorkSyncCommandReceipt } from './commandContracts.js';
import type { MemberWorkSyncWriteQueue } from './storage/MemberWorkSyncWriteQueue.js';
import type { MemberWorkSyncTeamOperationAdmission } from './policy/core/application/MemberWorkSyncTeamOperationGate.js';
import type { MemberWorkSyncUseCaseDeps } from './policy/core/application/ports.js';

type Identity = Parameters<typeof createNativeMemberWorkSyncPersistence>[0]['identity'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Consumes the same completed feature receipt and original outbox; no active-input recapture or direct native send. */
export async function settleNativeWorkSyncDelivery(options: {
  teamsBasePath: string;
  member: NativeWorkSyncMemberContext;
  original: Readonly<WorkSyncCommandReceipt>;
  identity: Identity;
  queue: MemberWorkSyncWriteQueue;
  admission: MemberWorkSyncTeamOperationAdmission;
  assertCurrent(): void;
}): Promise<void> {
  const { member, original, identity } = options;
  const delivery = member.delivery;
  if (!delivery) throw new TeamOwnerError('hold');
  const assertCurrent = () => {
    options.assertCurrent();
    assertAcceptedNativeWorkSyncInput({ original, ...delivery });
    identity.assertWorkAllowed();
  };
  assertCurrent();
  const record = delivery.readRuntime().record;
  const input = record?.inputs.find(
    (row) => row.intent.inputId === original.nativeInput.original.inputId
  );
  if (!input) throw new TeamOwnerError('hold');
  const originalIntent = structuredClone(input.intent);
  const authority = {
    team: original.nativeInput.team,
    fingerprint: original.inputAuthority,
    assertCurrent,
    assertTeamCurrent() {
      if (
        runtimeDigest(delivery.captureTeam(originalIntent)) !==
        runtimeDigest(original.nativeInput.team)
      )
        throw new TeamOwnerError('forbidden');
    },
  };
  const persistence = createNativeMemberWorkSyncPersistence({
    teamsBasePath: options.teamsBasePath,
    teamName: member.teamName,
    memberName: authority.team.memberName,
    incarnation: authority.team.source.teamId,
    identity,
    queue: options.queue,
    assertCurrent,
    createMutationId: randomUUID,
  });
  const outboxStore = createNativeWorkSyncOutbox({
    teamsBasePath: options.teamsBasePath,
    teamName: member.teamName,
    memberName: authority.team.memberName,
    queue: options.queue,
    original,
    withPublication: persistence.withOriginalPublication,
  });
  const deps: MemberWorkSyncUseCaseDeps = {
    ...persistence,
    outboxStore,
    agendaSource: createNativeMemberWorkSyncAgendaSource({
      owner: member.owner,
      authority,
      teamName: member.teamName,
      sourceRevision: member.sourceRevision,
      providerId: member.providerId,
      now: () => new Date(),
      hash,
    }),
    clock: { now: () => new Date() },
    hash: { sha256Hex: hash },
    lifecycle: {
      isTeamActive: () => {
        assertCurrent();
        return true;
      },
      isMemberActive: () => {
        assertCurrent();
        return true;
      },
    },
    ...createNativeWorkSyncMessagePorts({ member, team: authority.team, assertCurrent }),
  };
  await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
    claimedBy: `host-work-sync:${original.inputAuthority}`,
    teamNames: [member.teamName],
    limit: 10,
    trackSettlingWork: (_team, work) => options.admission.trackSettling(work),
  });
  assertCurrent();
}
