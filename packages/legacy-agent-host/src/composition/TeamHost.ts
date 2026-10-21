import { z } from 'zod';

import { acquireProfileWriterLease } from '../adapters/profile/ProfileWriterLease.js';
import { createFilesystemTeamOwner } from '../adapters/team/createFilesystemTeamOwner.js';
import { createHostServer } from '../index.js';
import { TeamOwnerError } from '../team/contracts.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeProfileSchema } from './runtimeProfile.js';
import { RuntimeTeamCoordinator } from './RuntimeTeamCoordinator.js';

import type { HostMethod, HostServer, HostServerOptions } from '../index.js';
import type { JsonValue } from '../contracts.js';
import type { TeamCommand } from '../team/contracts.js';
import type { HostedTeam } from './RuntimeTeamCoordinator.js';
import type {
  MemberProvider,
  MemberProviderContext,
} from '../adapters/providers/ClaudeMemberProvider.js';

const id = z.string().min(1).max(256);
const segment = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const teamBinding = z.object({ backendId: segment, teamId: segment, teamName: segment }).strict();
const scope = z
  .object({
    projectId: id,
    workspaceId: id,
    teamId: segment,
    runId: id,
    memberId: id,
    generation: id,
  })
  .strict();
const owner = z
  .object({
    ownerId: id,
    revision: id,
    storageRoot: id,
    profileId: id,
    protocolVersion: z.literal(1),
    buildId: id,
    nodeSha256: hash,
    hostEntrySha256: hash,
  })
  .strict();

/** Private captured composition data, never an IPC/tool argument or renderer DTO. */
export const teamHostProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner,
    principalId: id,
    runtime: runtimeProfileSchema.optional(),
    teams: z
      .array(
        z
          .object({
            scope,
            binding: teamBinding,
            members: z
              .array(
                z
                  .object({
                    memberId: segment,
                    name: segment,
                    role: z.enum(['lead', 'member']),
                    delivery: teamBinding
                      .extend({ runId: id, memberId: segment, generation: id })
                      .strict()
                      .optional(),
                  })
                  .strict()
              )
              .max(256),
            grants: z
              .array(
                z
                  .object({
                    principalId: id,
                    memberName: segment,
                    permissions: z.array(z.enum(['read', 'task.write', 'message.write', 'admin'])),
                    revoked: z.boolean().optional(),
                  })
                  .strict()
              )
              .max(1024),
          })
          .strict()
      )
      .min(1)
      .max(256),
  })
  .strict();

export type TeamHostProfile = z.infer<typeof teamHostProfileSchema>;

const envelopeSchema = z
  .object({
    commandId: id,
    binding: z.object({ schemaVersion: z.literal(1), handleId: id, owner, scope }).strict(),
    payload: z.unknown(),
  })
  .strict();

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function equalFields(a: object, b: object): boolean {
  const left = Object.entries(a).sort(([x], [y]) => x.localeCompare(y));
  const right = Object.entries(b).sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Captured product owner and optional real provider Runtime. Aggregate bootstrap
 * readiness is separate from an individual native member's readiness.
 */
export function createTeamHost(
  rawProfile: TeamHostProfile,
  streams: Pick<HostServerOptions, 'input' | 'output' | 'limits'>,
  composition?: { createProvider(context: MemberProviderContext): MemberProvider }
): HostServer {
  const profile = structuredClone(teamHostProfileSchema.parse(rawProfile));
  const lease = acquireProfileWriterLease(profile.owner.storageRoot);
  let sealed = false;
  let runtime: RuntimeTeamCoordinator | undefined;
  try {
    const teams = new Map<string, HostedTeam>();
    for (const definition of profile.teams) {
      if (
        definition.binding.backendId !== profile.owner.ownerId ||
        definition.binding.teamId !== definition.scope.teamId ||
        teams.has(definition.binding.teamId)
      )
        throw new TeamOwnerError('invalid');
      const team = createFilesystemTeamOwner({
        root: profile.owner.storageRoot,
        binding: definition.binding,
        members: definition.members.map(({ memberId, name, role, delivery }) => ({
          memberId,
          name,
          role,
          ...(delivery ? { delivery } : {}),
        })),
        grants: definition.grants.map(({ principalId, memberName, permissions, revoked }) => ({
          principalId,
          memberName,
          permissions,
          ...(revoked === undefined ? {} : { revoked }),
        })),
      });
      teams.set(definition.binding.teamId, {
        definition,
        owner: team,
        connection: team.connect(profile.principalId),
      });
    }
    if (profile.runtime)
      runtime = new RuntimeTeamCoordinator({
        profile,
        teams,
        assertWriter: () => lease.assertCurrent(),
        ...(composition ? { createProvider: composition.createProvider } : {}),
      });

    const method = (
      operation: 'execute' | 'lookup' | 'getTask' | 'listTasks'
    ): NonNullable<HostServerOptions['methods']>[string] => ({
      lane: operation === 'execute' ? 'work' : 'control',
      async handle(raw) {
        try {
          if (sealed) throw new TeamOwnerError('hold');
          lease.assertCurrent();
          const input = envelopeSchema.parse(raw);
          const selected = teams.get(input.binding.scope.teamId);
          if (
            !selected ||
            !equalFields(input.binding.owner, profile.owner) ||
            !equalFields(input.binding.scope, selected.definition.scope)
          )
            throw new TeamOwnerError('forbidden');
          const connection = selected.connection;
          if (operation === 'lookup') {
            const receipt = connection.lookup(input.commandId);
            return { ok: true, value: receipt ? json(receipt) : null };
          }
          if (operation === 'listTasks') return { ok: true, value: json(connection.listTasks()) };
          if (operation === 'getTask') {
            const payload = z.object({ taskId: segment }).strict().parse(input.payload);
            return { ok: true, value: json(connection.getTask(payload.taskId)) };
          }
          const payload = z
            .object({ operation: id, payload: z.unknown() })
            .strict()
            .parse(input.payload);
          const command = { ...payload, commandId: input.commandId } as TeamCommand;
          let receipt;
          try {
            receipt = connection.execute(command);
          } catch (error) {
            if (
              !(error instanceof TeamOwnerError) ||
              error.code !== 'hold' ||
              !runtime ||
              command.operation === 'message.send'
            )
              throw error;
            await runtime.settleTeamCommands(selected.definition.binding.teamId);
            const saved = connection.lookup(input.commandId);
            if (!saved || (saved.phase !== 'completed' && saved.phase !== 'rejected')) throw error;
            receipt = saved;
          } finally {
            runtime?.kick();
          }
          return { ok: true, value: json(receipt) };
        } catch (error) {
          const code =
            error instanceof TeamOwnerError
              ? error.code
              : error instanceof z.ZodError
                ? 'invalid'
                : 'hold';
          return { ok: false, code, outcome: code === 'hold' ? 'unknown' : 'rejected' };
        }
      },
    });

    const runtimeMethods: Record<string, HostMethod> = {};
    if (runtime)
      for (const operation of [
        'open',
        'read',
        'dispatch',
        'stop',
        'interrupt',
        'interaction',
        'reconcile',
        'checkpoint',
      ]) {
        runtimeMethods[`runtime.${operation}`] = {
          lane: operation === 'open' || operation === 'dispatch' ? 'work' : 'control',
          async handle(raw) {
            try {
              if (sealed) throw new RuntimeOwnerError('hold');
              lease.assertCurrent();
              const input = envelopeSchema.parse(raw);
              const selected = teams.get(input.binding.scope.teamId);
              if (
                !selected ||
                !equalFields(input.binding.owner, profile.owner) ||
                !equalFields(input.binding.scope, selected.definition.scope)
              )
                throw new RuntimeOwnerError('forbidden');
              return {
                ok: true,
                value: await runtime!.execute(
                  selected.definition.binding.teamId,
                  operation,
                  input.payload
                ),
              };
            } catch (error) {
              const code =
                error instanceof RuntimeOwnerError || error instanceof TeamOwnerError
                  ? error.code
                  : error instanceof z.ZodError
                    ? 'invalid'
                    : 'hold';
              return { ok: false, code, outcome: code === 'hold' ? 'unknown' : 'rejected' };
            }
          },
        };
      }

    const server = createHostServer({
      ...streams,
      buildId: profile.owner.buildId,
      capabilities: [
        'team.task',
        'team.message',
        'team.command-outcome',
        ...(runtime ? ['runtime.member-session', 'runtime.checkpoint'] : []),
      ],
      methods: {
        'team.execute': method('execute'),
        'team.lookup': method('lookup'),
        'team.task.get': method('getTask'),
        'team.tasks.list': method('listTasks'),
        ...runtimeMethods,
      },
      onSeal() {
        sealed = true;
        runtime?.seal();
      },
      async onDispose() {
        try {
          await runtime?.close();
        } finally {
          lease.release();
        }
      },
    });
    runtime?.kick(); // Resume original durable obligations on startup, without opening/adopting native sessions.
    return server;
  } catch (error) {
    sealed = true;
    runtime?.seal();
    lease.release();
    throw error;
  }
}
