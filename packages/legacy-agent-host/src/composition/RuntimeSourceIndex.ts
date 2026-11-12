import { FileRuntimeSourceIndex } from '../adapters/profile/FileRuntimeSourceIndex.js';
import { FileManagementCommandStore } from '../adapters/providers/FileManagementCommandStore.js';
import {
  ManagementCommandError,
  storedRuntimeSourceCommandSchema,
} from '../management/commandRecords.js';
import { providerManagementProfileSchema } from '../management/profile.js';
import { runtimeDigest } from '../runtime/identity.js';
import { runtimeMemberProfileSchema } from './runtimeProfile.js';
import {
  publishRuntimeSourceSchema,
  runtimeSourceGrantSchema,
  runtimeSourceLookupSchema,
  runtimeSourceReadSchema,
} from './runtimeSourceContracts.js';
import {
  assertRuntimeSourceQualification,
  verifyRuntimeSourceCandidate,
} from './verifyRuntimeSourceCandidate.js';
import type { RuntimeSourceRecord } from '../adapters/profile/FileRuntimeSourceIndex.js';
import type { ProviderManagementProfile } from '../management/profile.js';
import type {
  ManagementCommandStore,
  StoredRuntimeSourceCommand,
} from '../management/commandRecords.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type {
  RuntimeRecipeSources,
  RuntimeSourceGrant,
  RuntimeSourcePublication,
  RuntimeSourceReference,
  RuntimeSourceSummary,
  RuntimeSourceTeamScope,
} from './runtimeSourceContracts.js';

function fail(code: 'invalid' | 'conflict' | 'held'): never {
  throw new ManagementCommandError(code);
}

/** One leased index over immutable seed recipes. Native sessions and credentials stay with existing owners. */
export class RuntimeSourceIndex implements RuntimeRecipeSources {
  private readonly store: FileRuntimeSourceIndex;
  private readonly commands: ManagementCommandStore;

  constructor(
    private readonly profile: TeamHostProfile,
    private readonly assertWriter: () => void
  ) {
    this.store = new FileRuntimeSourceIndex(profile.owner.storageRoot, assertWriter);
    this.commands = new FileManagementCommandStore(profile.owner.storageRoot);
    const index = this.read();
    for (const receipt of this.commands.list()) {
      if (
        receipt.kind === 'runtime.source' &&
        receipt.phase === 'published' &&
        !index.records.some(
          (record) => record.commandId === receipt.commandId && record.revision === receipt.revision
        )
      )
        fail('held');
    }
  }

  current(raw: unknown): RuntimeSourceSummary {
    const { grant } = runtimeSourceReadSchema.parse(raw),
      seed = this.seed(grant),
      index = this.read();
    const pointer = index.current.find((row) => row.sourceId === grant.targetId);
    const record = pointer
      ? index.records.find((row) => row.revision === pointer.revision)!
      : undefined;
    if (record && runtimeDigest(record.grant) !== runtimeDigest(grant)) fail('conflict');
    return this.summary(grant, seed, record);
  }

  retained(raw: unknown): RuntimeSourceSummary[] {
    const { grant } = runtimeSourceReadSchema.parse(raw),
      seed = this.seed(grant);
    const records = this.read().records.filter((row) => row.grant.targetId === grant.targetId);
    if (records.some((row) => runtimeDigest(row.grant) !== runtimeDigest(grant))) fail('conflict');
    return [
      this.summary(grant, seed),
      ...records.map((record) => this.summary(grant, seed, record)),
    ];
  }

  lookup(raw: unknown): RuntimeSourcePublication | null {
    const { grant, commandId } = runtimeSourceLookupSchema.parse(raw),
      seed = this.seed(grant);
    const saved = this.commands.read(commandId);
    if (!saved) return null;
    if (
      saved.kind !== 'runtime.source' ||
      saved.sourceId !== grant.targetId ||
      saved.selectionDigest !== this.seedRevision(grant, seed)
    )
      fail('conflict');
    const record = this.read().records.find((row) => row.commandId === commandId);
    if (!record) {
      if (saved.phase === 'published') fail('held');
      return { commandId, phase: 'prepared' };
    }
    if (record.revision !== saved.revision || runtimeDigest(record.grant) !== runtimeDigest(grant))
      fail('held');
    if (saved.phase !== 'published') this.commands.write({ ...saved, phase: 'published' });
    return { commandId, phase: 'published', selection: this.summary(grant, seed, record) };
  }

  async publish(
    raw: unknown,
    admit: (profile: ProviderManagementProfile) => void
  ): Promise<RuntimeSourcePublication> {
    const input = publishRuntimeSourceSchema.parse(raw),
      seed = this.seed(input.grant);
    const fingerprint = runtimeDigest(input),
      prior = this.commands.read(input.commandId);
    if (prior) {
      if (prior.kind !== 'runtime.source' || prior.fingerprint !== fingerprint) fail('conflict');
      const known = this.lookup({ grant: input.grant, commandId: input.commandId });
      if (known?.phase === 'published') return known;
    }
    if (this.current({ grant: input.grant }).revision !== input.expectedRevision) fail('conflict');
    const selection = {
      previousRevision: input.expectedRevision,
      commandId: input.commandId,
      grant: input.grant,
      candidate: input.candidate,
    };
    const record: RuntimeSourceRecord = { ...selection, revision: runtimeDigest(selection) };
    const receipt: StoredRuntimeSourceCommand = storedRuntimeSourceCommandSchema.parse({
      schemaVersion: 1,
      kind: 'runtime.source',
      commandId: input.commandId,
      profileId: seed.profileId,
      configRevision: seed.configRevision,
      providerId: seed.provider,
      fingerprint,
      selectionDigest: this.seedRevision(input.grant, seed),
      resourceId: input.grant.targetId,
      resourceHeld: false,
      sourceId: input.grant.targetId,
      revision: record.revision,
      expectedRevision: input.expectedRevision,
      phase: 'prepared',
    });
    if (!prior) this.commands.write(receipt);
    await verifyRuntimeSourceCandidate(seed, input.candidate);
    this.assertWriter();
    const known = this.lookup({ grant: input.grant, commandId: input.commandId });
    if (known?.phase === 'published') return known;
    // Admission preserves original auth/config bindings and cannot replace a previously admitted profile ID.
    admit(this.managementProfile(record));
    this.store.publish(record, this.seedRevision(input.grant, seed));
    this.commands.write({ ...receipt, phase: 'published' });
    return {
      commandId: input.commandId,
      phase: 'published',
      selection: this.summary(input.grant, seed, record),
    };
  }

  retainedManagementProfiles(): ProviderManagementProfile[] {
    return this.read().records.map((record) => this.managementProfile(record));
  }

  currentForRecipe(
    scope: RuntimeSourceTeamScope,
    projectPath: string,
    recipe: RuntimeMemberProfile
  ): RuntimeSourceReference | undefined {
    const index = this.read();
    const available = index.current
      .map((pointer) => index.records.find((row) => row.revision === pointer.revision)!)
      .filter((record) => this.applies(record.grant, scope, projectPath, recipe));
    const project = available.filter((record) => record.grant.projectPath === projectPath);
    const selected = project.length
      ? project
      : available.filter((record) => record.grant.projectPath === null);
    if (selected.length > 1) fail('held');
    const record = selected[0];
    return record ? { sourceId: record.grant.targetId, revision: record.revision } : undefined;
  }

  resolveRecipe(
    reference: RuntimeSourceReference,
    scope: RuntimeSourceTeamScope,
    projectPath: string,
    recipe: RuntimeMemberProfile
  ): RuntimeMemberProfile {
    const record = this.read().records.find(
      (row) => row.grant.targetId === reference.sourceId && row.revision === reference.revision
    );
    if (!record || !this.applies(record.grant, scope, projectPath, recipe)) return fail('held');
    const seed = this.seed(record.grant);
    if (seed.executable.sha256 !== recipe.executable.sha256) fail('held');
    if (
      recipe.provider === 'opencode' &&
      seed.provider === 'opencode' &&
      (recipe.nativeGeneration !== seed.nativeGeneration ||
        recipe.embedded?.manifestSha256 !== seed.embedded?.manifestSha256)
    )
      fail('held');
    return runtimeMemberProfileSchema.parse({
      ...structuredClone(recipe),
      executable: record.candidate.executable,
      ...(recipe.provider === 'opencode' && recipe.embedded && record.candidate.embedded
        ? { embedded: { ...recipe.embedded, ...record.candidate.embedded } }
        : {}),
    });
  }

  private applies(
    grant: RuntimeSourceGrant,
    scope: RuntimeSourceTeamScope,
    projectPath: string,
    recipe: RuntimeMemberProfile
  ): boolean {
    const authorized =
      grant.teamScopes.some(
        (row) =>
          row.teamId === scope.teamId &&
          row.projectId === scope.projectId &&
          row.workspaceId === scope.workspaceId
      ) ||
      (this.profile.creation?.contextIds.includes(grant.contextId) &&
        scope.projectId === grant.contextId &&
        scope.workspaceId === grant.contextId);
    return (
      !!authorized &&
      grant.runtimeId === recipe.provider &&
      (grant.projectPath === null || grant.projectPath === projectPath)
    );
  }

  private seed(raw: RuntimeSourceGrant): ProviderManagementProfile {
    this.assertWriter();
    const grant = runtimeSourceGrantSchema.parse(raw);
    if (
      grant.ownerId !== this.profile.owner.ownerId ||
      grant.ownerRevision !== this.profile.owner.revision
    )
      return fail('conflict');
    if (
      grant.teamScopes.some(
        (scope) =>
          !this.profile.teams.some(
            (team) =>
              team.scope.teamId === scope.teamId &&
              team.scope.projectId === scope.projectId &&
              team.scope.workspaceId === scope.workspaceId
          )
      )
    )
      return fail('conflict');
    const seeds =
      this.profile.management?.filter(
        (row) =>
          row.profileId === grant.profileId &&
          row.configRevision === grant.configRevision &&
          row.provider === grant.runtimeId
      ) ?? [];
    const seed = seeds[0];
    if (
      seeds.length !== 1 ||
      !seed ||
      (grant.projectPath !== null && grant.projectPath !== seed.cwd)
    )
      return fail('conflict');
    return seed;
  }

  private seedRevision(grant: RuntimeSourceGrant, seed: ProviderManagementProfile): string {
    return runtimeDigest({ grant, seed });
  }

  private summary(
    grant: RuntimeSourceGrant,
    seed: ProviderManagementProfile,
    record?: RuntimeSourceRecord
  ): RuntimeSourceSummary {
    return {
      sourceId: grant.targetId,
      revision: record?.revision ?? this.seedRevision(grant, seed),
      profileId: record ? `runtime-source:${record.revision}` : seed.profileId,
      configRevision: record ? `runtime-source:${record.revision}` : seed.configRevision,
      sourceKind: record?.candidate.sourceKind ?? 'captured',
      ...(seed.provider === 'opencode'
        ? {
            nativeGeneration: seed.nativeGeneration ?? 'v1',
            ...(seed.embedded ? { engineVersion: seed.embedded.version } : {}),
          }
        : {}),
    };
  }

  private managementProfile(record: RuntimeSourceRecord): ProviderManagementProfile {
    const seed = this.seed(record.grant),
      selected = this.summary(record.grant, seed, record);
    return providerManagementProfileSchema.parse({
      ...structuredClone(seed),
      profileId: selected.profileId,
      configRevision: selected.configRevision,
      executable: record.candidate.executable,
      ...(seed.provider === 'opencode' && seed.embedded && record.candidate.embedded
        ? { embedded: { ...seed.embedded, ...record.candidate.embedded } }
        : {}),
    });
  }

  private read(): ReturnType<FileRuntimeSourceIndex['read']> {
    const index = this.store.read(),
      previous = new Map<string, string>(),
      grants = new Map<string, string>();
    for (const record of index.records) {
      const seed = this.seed(record.grant),
        sourceId = record.grant.targetId,
        grantDigest = runtimeDigest(record.grant);
      assertRuntimeSourceQualification(seed, record.candidate);
      if (
        (grants.has(sourceId) && grants.get(sourceId) !== grantDigest) ||
        record.previousRevision !==
          (previous.get(sourceId) ?? this.seedRevision(record.grant, seed))
      )
        fail('held');
      const receipt = this.commands.read(record.commandId);
      if (
        !receipt ||
        receipt.kind !== 'runtime.source' ||
        receipt.revision !== record.revision ||
        receipt.sourceId !== sourceId ||
        receipt.resourceId !== sourceId ||
        receipt.profileId !== seed.profileId ||
        receipt.configRevision !== seed.configRevision ||
        receipt.providerId !== seed.provider ||
        receipt.selectionDigest !== this.seedRevision(record.grant, seed) ||
        receipt.expectedRevision !== record.previousRevision ||
        receipt.fingerprint !==
          runtimeDigest({
            grant: record.grant,
            commandId: record.commandId,
            expectedRevision: record.previousRevision,
            candidate: record.candidate,
          })
      )
        fail('held');
      grants.set(sourceId, grantDigest);
      previous.set(sourceId, record.revision);
    }
    if (
      previous.size !== index.current.length ||
      index.current.some((pointer) => previous.get(pointer.sourceId) !== pointer.revision)
    )
      fail('held');
    return index;
  }
}
