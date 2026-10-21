import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { FileRuntimeStore } from '../adapters/runtime/FileRuntimeStore.js';
import { createClaudeMemberProvider } from '../adapters/providers/ClaudeMemberProvider.js';
import { startTeamMcpEndpoint } from '../mcp/endpoint.js';
import { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { deliveryFingerprint, runtimeDigest } from '../runtime/identity.js';

import type {
  MemberProvider,
  MemberProviderContext,
} from '../adapters/providers/ClaudeMemberProvider.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { TeamOwner } from '../team/TeamOwner.js';
import type { DeliveryBinding } from '../team/contracts.js';
import type { JsonValue } from '../contracts.js';
import type { OpenConfig } from '@agent-teams/provider-session-contracts';
import type { RuntimeBinding, RuntimeSessionRecord } from '../runtime/contracts.js';
import type { TeamMcpEndpoint } from '../mcp/contracts.js';

export interface HostedTeam {
  definition: TeamHostProfile['teams'][number];
  owner: TeamOwner;
  connection: ReturnType<TeamOwner['connect']>;
}

interface MemberEntry {
  profile: RuntimeMemberProfile;
  team: HostedTeam;
  delivery: DeliveryBinding;
  binding: RuntimeBinding;
  config: OpenConfig;
  provider?: MemberProvider;
  endpoint?: TeamMcpEndpoint;
  endpointExpiresAtMs?: number;
}

const member = z.object({ memberId: z.string().min(1).max(256) }).strict();
const id = z.string().min(1).max(256);
const interaction = member
  .extend({
    inputId: id,
    interactionRef: id,
    reply: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('permission'), decision: z.enum(['allow', 'deny']) }).strict(),
      z
        .object({ kind: z.literal('question'), answers: z.record(id, z.string().max(64 * 1024)) })
        .strict(),
    ]),
  })
  .strict();

/** Actual Team + Runtime + D composition, without a second input queue or native protocol parser. */
export class RuntimeTeamCoordinator {
  private readonly entries = new Map<string, MemberEntry>();
  private readonly runtime: RuntimeOwner;
  private readonly opening = new Set<Promise<unknown>>();
  private pumping: Promise<void> | undefined;
  private dirty = false;
  private sealed = false;

  constructor(
    private readonly options: {
      profile: TeamHostProfile;
      teams: ReadonlyMap<string, HostedTeam>;
      assertWriter(): void;
      /** Explicit composition seam for controlled Session tests; CLI always selects real D. */
      createProvider?(context: MemberProviderContext): MemberProvider;
    }
  ) {
    for (const profile of options.profile.runtime?.members ?? []) {
      const team = options.teams.get(profile.teamId);
      const selected = team?.definition.members.find(
        (candidate) => candidate.memberId === profile.memberId
      );
      const grant = team?.definition.grants.find(
        (candidate) => candidate.principalId === profile.principalId
      );
      if (!team || !selected?.delivery || grant?.memberName !== selected.name)
        throw new RuntimeOwnerError('invalid');
      const delivery = selected.delivery;
      const binding = {
        backendId: delivery.backendId,
        teamId: delivery.teamId,
        runId: delivery.runId,
        memberId: delivery.memberId,
        generation: delivery.generation,
      };
      const config: OpenConfig = {
        tenantId: options.profile.owner.ownerId,
        projectId: team.definition.scope.projectId,
        sessionId: profile.sessionId,
        generation: profile.generation,
        configRevision: profile.configRevision,
        requiredCapabilities: ['session.conversation'],
      };
      const key = this.key(binding);
      if (this.entries.has(key)) throw new RuntimeOwnerError('invalid');
      this.entries.set(key, { profile, team, delivery, binding, config });
    }
    const store = new FileRuntimeStore(options.profile.owner.storageRoot);
    if (
      new Set([...this.entries.values()].map((entry) => runtimeDigest(entry.config))).size !==
      this.entries.size
    )
      throw new RuntimeOwnerError('invalid');
    this.runtime = new RuntimeOwner({
      store,
      checkpoints: store,
      profileId: options.profile.owner.profileId,
      hostIncarnation: randomUUID(),
      driverFactory: {
        open: async (request) => {
          const entry = [...this.entries.values()].find(
            (candidate) =>
              runtimeDigest(candidate.config) ===
              runtimeDigest({
                tenantId: request.tenantId,
                projectId: request.projectId,
                sessionId: request.sessionId,
                generation: request.generation,
                configRevision: request.configRevision,
                requiredCapabilities: request.requiredCapabilities,
              })
          );
          if (!entry || this.sealed || entry.provider) throw new RuntimeOwnerError('hold');
          this.assertCurrent(entry);
          entry.endpointExpiresAtMs =
            Date.now() + (entry.profile.mcpLifetimeMs ?? 24 * 60 * 60 * 1000);
          const endpoint = await startTeamMcpEndpoint({
            connection: entry.team.owner.connect(entry.profile.principalId),
            binding: entry.delivery,
            expiresAtMs: entry.endpointExpiresAtMs,
            isCurrentBinding: () => this.isCurrent(entry),
          });
          entry.endpoint = endpoint;
          try {
            this.assertCurrent(entry);
            const selected = entry.team.definition.members.find(
              (candidate) => candidate.memberId === entry.profile.memberId
            )!;
            const provider = (options.createProvider ?? createClaudeMemberProvider)({
              profile: entry.profile,
              request,
              endpoint,
              connection: entry.team.owner.connect(entry.profile.principalId),
              instructions: `You are ${selected.name}, ${selected.role} of team ${entry.delivery.teamName}. Work in ${entry.profile.cwd}. Use the team MCP tools for shared tasks and messages. Native conversation completion does not complete a shared task. Supply stable commandId values for mutations.`,
              isCurrent: () => this.isCurrent(entry),
              canAllocate: () =>
                this.isCurrent(entry) &&
                entry.team.owner.authorizeRuntimeAccess(
                  options.profile.principalId,
                  entry.binding,
                  'control'
                ),
              readCheckpoint: (reference, config) => this.runtime.readCheckpoint(reference, config),
              onProgress: () => this.kick(),
            });
            entry.provider = provider;
            return await provider.factory.open(request);
          } catch (error) {
            endpoint.revoke();
            await endpoint.close();
            throw error;
          }
        },
      },
      authorize: (binding, action, intent) => {
        options.assertWriter();
        const entry = this.entries.get(this.key(binding));
        if (!entry) return false;
        if (intent) return entry.team.owner.authorizeDeliveryIntent(intent, action);
        return (
          entry.team.owner.authorizeMemberBinding(binding, action) ||
          ((action === 'read' || action === 'control') &&
            entry.team.owner.authorizeRuntimeAccess(options.profile.principalId, binding, action))
        );
      },
      canDispatch: (binding) => {
        const entry = this.entries.get(this.key(binding));
        return !!entry?.provider?.isReady() && this.isCurrent(entry);
      },
    });
  }

  /** Seal before awaiting provider/control cleanup, including factories still opening. */
  seal(): void {
    this.sealed = true;
    this.dirty = false;
    for (const entry of this.entries.values()) entry.provider?.seal();
  }

  async settleTeamCommands(teamId: string): Promise<void> {
    if (this.sealed) throw new RuntimeOwnerError('hold');
    const team = this.options.teams.get(teamId);
    if (!team) throw new RuntimeOwnerError('invalid');
    await team.owner.resumeTaskCommands(this.deliveryPort());
  }

  kick(): void {
    if (this.sealed) return;
    this.dirty = true;
    if (this.pumping) return;
    this.pumping = Promise.resolve()
      .then(async () => {
        while (this.dirty && !this.sealed) {
          this.dirty = false;
          for (const team of this.options.teams.values()) {
            if (this.sealed) break;
            try {
              await team.owner.resumeTaskCommands(this.deliveryPort());
              if (this.sealed) break;
              await team.owner.resumeDeliveries(this.deliveryPort());
            } catch {
              /* Durable pending/held obligations remain with their original owner. */
            }
          }
          for (const entry of this.entries.values()) {
            if (this.sealed) break;
            try {
              const current = this.runtime.readSession(entry.binding);
              if (
                current.attached &&
                current.record?.nativeReady &&
                current.record.phase === 'allocated'
              )
                await this.runtime.dispatchNext(entry.binding);
            } catch {
              /* A busy/held/revoked member never falls back to another runtime. */
            }
          }
        }
      })
      .finally(() => {
        this.pumping = undefined;
        if (this.dirty && !this.sealed) this.kick();
      });
  }

  async execute(teamId: string, operation: string, raw: unknown): Promise<JsonValue> {
    if (this.sealed) throw new RuntimeOwnerError('hold');
    const parsed =
      operation === 'interrupt'
        ? member.extend({ inputId: id }).strict().parse(raw)
        : operation === 'interaction'
          ? interaction.parse(raw)
          : operation === 'checkpoint'
            ? member.extend({ checkpointId: id }).strict().parse(raw)
            : member.parse(raw);
    const entry = [...this.entries.values()].find(
      (candidate) =>
        candidate.profile.teamId === teamId && candidate.profile.memberId === parsed.memberId
    );
    if (!entry) throw new RuntimeOwnerError('invalid');
    this.options.assertWriter();
    if (
      !entry.team.owner.authorizeRuntimeAccess(
        this.options.profile.principalId,
        entry.binding,
        operation === 'read' ? 'read' : 'control'
      )
    )
      throw new RuntimeOwnerError('forbidden');
    let record: RuntimeSessionRecord | undefined;
    if (operation === 'open') {
      const opening = this.runtime.openSession({ binding: entry.binding, config: entry.config });
      this.opening.add(opening);
      try {
        record = await opening;
      } finally {
        this.opening.delete(opening);
      }
      this.kick();
    } else if (operation === 'read') record = this.runtime.readSession(entry.binding).record;
    else if (operation === 'dispatch') {
      this.kick();
      await this.pumping;
      record = this.runtime.readSession(entry.binding).record;
    } else if (operation === 'stop') {
      record = await this.runtime.stopSession(entry.binding);
      await this.closeEndpoint(entry);
    } else if (operation === 'reconcile') record = this.runtime.reconcileSession(entry.binding);
    else if (operation === 'interrupt')
      record = await this.runtime.interrupt(
        entry.binding,
        member.extend({ inputId: id }).strict().parse(raw).inputId
      );
    else if (operation === 'interaction') {
      const input = interaction.parse(raw);
      record = await this.runtime.respondToInteraction(
        entry.binding,
        input.inputId,
        input.interactionRef,
        input.reply
      );
    } else if (operation === 'checkpoint') {
      const input = member.extend({ checkpointId: id }).strict().parse(raw);
      const receipt = await this.runtime.captureCheckpoint({
        binding: entry.binding,
        checkpointId: input.checkpointId,
      });
      if (
        !entry.team.owner.authorizeRuntimeAccess(
          this.options.profile.principalId,
          entry.binding,
          'control'
        )
      )
        throw new RuntimeOwnerError('forbidden');
      return JSON.parse(JSON.stringify(receipt)) as JsonValue;
    } else throw new RuntimeOwnerError('invalid');
    if (
      !entry.team.owner.authorizeRuntimeAccess(
        this.options.profile.principalId,
        entry.binding,
        operation === 'read' ? 'read' : 'control'
      )
    )
      throw new RuntimeOwnerError('forbidden');
    return this.projection(entry, record);
  }

  async close(): Promise<void> {
    this.seal();
    const stop = (entry: MemberEntry) => this.runtime.stopCapturedSession(entry.binding);
    // Each stop synchronously seals its Runtime record before the first cleanup await.
    const stopping = [...this.entries.values()].map(stop);
    await Promise.allSettled([
      ...stopping,
      ...this.opening,
      ...(this.pumping ? [this.pumping] : []),
    ]);
    let complete = true;
    for (const entry of this.entries.values()) {
      try {
        const state = await stop(entry);
        if (state && (state.phase !== 'closed' || state.custody !== 'released')) complete = false;
      } catch {
        complete = false;
      }
      // Physical cleanup of captured resources never depends on a still-valid user grant.
      try {
        if (entry.provider && !(await entry.provider.cleanup())) complete = false;
      } catch {
        complete = false;
      }
      try {
        await this.closeEndpoint(entry);
      } catch {
        complete = false;
      }
    }
    if (!complete) throw new RuntimeOwnerError('hold');
  }

  private projection(entry: MemberEntry, record: RuntimeSessionRecord | undefined): JsonValue {
    return {
      memberId: entry.profile.memberId,
      phase: record?.phase ?? 'unopened',
      sealed: record?.sealed ?? false,
      custody: record?.custody ?? 'released',
      nativeReady: !!record?.nativeReady && !!entry.provider?.isReady() && this.isCurrent(entry),
      attached: this.runtime.readSession(entry.binding).attached,
      inputs: (record?.inputs ?? []).map((input) => ({
        inputId: input.intent.inputId,
        phase: input.phase,
        ...(input.terminal ? { terminal: input.terminal } : {}),
      })),
      interactions: (record?.interactions ?? []).map(
        ({ operationRef: _operation, ...safe }) => safe
      ),
      ...(record?.diagnostic ? { diagnostic: record.diagnostic } : {}),
    };
  }
  private deliveryPort() {
    return {
      fingerprintDelivery: deliveryFingerprint,
      admitDelivery: (intent: Parameters<RuntimeOwner['admitDelivery']>[0]) =>
        this.runtime.admitDelivery(intent),
      lookupDelivery: (intent: Parameters<RuntimeOwner['lookupDelivery']>[0]) =>
        this.runtime.lookupDelivery(intent),
      cancelDelivery: (intent: Parameters<RuntimeOwner['cancelDelivery']>[0]) =>
        this.runtime.cancelDelivery(intent),
    };
  }
  private key(binding: RuntimeBinding): string {
    return runtimeDigest(binding);
  }
  private isCurrent(entry: MemberEntry): boolean {
    try {
      this.assertCurrent(entry);
      return true;
    } catch {
      return false;
    }
  }
  private assertCurrent(entry: MemberEntry): void {
    this.options.assertWriter();
    if (
      this.sealed ||
      (entry.endpointExpiresAtMs !== undefined && Date.now() >= entry.endpointExpiresAtMs) ||
      !entry.team.owner.authorizeMemberBinding(entry.binding, 'dispatch')
    )
      throw new RuntimeOwnerError('forbidden');
  }
  private async closeEndpoint(entry: MemberEntry): Promise<void> {
    entry.endpoint?.revoke();
    await entry.endpoint?.close();
  }
}
