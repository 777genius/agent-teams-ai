import { TeamOwnerError } from '../team/contracts.js';
import { digest, effectId } from '../team/identity.js';
import { createTeamRegistryPayloadSchema, teamRegistryListSchema } from './contracts.js';

import type {
  CreateTeamRegistryPayload,
  TeamRegistryList,
  TeamRegistryReceipt,
} from './contracts.js';
import type { HostedTeamDefinition } from './definition.js';
import type { StoredTeamCreation, TeamRegistryStore } from './state.js';

export interface TeamRegistryOptions {
  ownerId: string;
  profileId: string;
  principalId: string;
  contextIds: readonly string[];
  staticTeams: readonly HostedTeamDefinition[];
  store: TeamRegistryStore;
  assertWriter(): void;
  /** Detached imports share admission/discovery, but retain their own original intent. */
  additionalCatalog?(): TeamRegistryList;
  /** Read-only admission, before original intent or any Team namespace write. */
  admit(definition: HostedTeamDefinition, fresh: boolean, bootstrapPublished: boolean): void;
  /** Composition attaches the same Team owner to the shared live map. No native allocation. */
  attach(definition: HostedTeamDefinition): void;
  /** Original physical deletion intent qualifies retirement before any cold bootstrap write. */
  isRetired?(definition: HostedTeamDefinition): boolean;
}

/** Creation owns only its immutable bootstrap intent; subsequent product state belongs to Team. */
export class TeamRegistry {
  constructor(private readonly options: TeamRegistryOptions) {}

  private authorize(contextId: string): void {
    this.options.assertWriter();
    if (!this.options.contextIds.includes(contextId)) throw new TeamOwnerError('forbidden');
  }

  private additionalCatalog(): TeamRegistryList {
    const catalog = teamRegistryListSchema.parse(
      this.options.additionalCatalog?.() ?? { teams: [], held: [] }
    );
    const records = [...catalog.teams, ...catalog.held.map((entry) => entry.record)];
    if (
      new Set(records.map((record) => record.teamId)).size !== records.length ||
      new Set(records.map((record) => record.teamName.toLowerCase())).size !== records.length
    )
      throw new TeamOwnerError('hold');
    return catalog;
  }

  private fingerprint(commandId: string, intent: CreateTeamRegistryPayload): string {
    return digest({
      ownerId: this.options.ownerId,
      profileId: this.options.profileId,
      principalId: this.options.principalId,
      commandId,
      intent,
    });
  }

  private validate(record: StoredTeamCreation): void {
    if (
      record.ownerId !== this.options.ownerId ||
      record.profileId !== this.options.profileId ||
      record.principalId !== this.options.principalId
    )
      throw new TeamOwnerError('forbidden');
    const expected = this.prepare(record.commandId, record.intent);
    if (
      (record.phase === 'published' && !record.bootstrapPublished) ||
      (record.phase === 'pending' && record.bootstrapPublished) ||
      record.fingerprint !== expected.fingerprint ||
      digest(record.definition) !== digest(expected.definition) ||
      digest(record.record) !== digest(expected.record)
    )
      throw new TeamOwnerError('hold');
  }

  private prepare(commandId: string, intent: CreateTeamRegistryPayload): StoredTeamCreation {
    const identity = [
      this.options.ownerId,
      this.options.profileId,
      this.options.principalId,
      commandId,
    ];
    const teamId = effectId('team-registry-team', ...identity);
    const scope = {
      projectId: intent.contextId,
      workspaceId: intent.contextId,
      teamId,
      runId: effectId('team-registry-run', ...identity),
      memberId: 'user',
      generation: '1',
    };
    const members: HostedTeamDefinition['members'] = [
      {
        memberId: effectId('team-registry-member', ...identity, 'team-lead'),
        name: 'team-lead',
        role: 'lead',
      },
      ...intent.members.map(({ name, memberSettings }) => ({
        memberId: effectId('team-registry-member', ...identity, name.toLowerCase()),
        name,
        role: 'member' as const,
        settings: memberSettings,
      })),
    ];
    const { displayName, description, color } = intent.savedSettings;
    return {
      schemaVersion: 1,
      ownerId: this.options.ownerId,
      profileId: this.options.profileId,
      principalId: this.options.principalId,
      commandId,
      fingerprint: this.fingerprint(commandId, intent),
      intent,
      definition: {
        scope,
        binding: { backendId: this.options.ownerId, teamId, teamName: intent.teamName },
        savedSettings: intent.savedSettings,
        members,
        grants: [
          {
            principalId: this.options.principalId,
            memberName: 'user',
            permissions: ['read', 'task.write', 'message.write', 'process.write', 'admin'],
          },
        ],
      },
      record: {
        contextId: intent.contextId,
        teamId,
        teamName: intent.teamName,
        ...(displayName === undefined ? {} : { displayName }),
        ...(description === undefined ? {} : { description }),
        ...(color === undefined ? {} : { color }),
        members: members.map(({ memberId, name }) => ({ memberId, label: name })),
        binding: {
          schemaVersion: 1,
          handleId: effectId('team-registry-handle', ...identity),
          scope,
        },
      },
      phase: 'pending',
      bootstrapPublished: false,
    };
  }

  private receipt(record: StoredTeamCreation): TeamRegistryReceipt {
    return structuredClone({
      commandId: record.commandId,
      phase: record.phase,
      record: record.record,
    });
  }

  private complete(record: StoredTeamCreation): TeamRegistryReceipt {
    if (this.options.isRetired?.(record.definition)) return this.receipt(record);
    this.options.assertWriter();
    try {
      const additional = this.additionalCatalog();
      if (
        [
          ...this.options.staticTeams.map((team) => team.binding),
          ...additional.teams,
          ...additional.held.map((entry) => entry.record),
        ].some(
          (team) =>
            team.teamName.toLowerCase() === record.intent.teamName.toLowerCase() ||
            team.teamId === record.definition.binding.teamId
        )
      )
        throw new TeamOwnerError('conflict');
      this.options.admit(record.definition, false, record.bootstrapPublished);
      this.options.attach(structuredClone(record.definition));
    } catch {
      // Bootstrap may have written a ready:false owner or a product projection.
      // Keep the exact original definition and every debt; never replace or delete it.
      if (record.phase !== 'held') {
        record.phase = 'held';
        this.options.assertWriter();
        this.options.store.write(record);
      }
      return this.receipt(record);
    }
    if (record.phase !== 'published') {
      record.phase = 'published';
      record.bootstrapPublished = true;
      this.options.assertWriter();
      this.options.store.write(record);
    }
    return this.receipt(record);
  }

  /** Cold recovery finishes only the persisted original definition, per allowed context. */
  restore(): void {
    let records;
    try {
      records = this.options.store.readAll();
    } catch {
      return;
    } // A damaged registry does not disable unrelated static Teams.
    if (!records.length) return;
    this.options.store.fenced(() => {
      for (const record of this.options.store.readAll()) {
        try {
          this.validate(record);
          this.authorize(record.intent.contextId);
          this.complete(record);
        } catch {
          // An inaccessible or malformed creation cannot authorize touching its Team.
          // Other Teams can remain usable; queries still validate their own records.
        }
      }
    });
  }

  create(commandId: string, raw: unknown): TeamRegistryReceipt {
    this.validateCommandId(commandId);
    const intent = createTeamRegistryPayloadSchema.parse(raw);
    this.authorize(intent.contextId);
    return this.options.store.fenced(() => {
      this.options.assertWriter();
      const records = this.options.store.readAll();
      const prior = records.find((record) => record.commandId === commandId);
      if (prior) {
        this.validate(prior);
        if (prior.fingerprint !== this.fingerprint(commandId, intent))
          throw new TeamOwnerError('conflict');
        return this.complete(prior);
      }
      const catalog = this.additionalCatalog();
      const additional = [...catalog.teams, ...catalog.held.map((entry) => entry.record)];
      const name = intent.teamName.toLowerCase();
      if (
        this.options.staticTeams.some((team) => team.binding.teamName.toLowerCase() === name) ||
        records.some((record) => record.intent.teamName.toLowerCase() === name) ||
        additional.some((record) => record.teamName.toLowerCase() === name)
      )
        throw new TeamOwnerError('conflict');
      if (records.length + this.options.staticTeams.length + additional.length >= 256)
        throw new TeamOwnerError('hold');
      const record = this.prepare(commandId, intent);
      this.options.admit(record.definition, true, false);
      // Intent and generated identities become durable before any Team bootstrap effect.
      this.options.assertWriter();
      this.options.store.write(record);
      return this.complete(record);
    });
  }

  lookup(
    commandId: string,
    contextId: string,
    expected?: CreateTeamRegistryPayload
  ): TeamRegistryReceipt | null {
    this.validateCommandId(commandId);
    this.authorize(contextId);
    const record = this.options.store.readAll().find((entry) => entry.commandId === commandId);
    if (!record) return null;
    this.validate(record);
    if (record.intent.contextId !== contextId) throw new TeamOwnerError('forbidden');
    if (
      expected !== undefined &&
      record.fingerprint !==
        this.fingerprint(commandId, createTeamRegistryPayloadSchema.parse(expected))
    )
      throw new TeamOwnerError('conflict');
    return this.receipt(record);
  }

  list(contextId: string): TeamRegistryList {
    this.authorize(contextId);
    const result: TeamRegistryList = { teams: [], held: [] };
    for (const record of this.options.store.readAll()) {
      if (record.intent.contextId !== contextId) continue;
      this.validate(record);
      if (record.phase === 'published') result.teams.push(structuredClone(record.record));
      else result.held.push(this.receipt(record));
    }
    const additional = this.additionalCatalog();
    result.teams.push(...additional.teams.filter((entry) => entry.contextId === contextId));
    result.held.push(...additional.held.filter((entry) => entry.record.contextId === contextId));
    const all = [...result.teams, ...result.held.map((entry) => entry.record)];
    if (
      all.length > 256 ||
      new Set(all.map((entry) => entry.teamId)).size !== all.length ||
      new Set(all.map((entry) => entry.teamName.toLowerCase())).size !== all.length
    )
      throw new TeamOwnerError('hold');
    return result;
  }

  private validateCommandId(commandId: string): void {
    if (
      typeof commandId !== 'string' ||
      !commandId.trim() ||
      commandId.length > 256 ||
      commandId.includes('\0')
    )
      throw new TeamOwnerError('invalid');
  }
}
