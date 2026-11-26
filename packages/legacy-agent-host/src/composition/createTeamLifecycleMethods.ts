import { z } from 'zod';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import type { HostMethod } from '../index.js';
import type { JsonValue } from '../contracts.js';
import type { HostedTeam } from './MemberEntry.js';
import type { HostProjectTeamLifecycle } from '../team-project-context/HostProjectTeamLifecycle.js';
import type { TeamRuntimeDeliveryPort } from '../team/contracts.js';
import type { createTeamBackupComposition } from './createTeamBackupComposition.js';
import type { QueuedDiscardReceipt } from '../team/queuedDiscardContracts.js';
import type { createTeamLifecycleRetirement } from './createTeamLifecycleRetirement.js';
const id = z.string().min(1).max(256).refine(value => !!value.trim() && !value.includes('\0'));
const change = z.object({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(['trash', 'restore']) }).strict();
const purge = z.object({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const discard = z.object({ member: id, messageIds: z.array(id).max(4096).refine(ids => new Set(ids).size === ids.length) }).strict();
const envelope = z.object({ binding: z.object({ schemaVersion: z.literal(1), handleId: id, owner: z.unknown(), scope: z.unknown() }).strict(), commandId: id, payload: z.unknown() }).strict();
const queueValue = (receipt: QueuedDiscardReceipt) => receipt.phase === 'completed'
  ? { kind: 'queued_discard', commandId: receipt.commandId, phase: receipt.phase, discarded: receipt.discardedMessageIds!.length, remainingQueued: receipt.remainingQueued! }
  : { kind: 'queued_discard', commandId: receipt.commandId, phase: receipt.phase };
/** Existing Team controls; raw cleanup bindings, source receipts and native selectors stay private. */
export function createTeamLifecycleMethods(options: {
  profile: { owner: unknown; principalId: string }; teams: ReadonlyMap<string, HostedTeam>;
  storage: ReturnType<typeof createTeamBackupComposition>; assertCurrent(): void;
  retirement: ReturnType<typeof createTeamLifecycleRetirement>;
  projects: Pick<HostProjectTeamLifecycle, 'read' | 'change' | 'lookup' | 'purge' | 'lookupPurge'>;
  delivery(): TeamRuntimeDeliveryPort;
}) {
  const methods: Record<string, HostMethod> = {};
  methods['team.lifecycle.retired.read'] = { lane: 'control', async handle(raw): Promise<JsonValue> {
    try {
      options.assertCurrent();
      const input = z.object({ owner: z.unknown(), contextId: id }).strict().parse(raw);
      if (digest(input.owner) !== digest(options.profile.owner)) throw new TeamOwnerError('forbidden');
      return { ok: true, value: { teamIds: options.retirement.list(input.contextId) } };
    } catch (error) { return { ok: false, code: error instanceof TeamOwnerError ? error.code : 'invalid', outcome: 'not-dispatched' }; }
  } };
  for (const operation of ['lifecycle.read', 'lifecycle.change', 'lifecycle.lookup', 'lifecycle.purge', 'lifecycle.purge.lookup', 'queue.read', 'queue.discard', 'queue.lookup', 'backup.snapshot', 'backup.reconcile'] as const) {
    methods[`team.${operation}`] = { lane: ['lifecycle.change', 'lifecycle.purge', 'queue.discard'].includes(operation) ? 'work' : 'control',
      async handle(raw): Promise<JsonValue> {
        let effect = false;
        try {
          options.assertCurrent(); const input = envelope.parse(raw), scope = input.binding.scope as { teamId?: unknown } | null;
          const selected = scope && typeof scope.teamId === 'string' ? options.teams.get(scope.teamId) : undefined;
          if (selected && (digest(input.binding.owner) !== digest(options.profile.owner) || digest(input.binding.scope) !== digest(selected.definition.scope))) throw new TeamOwnerError('forbidden');
          if (operation === 'lifecycle.purge.lookup') {
            const payload = z.object({ expected: purge }).strict().parse(input.payload);
            const value = selected && !options.retirement.isRetired(selected.definition)
              ? await options.projects.lookupPurge({ team: selected, handleId: input.binding.handleId }, input.commandId, payload.expected.expectedRevision)
              : await options.retirement.lookup(input.binding, input.commandId, payload.expected.expectedRevision);
            options.assertCurrent();
            return { ok: true, value: JSON.parse(JSON.stringify(value)) as JsonValue };
          }
          if (!selected || digest(input.binding.owner) !== digest(options.profile.owner) || digest(input.binding.scope) !== digest(selected.definition.scope)) throw new TeamOwnerError('forbidden');
          const target = { team: selected, handleId: input.binding.handleId };
          let value: unknown;
          switch (operation) {
            case 'lifecycle.read': {
              z.object({}).strict().parse(input.payload);
              value = options.projects.read(target); break;
            }
            case 'lifecycle.change': {
              const payload = change.parse(input.payload); effect = true;
              value = await options.projects.change(target, input.commandId, payload); break;
            }
            case 'lifecycle.purge': {
              const payload = purge.parse(input.payload); effect = true;
              value = await options.projects.purge(target, input.commandId, payload.expectedRevision); break;
            }
            case 'lifecycle.lookup': {
              const payload = z.object({ expected: change }).strict().parse(input.payload);
              value = options.projects.lookup(target, input.commandId, payload.expected); break;
            }
            case 'queue.read': {
              const payload = z.object({ member: id }).strict().parse(input.payload);
              const queue = selected.owner.queuedMessages(options.profile.principalId, options.delivery());
              value = { kind: 'queued_user_messages', ...await queue.list(payload.member) }; break;
            }
            case 'queue.discard': {
              const payload = discard.parse(input.payload); effect = true;
              value = queueValue(await selected.owner.queuedMessages(options.profile.principalId, options.delivery()).discard({ ...payload, commandId: input.commandId })); break;
            }
            case 'queue.lookup': {
              const payload = z.object({ expected: discard }).strict().parse(input.payload);
              const receipt = selected.owner.queuedMessages(options.profile.principalId, options.delivery()).lookup(input.commandId, payload.expected);
              value = receipt ? queueValue(receipt) : null; break;
            }
            default:
              z.object({}).strict().parse(input.payload);
              effect = true;
              value = await options.storage.run(selected.definition.binding.teamId, operation === 'backup.reconcile' ? 'reconcile' : 'snapshot');
          }
          options.assertCurrent();
          return { ok: true, value: JSON.parse(JSON.stringify(value)) as JsonValue };
        } catch (error) {
          return { ok: false, code: error instanceof TeamOwnerError ? error.code : error instanceof z.ZodError ? 'invalid' : 'hold', outcome: effect ? 'unknown' : 'not-dispatched' };
        }
      },
    };
  }
  return { methods };
}
