import { preflightNativeMemberModel } from './preflightNativeMemberModel.js';
import { createProviderManagementMethods } from './createProviderManagementMethods.js';
import { join } from 'node:path';
import { createHostTeamLifecycleComposition } from './createHostTeamLifecycleComposition.js';
import { createHostWorkSyncComposition } from './createHostWorkSyncComposition.js';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { admitTeamNamespace } from '../adapters/team/admitTeamNamespace.js';
import { createRuntimeHostMethods } from './createRuntimeHostMethods.js';
import { createHostCrossTeamComposition } from './createHostCrossTeamComposition.js';
import { createProcessCustody, processCustodyProfileSchema } from './processCustody.js';
import { createTeamProcessComposition } from './createTeamProcessComposition.js';
import { createTeamReviewComposition } from './TeamReviewComposition.js';
import { createStoppedImportComposition } from './createStoppedImportComposition.js';
import { createTeamAttachmentComposition } from './createTeamAttachmentComposition.js';
import { z } from 'zod';

import { acquireProfileWriterLease } from '../adapters/profile/ProfileWriterLease.js';
import { createFilesystemTeamOwner } from '../adapters/team/createFilesystemTeamOwner.js';
import { admitRegistryTeamNamespace } from '../adapters/team-registry/admitRegistryTeamNamespace.js';
import { FileTeamRegistryStore } from '../adapters/team-registry/FileTeamRegistryStore.js';
import { TeamRegistry } from '../team-registry/TeamRegistry.js';
import {
  createTeamRegistryPayloadSchema,
  teamRegistryScopeSchema,
} from '../team-registry/contracts.js';
import { hostedTeamDefinitionSchema } from '../team-registry/definition.js';
import { createHostServer } from '../index.js';
import { TeamOwnerError } from '../team/contracts.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { runtimeProfileSchema } from './runtimeProfile.js';
import { RuntimeTeamCoordinator } from './RuntimeTeamCoordinator.js';
import { providerManagementProfileSchema } from '../management/profile.js';
import { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import { assertAccountNamespaces } from './assertAccountNamespaces.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import { executeTeamModelProbe, teamModelProbeProfile } from './teamLaunchModelProbe.js';
import { replaceRosterPayloadSchema } from '../team/rosterSchema.js';
import { CreateTeamLaunchCoordinator } from './CreateTeamLaunchCoordinator.js';

import type { HostMethod, HostServer, HostServerOptions } from '../index.js';
import type { JsonValue } from '../contracts.js';
import type { ProviderOAuthSnapshot } from '../management/contracts.js';
import type { TeamCommand } from '../team/contracts.js';
import type { HostedTeam } from './RuntimeTeamCoordinator.js';
import type {
  MemberProvider,
  MemberProviderContext,
} from '../adapters/providers/MemberProvider.js';

const id = z.string().min(1).max(256);
const segment = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scope = teamRegistryScopeSchema;
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
    reviewTransport: z.literal('review-v1').optional(),
    runtime: runtimeProfileSchema.optional(),
    processCustody: processCustodyProfileSchema.optional(),
    management: z.array(providerManagementProfileSchema).max(16).optional(),
    creation: z
      .object({ contextIds: z.array(id).min(1).max(256) })
      .strict()
      .optional(),
    teams: z.array(hostedTeamDefinitionSchema).max(256),
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
  assertAccountNamespaces([
    ...(profile.runtime?.members ?? []),
    ...(profile.runtime?.providerTemplates ?? []),
    ...(profile.management ?? []),
  ]);
  const lease = acquireProfileWriterLease(profile.owner.storageRoot);
  let sealed = false;
  let runtime: RuntimeTeamCoordinator | undefined;
  let management: ProviderManagementCoordinator | undefined;
  let emitOAuthProgress: ((snapshot: ProviderOAuthSnapshot) => void) | undefined;
  try {
    const managementProfiles = [
      ...(profile.management ?? []),
      ...(profile.runtime?.members.flatMap((member) => {
        const selected = teamModelProbeProfile(member);
        return selected ? [selected] : [];
      }) ?? []),
    ];
    if (
      managementProfiles.length ||
      (profile.creation &&
        profile.runtime?.providerTemplates?.some((row) => row.provider === 'claude'))
    )
      management = new ProviderManagementCoordinator(
        managementProfiles,
        () => lease.assertCurrent(),
        profile.owner.storageRoot,
        { onOAuthProgress: (snapshot) => emitOAuthProgress?.(snapshot) }
      );
    const teams = new Map<string, HostedTeam>();
    const assertCurrent = () => { if (sealed) throw new TeamOwnerError('hold'); lease.assertCurrent(); };
    const processCustody = createProcessCustody(profile.processCustody);
    const crossTeam = createHostCrossTeamComposition({ profile, teams, assertCurrent,
      activeInputs: binding => runtime?.crossTeamActiveInputs(binding) ?? [] });
    const processes = createTeamProcessComposition({ profile, teams, assertCurrent,
      ...(processCustody ? { native: processCustody } : {}) });
    const lifecycle = createHostTeamLifecycleComposition({ profile, teams, assertCurrent,
      assertWriter: () => lease.assertCurrent(), isShuttingDown: () => sealed,
      runtime: () => runtime, importer: () => imports, ...(processCustody ? { processCustody } : {}) });
    const workSync = createHostWorkSyncComposition({ teamsBasePath: join(profile.owner.storageRoot, 'teams'),
      identity: (teamId, principalId) => lifecycle.storage.identity(teamId, principalId), assertCurrent });
    const attachTeam = (definition: TeamHostProfile['teams'][number], dynamic = false): void => {
      if (lifecycle.retirement.isRetired(definition)) return;
      const prior = teams.get(definition.binding.teamId);
      if (dynamic && prior && equalFields(prior.definition, definition)) {
        if (dynamic) prior.connection.readRoster();
        return;
      }
      if (
        definition.binding.backendId !== profile.owner.ownerId ||
        definition.binding.teamId !== definition.scope.teamId ||
        teams.has(definition.binding.teamId) ||
        [...teams.values()].some(
          (team) =>
            team.definition.binding.teamName.toLowerCase() ===
            definition.binding.teamName.toLowerCase()
        )
      )
        throw new TeamOwnerError('invalid');
      admitTeamNamespace(profile.owner.storageRoot, definition.binding);
      const store = new TeamOwnerStore(profile.owner.storageRoot, definition.binding.teamName);
      const team = createFilesystemTeamOwner({
        store,
        root: profile.owner.storageRoot,
        binding: definition.binding,
        crossTeamSourceAuthority: crossTeam.sourceAuthorized,
        ...(definition.savedSettings === undefined
          ? {}
          : { savedSettings: definition.savedSettings }),
        members: definition.members.map(({ memberId, name, role, delivery, settings }) => ({
          memberId,
          name,
          role,
          ...(delivery ? { delivery } : {}),
          ...(settings === undefined ? {} : { settings }),
        })),
        grants: definition.grants.map(({ principalId, memberName, permissions, revoked }) => ({
          principalId,
          memberName,
          permissions,
          ...(revoked === undefined ? {} : { revoked }),
        })),
        assertRosterEditable: (members) => {
          if (runtime) runtime.assertRosterEditable(definition.binding.teamId, members);
          else if (members.some((member) => member.delivery)) throw new TeamOwnerError('hold');
        },
      });
      // Bootstrap must prove the product owner and captured principal are readable.
      if (dynamic) team.connect(profile.principalId).readRoster();
      lifecycle.stores.set(definition.binding.teamId, store);
      teams.set(definition.binding.teamId, {
        definition,
        owner: team,
        connection: team.connect(profile.principalId),
        operatorPrincipalId: profile.principalId,
      });
    };
    for (const definition of profile.teams) attachTeam(definition);
    const imports = createStoppedImportComposition({
      profile,
      assertCurrent, assertLifecycleWriter: () => lease.assertCurrent(), isRetired: lifecycle.retirement.isRetired,
      attach: (definition) => attachTeam(definition, true),
      validateConfiguration(raw) {
        const definition = hostedTeamDefinitionSchema.parse(raw);
        if (
          definition.binding.backendId !== profile.owner.ownerId ||
          definition.scope.teamId !== definition.binding.teamId ||
          !profile.creation?.contextIds.includes(definition.scope.projectId) ||
          definition.scope.workspaceId !== definition.scope.projectId ||
          definition.members.some((member) => member.delivery)
        )
          throw new TeamOwnerError('invalid');
      },
    });
    const attachments = createTeamAttachmentComposition({
      profile,
      teams,
      read: imports?.readTaskAttachment,
      assertCurrent,
    });
    const registry = profile.creation
      ? new TeamRegistry({
          ownerId: profile.owner.ownerId,
          profileId: profile.owner.profileId,
          principalId: profile.principalId,
          contextIds: profile.creation.contextIds,
          staticTeams: profile.teams,
          additionalCatalog: () => imports?.catalog() ?? { teams: [], held: [] },
          isRetired: lifecycle.retirement.isRetired,
          store: new FileTeamRegistryStore(profile.owner.storageRoot, () => lease.assertCurrent()),
          assertWriter: () => lease.assertCurrent(),
          admit: (definition, fresh, bootstrapPublished) =>
            admitRegistryTeamNamespace(
              profile.owner.storageRoot,
              definition.binding,
              fresh,
              bootstrapPublished
            ),
          attach: (definition) => attachTeam(definition, true),
        })
      : undefined;
    registry?.restore();
    imports?.restorePublished();
    // Saved configuration survives a stale private runtime descriptor. Product
    // APIs remain usable; native allocation requires a fresh explicit capture.
    const runtimeTeams = teams;
    if (profile.runtime)
      runtime = new RuntimeTeamCoordinator({
        profile: { ...profile, runtime: { ...profile.runtime,
          members: profile.runtime.members.filter(member => teams.has(member.teamId)) } },
        teams: runtimeTeams, workSync,
        ...(management ? { nativeMemberModelPreflight: (input) => preflightNativeMemberModel({ ...input, management: management! }) } : {}),
        ...(processCustody ? { processCustody } : {}),
        crossTeam: (team, principal, binding, current) => crossTeam.memberPort(team, principal, binding, current),
        assertWriter: () => lease.assertCurrent(),
        ...(composition ? { createProvider: composition.createProvider } : {}),
      });
    const creationLaunch =
      registry && runtime && management
        ? new CreateTeamLaunchCoordinator({
            profile,
            registry,
            runtime,
            management,
            team: (teamId) => teams.get(teamId),
            assertCurrent: () => {
              if (sealed) throw new TeamLaunchError('hold', 'sealed');
              lease.assertCurrent();
            },
          })
        : undefined;

    const method = (
      operation:
        | 'execute'
        | 'lookup'
        | 'getTask'
        | 'listTasks'
        | 'snapshot'
        | 'activity.logs' | 'activity.stats' | 'lead.activity' | 'lead.context'
        | 'changes'
        | 'roster.read'
        | 'roster.lookup'
        | 'roster.replace'
    ): NonNullable<HostServerOptions['methods']>[string] => ({
      lane: operation === 'execute' || operation === 'roster.replace' ? 'work' : 'control',
      async handle(raw): Promise<JsonValue> {
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
          if (operation === 'roster.read' || operation === 'roster.lookup') {
            if (operation === 'roster.read') {
              z.object({}).strict().parse(input.payload);
              return { ok: true, value: json(connection.readRoster()) };
            }
            const payload = z
              .object({ expected: replaceRosterPayloadSchema.optional() })
              .strict()
              .parse(input.payload);
            return {
              ok: true,
              value: json(connection.lookupRoster(input.commandId, payload.expected) ?? null),
            };
          }
          if (operation === 'roster.replace') {
            const payload = replaceRosterPayloadSchema.parse(input.payload);
            return {
              ok: true,
              value: json(connection.replaceRoster({ ...payload, commandId: input.commandId })),
            };
          }
          if (operation === 'changes') {
            const payload = z
              .object({ cursor: z.string().min(1).max(128).optional() })
              .strict()
              .parse(input.payload);
            return {
              ok: true,
              value: connection.readChanges(payload.cursor),
            };
          }
          if (operation === 'snapshot') {
            z.object({}).strict().parse(input.payload);
            return { ok: true, value: connection.readSnapshot() };
          }
          if (operation === 'lead.activity' || operation === 'lead.context') {
            z.object({}).strict().parse(input.payload);
            if (!runtime) throw new TeamOwnerError('hold');
            return { ok: true, value: runtime.readLead(selected.definition.binding.teamId, operation === 'lead.activity' ? 'activity' : 'context') };
          }
          if (operation === 'activity.logs' || operation === 'activity.stats') {
            if (!runtime) throw new TeamOwnerError('hold');
            return { ok: true, value: runtime.readTeamActivity(selected.definition.binding.teamId, operation === 'activity.logs' ? 'logs' : 'stats', input.payload) };
          }
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
              !runtimeTeams.has(selected.definition.binding.teamId) ||
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

    const registryMethods: Record<string, HostMethod> = {};
    for (const operation of ['create', 'lookup', 'list'] as const) {
      registryMethods[`team.registry.${operation}`] = {
        lane: operation === 'create' ? 'work' : 'control',
        handle(raw): JsonValue {
          try {
            if (sealed) throw new TeamOwnerError('hold');
            lease.assertCurrent();
            const input = z
              .object({ owner, commandId: id, payload: z.unknown() })
              .strict()
              .parse(raw);
            if (!registry || !equalFields(input.owner, profile.owner))
              throw new TeamOwnerError('forbidden');
            let value;
            if (operation === 'create') value = registry.create(input.commandId, input.payload);
            else if (operation === 'lookup') {
              const payload = z
                .object({ contextId: id, expected: createTeamRegistryPayloadSchema.optional() })
                .strict()
                .parse(input.payload);
              value = registry.lookup(input.commandId, payload.contextId, payload.expected);
            } else {
              const payload = z.object({ contextId: id }).strict().parse(input.payload);
              value = registry.list(payload.contextId);
            }
            return { ok: true, value: json(value) };
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
      };
    }

    const creationMethods: Record<string, HostMethod> = {};
    for (const operation of [
      'prepare',
      'probe.read',
      'probe.cancel',
      'submit',
      'lookup',
    ] as const) {
      creationMethods[`team.creation.${operation}`] = {
        lane:
          operation === 'probe.read' || operation === 'probe.cancel' || operation === 'lookup'
            ? 'control'
            : 'work',
        async handle(raw): Promise<JsonValue> {
          try {
            if (sealed) throw new TeamLaunchError('hold', 'sealed');
            lease.assertCurrent();
            const input = z
              .object({ owner, commandId: id, payload: z.unknown() })
              .strict()
              .parse(raw);
            if (!creationLaunch || !equalFields(input.owner, profile.owner))
              throw new TeamLaunchError('forbidden', 'creation-owner');
            const value =
              operation === 'submit'
                ? await creationLaunch.submit(input.commandId, input.payload)
                : operation === 'lookup'
                  ? creationLaunch.lookup(input.commandId, input.payload)
                  : await creationLaunch.prepare(
                      operation === 'prepare'
                        ? 'start'
                        : operation === 'probe.read'
                          ? 'read'
                          : 'cancel',
                      input.payload
                    );
            return { ok: true, value: json(value) };
          } catch (error) {
            const code =
              error instanceof TeamLaunchError ||
              error instanceof TeamOwnerError ||
              error instanceof RuntimeOwnerError ||
              error instanceof ManagementCommandError
                ? error.code === 'held' || error.code === 'busy'
                  ? 'hold'
                  : error.code
                : error instanceof z.ZodError
                  ? 'invalid'
                  : 'hold';
            return {
              ok: false,
              code,
              outcome: code === 'hold' ? 'unknown' : 'rejected',
              ...(error instanceof TeamLaunchError ? { reason: error.reason } : {}),
            };
          }
        },
      };
    }

    const launchMethods: Record<string, HostMethod> = {};
    for (const operation of [
      'capture',
      'start',
      'read',
      'retry',
      'configuration.read',
      'model.configuration.read',
      'restorations.read',
      'resume.prepare',
    ] as const) {
      launchMethods[`team.launch.${operation}`] = {
        lane:
          operation === 'read' ||
          operation === 'configuration.read' || operation === 'model.configuration.read' ||
          operation === 'restorations.read' ||
          operation === 'resume.prepare'
            ? 'control'
            : 'work',
        async handle(raw): Promise<JsonValue> {
          try {
            if (sealed) throw new TeamLaunchError('hold', 'sealed');
            lease.assertCurrent();
            const input = envelopeSchema.parse(raw),
              selected = teams.get(input.binding.scope.teamId);
            if (
              !selected ||
              !equalFields(input.binding.owner, profile.owner) ||
              !equalFields(input.binding.scope, selected.definition.scope)
            )
              throw new TeamLaunchError('forbidden', 'binding');
            if (operation === 'model.configuration.read' && runtime)
              return { ok: true, value: await runtime.executeLaunch(selected.definition.binding.teamId, operation, input.commandId, input.payload) };
            if (
              !runtime ||
              !runtimeTeams.has(selected.definition.binding.teamId) ||
              ((operation === 'read' || operation === 'configuration.read') &&
                !runtime.hasCurrentCapture(selected.definition.binding.teamId) &&
                !(
                  input.payload &&
                  typeof input.payload === 'object' &&
                  'launchId' in input.payload
                ))
            ) {
              if (operation !== 'read' && operation !== 'configuration.read')
                throw new TeamLaunchError('invalid', 'runtime-unconfigured');
              z.object({}).strict().parse(input.payload);
              return selected.owner.withLaunchAuthority(profile.principalId, 'read', () => ({
                ok: true,
                value: null,
              }));
            }
            return {
              ok: true,
              value: await runtime.executeLaunch(
                selected.definition.binding.teamId,
                operation,
                input.commandId,
                input.payload
              ),
            };
          } catch (error) {
            const code =
              error instanceof TeamLaunchError ||
              error instanceof TeamOwnerError ||
              error instanceof RuntimeOwnerError
                ? error.code
                : error instanceof z.ZodError
                  ? 'invalid'
                  : 'hold';
            return {
              ok: false,
              code,
              outcome: code === 'hold' ? 'unknown' : 'rejected',
              ...(error instanceof TeamLaunchError ? { reason: error.reason } : {}),
            };
          }
        },
      };
    }

    if (runtime && management)
      for (const action of ['start', 'read', 'cancel'] as const) {
        launchMethods[`team.launch.probe.${action}`] = {
          lane: action === 'start' ? 'work' : 'control',
          async handle(raw): Promise<JsonValue> {
            try {
              if (sealed) throw new TeamLaunchError('hold', 'sealed');
              lease.assertCurrent();
              const input = envelopeSchema.parse(raw),
                selected = teams.get(input.binding.scope.teamId);
              if (
                !selected ||
                !equalFields(input.binding.owner, profile.owner) ||
                !equalFields(input.binding.scope, selected.definition.scope)
              )
                throw new TeamLaunchError('forbidden', 'binding');
              return {
                ok: true,
                value: json(
                  await executeTeamModelProbe({
                    runtime: runtime!,
                    management: management!,
                    action,
                    teamId: selected.definition.binding.teamId,
                    commandId: input.commandId,
                    payload: input.payload,
                  })
                ),
              };
            } catch (error) {
              const code =
                error instanceof TeamLaunchError ||
                error instanceof TeamOwnerError ||
                error instanceof ManagementCommandError
                  ? error.code === 'held'
                    ? 'hold'
                    : error.code
                  : error instanceof z.ZodError
                    ? 'invalid'
                    : 'hold';
              return { ok: false, code, outcome: code === 'hold' ? 'unknown' : 'rejected' };
            }
          },
        };
      }

    const runtimeMethods = runtime ? createRuntimeHostMethods({ runtime, parse(raw) {
      if (sealed) throw new RuntimeOwnerError('hold');
      lease.assertCurrent();
      const input = envelopeSchema.parse(raw);
      const selected = teams.get(input.binding.scope.teamId);
      if (!selected || !equalFields(input.binding.owner, profile.owner) ||
        !equalFields(input.binding.scope, selected.definition.scope))
        throw new RuntimeOwnerError('forbidden');
      return { teamId: selected.definition.binding.teamId, commandId: input.commandId, payload: input.payload };
    } }) : {};

    const managementMethods = createProviderManagementMethods(management, () => sealed);

    const review = createTeamReviewComposition({
      profile,
      assertCurrent,
      select(raw) {
        const input = envelopeSchema.parse(raw),
          team = teams.get(input.binding.scope.teamId);
        if (
          !team ||
          !equalFields(input.binding.owner, profile.owner) ||
          !equalFields(input.binding.scope, team.definition.scope)
        )
          throw new TeamOwnerError('forbidden');
        team.connection.readRoster();
        return { commandId: input.commandId, payload: input.payload, team };
      },
    });

    const server = createHostServer({
      ...streams,
      ...(profile.reviewTransport ? { reviewTransport: profile.reviewTransport } : {}),
      buildId: profile.owner.buildId,
      capabilities: [
        'team.task',
        'team.snapshot',
        'team.roster',
        'team.product-changes',
        'team.message',
        'team.command-outcome',
        ...(registry ? ['team.registry'] : []),
        ...(imports ? ['team.import'] : []),
        'team.attachments',
        ...(profile.reviewTransport ? ['team.review'] : []),
        ...(creationLaunch ? ['team.creation'] : []),
        ...(profile.management?.length
          ? [
              'management.catalog',
              'management.skills',
              ...(profile.management?.some((entry) => entry.provider === 'claude')
                ? ['management.claude.metadata', 'management.claude.auth', 'management.extensions']
                : []),
              ...(profile.management?.some((entry) => entry.provider === 'codex')
                ? ['management.codex.metadata']
                : []),
              'management.credentials',
              'management.oauth',
              'management.model-probe',
            ]
          : []),
        ...(runtime
          ? ['runtime.member-session', 'runtime.checkpoint', 'runtime.activity', 'team.launch']
          : []),
        ...(runtime && management ? ['team.launch.model-probe'] : []),
        ...Object.keys(crossTeam.methods), ...Object.keys(processes.methods), ...Object.keys(lifecycle.methods),
      ],
      methods: {
        'team.execute': method('execute'),
        'team.lookup': method('lookup'),
        'team.task.get': method('getTask'),
        'team.tasks.list': method('listTasks'),
        'team.snapshot': method('snapshot'),
        'team.roster.read': method('roster.read'),
        'team.roster.lookup': method('roster.lookup'),
        'team.roster.replace': method('roster.replace'),
        'team.changes.read': method('changes'),
        ...(runtime ? { 'team.lead.activity.read': method('lead.activity'), 'team.lead.context.read': method('lead.context'), 'team.activity.logs.read': method('activity.logs'),
          'team.activity.stats.read': method('activity.stats') } : {}),
        ...registryMethods,
        ...crossTeam.methods, ...processes.methods, ...lifecycle.methods,
        ...imports?.methods,
        ...attachments.methods,
        ...creationMethods,
        ...managementMethods,
        ...runtimeMethods,
        ...launchMethods,
        ...review.methods,
      },
      onSeal() {
        review.seal();
        sealed = true;
        runtime?.seal();
        management?.seal();
      },
      async onDispose() {
        review.seal();
        try {
          const results = await Promise.allSettled([runtime?.close(), management?.close(), workSync.close()]);
          const backups = await Promise.allSettled([lifecycle.shutdown()]);
          const failure = [...results, ...backups].find((result) => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
        } finally {
          lease.release();
        }
      },
    });
    emitOAuthProgress = (snapshot) => {
      if (!sealed) server.notifyData('management.oauth.progress', json(snapshot));
    };
    runtime?.kick(); // Resume original durable obligations on startup, without opening/adopting native sessions.
    return server;
  } catch (error) {
    sealed = true;
    runtime?.seal();
    management?.seal();
    lease.release();
    throw error;
  }
}
