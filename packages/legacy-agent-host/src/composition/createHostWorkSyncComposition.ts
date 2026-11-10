import { createHash } from 'node:crypto';
import { runtimeDigest, normalizeBinding } from '../runtime/identity.js';

import { createNativeWorkSyncMessagePorts } from '../work-sync/createNativeWorkSyncMessagePorts.js';
import {
  createNativeWorkSyncOutbox,
  readNativeWorkSyncOutboxOrigins,
} from '../work-sync/storage/createNativeWorkSyncOutbox.js';
import { settleNativeWorkSyncDelivery } from '../work-sync/createNativeWorkSyncDelivery.js';

import { McpToolFailure } from '../mcp/contracts.js';
import { TeamOwnerError } from '../team/contracts.js';
import { createNativeMemberWorkSyncAgendaSource } from '../work-sync/createNativeMemberWorkSyncAgendaSource.js';
import { MemberWorkSyncReconciler } from '../work-sync/policy/core/application/MemberWorkSyncReconciler.js';
import { MemberWorkSyncReporter } from '../work-sync/policy/core/application/MemberWorkSyncReporter.js';
import { MemberWorkSyncTeamOperationGate } from '../work-sync/policy/core/application/MemberWorkSyncTeamOperationGate.js';
import { createNativeMemberWorkSyncPersistence } from '../work-sync/storage/createNativeMemberWorkSyncPersistence.js';
import { MemberWorkSyncWriteQueue } from '../work-sync/storage/MemberWorkSyncWriteQueue.js';

import type { JsonValue } from '../contracts.js';
import type { TeamMcpWorkSyncPort } from '../mcp/workSyncContracts.js';
import type { NativeWorkSyncMemberContext } from './nativeWorkSyncContext.js';
import type { captureNativeInputAuthority } from './captureNativeInputAuthority.js';
import type { MemberWorkSyncStatus } from '../work-sync/policy/contracts/index.js';
import type { MemberWorkSyncOutboxStorePort } from '../work-sync/policy/core/application/ports.js';

type LifecycleIdentity = Parameters<typeof createNativeMemberWorkSyncPersistence>[0]['identity'];
type Original = ReturnType<typeof captureNativeInputAuthority>;
type Member = NativeWorkSyncMemberContext;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** Feature-owned queues and the original physical identity port; no Runtime control or second journal. */
export function createHostWorkSyncComposition(options: {
  teamsBasePath: string;
  identity(teamId: string, principalId: string): Promise<LifecycleIdentity>;
  /** Existing accepted-intent outbox adapter; composition must supply it before advertising forced delivery. */
  outbox?(
    member: Member,
    source: Original,
    identity: LifecycleIdentity
  ): MemberWorkSyncOutboxStorePort;
  assertCurrent(): void;
}) {
  const gate = new MemberWorkSyncTeamOperationGate();
  const queue = new MemberWorkSyncWriteQueue();
  return {
    member(member: Member): TeamMcpWorkSyncPort & {
      settleAccepted(): Promise<{ held: { commandId: string; code: 'hold' | 'forbidden' }[] }>;
    } {
      async function invoke(
        commandId: string,
        operation: 'status' | 'report',
        payload:
          | Parameters<TeamMcpWorkSyncPort['status']>[1]
          | Parameters<TeamMcpWorkSyncPort['report']>[1]
      ) {
        options.assertCurrent();
        const source = member.captureSource();
        source.assertCurrent();
        if (source.team.source.teamId !== member.teamId) throw new TeamOwnerError('forbidden');
        return gate.run(member.teamName, async () => {
          const identity = await options.identity(member.teamId, source.team.principalId);
          source.assertCurrent();
          options.assertCurrent();
          identity.assertWorkAllowed();
          if ('forceNudge' in payload && payload.forceNudge && !member.delivery && !options.outbox)
            throw new McpToolFailure('unsupported');
          return member.owner
            .workSyncCommands(source.team.principalId)
            .execute(commandId, operation, json(payload), source, async (original) => {
              let mutationOrdinal = 0;
              const assertCurrent = () => {
                options.assertCurrent();
                source.assertCurrent();
                identity.assertWorkAllowed();
              };
              const persistence = createNativeMemberWorkSyncPersistence({
                teamsBasePath: options.teamsBasePath,
                teamName: member.teamName,
                memberName: source.team.memberName,
                incarnation: source.team.source.teamId,
                identity,
                queue,
                assertCurrent,
                createMutationId: () => hash(`${original.mutationId}:${++mutationOrdinal}`),
              });
              const outboxStore =
                options.outbox?.(member, source, identity) ??
                (member.delivery
                  ? createNativeWorkSyncOutbox({
                      teamsBasePath: options.teamsBasePath,
                      teamName: member.teamName,
                      memberName: source.team.memberName,
                      queue,
                      original,
                      withPublication: persistence.withOriginalPublication,
                    })
                  : undefined);
              const now = () => new Date();
              const deps = {
                ...persistence,
                ...(member.delivery
                  ? createNativeWorkSyncMessagePorts({ member, team: source.team, assertCurrent })
                  : {}),
                ...(outboxStore ? { outboxStore } : {}),
                agendaSource: createNativeMemberWorkSyncAgendaSource({
                  owner: member.owner,
                  authority: source,
                  teamName: member.teamName,
                  sourceRevision: member.sourceRevision,
                  providerId: member.providerId,
                  now,
                  hash,
                }),
                clock: { now },
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
              };
              const request = { teamName: member.teamName, memberName: source.team.memberName };
              if (operation === 'status') {
                const status = await new MemberWorkSyncReconciler(deps).execute({
                  ...request,
                  ...payload,
                });
                assertCurrent();
                return json(requiredReport(commandId, status));
              }
              if (!('state' in payload)) throw new TeamOwnerError('invalid');
              const result = await new MemberWorkSyncReporter(deps).execute(
                { ...request, ...payload, source: 'mcp' },
                { receivedAt: original.receivedAt }
              );
              assertCurrent();
              return json(result);
            });
        });
      }
      return {
        status: (commandId, input) => invoke(commandId, 'status', input),
        report: (commandId, input) => invoke(commandId, 'report', input),
        async settleAccepted() {
          const delivery = member.delivery;
          if (!delivery) return { held: [] };
          return gate.run(member.teamName, async (admission) => {
            options.assertCurrent();
            delivery.assertCurrent();
            const accepted = member.owner.workSyncCommands(delivery.principalId).accepted();
            if (accepted.length === 0) return { held: [] };
            // This is a private read of the existing bounded command inventory, never a new pending-work registry.
            const record = delivery.readRuntime().record;
            if (
              !record ||
              record.phase !== 'allocated' ||
              record.sealed ||
              record.custody !== 'owned' ||
              record.inputs.some((row) => ['claimed', 'consumed', 'unknown'].includes(row.phase))
            )
              return { held: [] };
            if (
              runtimeDigest({ binding: record.binding, configuration: record.config }) !==
              member.sourceRevision
            )
              throw new TeamOwnerError('hold');
            const actor = member.owner
              .connect(delivery.principalId)
              .readRoster()
              .members.find((row) => row.memberId === record.binding.memberId);
            if (!actor) throw new TeamOwnerError('forbidden');
            const readIdentity = await options.identity(member.teamId, delivery.principalId);
            const pendingResult = await readIdentity.withCurrentPublication(
              member.teamName,
              member.teamId,
              async (identityCurrent) => {
                const assertCurrent = () => {
                  options.assertCurrent();
                  delivery.assertCurrent();
                  identityCurrent();
                };
                return readNativeWorkSyncOutboxOrigins({
                  teamsBasePath: options.teamsBasePath,
                  teamName: member.teamName,
                  memberName: actor.name,
                  assertCurrent,
                });
              }
            );
            if (!pendingResult.current) throw new TeamOwnerError('hold');
            const pending = pendingResult.value;
            const originals = accepted.filter((original) => {
              const header = original.nativeInput.runtime;
              return (
                pending.has(original.commandId) &&
                header &&
                original.nativeInput.team.actorId === actor.memberId &&
                original.nativeInput.team.memberName === actor.name &&
                header.profileId === record.profileId &&
                header.hostIncarnation === record.hostIncarnation &&
                header.configHash === runtimeDigest(record.config) &&
                header.openFingerprint === record.openFingerprint &&
                runtimeDigest(normalizeBinding(original.nativeInput.team.source)) ===
                  runtimeDigest(normalizeBinding(record.binding))
              );
            });
            const held: { commandId: string; code: 'hold' | 'forbidden' }[] = [];
            for (const original of originals) {
              try {
                const identity = await options.identity(member.teamId, original.principalId);
                await settleNativeWorkSyncDelivery({
                  teamsBasePath: options.teamsBasePath,
                  member,
                  original,
                  identity,
                  queue,
                  admission,
                  assertCurrent: options.assertCurrent,
                });
              } catch (error) {
                // Each row keeps its own original proof. One unavailable original cannot donate authority to or block another.
                if (
                  !(error instanceof TeamOwnerError) ||
                  (error.code !== 'hold' && error.code !== 'forbidden')
                )
                  throw error;
                held.push({ commandId: original.commandId, code: error.code });
              }
            }
            return { held };
          });
        },
      };
    },
    async close() {
      gate.close();
      await gate.awaitIdle();
    },
  };
}

function requiredReport(commandId: string, status: MemberWorkSyncStatus) {
  if (!status.reportToken) return status;
  return {
    ...status,
    statusOnlyIncomplete: true,
    nextRequiredAction:
      'Call member_work_sync_report in this same turn using nextRequiredToolCall.arguments before going idle.',
    nextRequiredToolCall: {
      tool: 'member_work_sync_report',
      arguments: {
        commandId: `work-sync-report:${hash(commandId)}`,
        state: status.agenda.items.length ? 'still_working' : 'caught_up',
        agendaFingerprint: status.agenda.fingerprint,
        reportToken: status.reportToken,
        taskIds: status.agenda.items.map((item) => item.taskId),
      },
    },
  };
}
