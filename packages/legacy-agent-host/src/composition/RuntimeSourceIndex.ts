import { FileRuntimeSourceIndex } from '../adapters/profile/FileRuntimeSourceIndex.js';
import { FileManagementCommandStore } from '../adapters/providers/FileManagementCommandStore.js';
import { RuntimeSourceNativeVersion } from '../adapters/providers/RuntimeSourceNativeVersion.js';
import { captureOpenCodeConfigurationSource, OpenCodeConfigurationError } from '../adapters/providers/OpenCodeConfigurationSource.js';
import {
  ManagementCommandError,
  storedRuntimeSourceCommandSchema,
} from '../management/commandRecords.js';
import { providerManagementProfileSchema } from '../management/profile.js';
import { runtimeDigest } from '../runtime/identity.js';
import { runtimeMemberProfileSchema } from './runtimeProfile.js';
import { applyOpenCodeRuntimeSource } from './applyOpenCodeRuntimeSource.js';
import { readOpenCodeConfiguredModel, selectOpenCodeV2ProviderConfiguration } from './openCodeSelectedProviderConfiguration.js';
import { openCodeManagedPreferencesDigest } from './openCodeManagedPreferences.js';
import {
  publishRuntimeSourceSchema,
  publishRuntimeSourceRequestSchema,
  runtimeSourceLookupSchema,
  runtimeSourceReadSchema,
  refreshRuntimeConfigurationSchema,
} from './runtimeSourceContracts.js';
import {
  assertRuntimeSourceQualification,
  verifyRuntimeSourceCandidate,
  verifyRuntimeSourceExecutable,
} from './verifyRuntimeSourceCandidate.js';
import { RuntimeSourceAdmissionError } from './runtimeSourceQualification.js';
import { runtimeSourceProcessOriginSchema, runtimeSourceRecipeIdentity } from './runtimeSourceProcessOrigin.js';
import type { RuntimeSourceProcessOrigin } from './runtimeSourceProcessOrigin.js';
import { RuntimeSourceUnavailable, readOriginalRuntimeSourcePublication, sameRuntimeSourceGrantAuthority,
  validateRuntimeSourceHistory, selectRuntimeSourceSeed, runtimeSourceNativeIdentityMatches,
  runtimeSourceGrantMatchesScope, assertRuntimeSourceScopeAvailable } from './runtimeSourceGrantAuthority.js';
import type { RuntimeSourceRecord } from '../adapters/profile/FileRuntimeSourceIndex.js';
import type { ProviderManagementProfile } from '../management/profile.js';
import type {
  ManagementCommandStore,
  StoredRuntimeSourceCommand,
} from '../management/commandRecords.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { RegisteredProcessRootSource } from '../process/registeredProcessContracts.js';
import type {
  RuntimeSourceNativeCheck,
  RuntimeSourceNativeIdentity,
} from '../management/runtimeSourceVerification.js';
import type {
  RuntimeRecipeSources,
  RuntimeSourceGrant,
  RuntimeSourcePublication,
  RuntimeSourceReference,
  RuntimeSourceSummary,
  RuntimeSourceTeamScope,
  RuntimeSourceCandidate,
  PublishRuntimeSource,
} from './runtimeSourceContracts.js';

function fail(code: 'invalid' | 'conflict' | 'held'): never {
  throw new ManagementCommandError(code);
}

/** One leased index over immutable seed recipes. Native sessions and credentials stay with existing owners. */
export class RuntimeSourceIndex implements RuntimeRecipeSources {
  private readonly store: FileRuntimeSourceIndex;
  private readonly commands: ManagementCommandStore;
  private readonly pending = new Map<
    string,
    { fingerprint: string; result: Promise<RuntimeSourcePublication> }
  >();
  private readonly checks = new Map<string, RuntimeSourceNativeCheck>();
  private sealed = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly profile: TeamHostProfile,
    private readonly assertWriter: () => void,
    private readonly options: {
      processCustody?: RegisteredProcessRootSource;
      assertCleanupWriter?(): void;
      createNativeCheck?(
        seed: ProviderManagementProfile,
        candidate: RuntimeSourceCandidate,
        isCurrent: () => boolean
      ): RuntimeSourceNativeCheck;
    } = {}
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
    const { grant: requested } = runtimeSourceReadSchema.parse(raw),
      grant = this.bindGrant(requested),
      seed = this.seed(grant),
      index = this.read();
    const pointer = index.current.find((row) => row.sourceId === grant.targetId);
    const record = pointer
      ? index.records.find((row) => row.revision === pointer.revision)!
      : undefined;
    if (record && runtimeDigest(record.grant) !== runtimeDigest(grant)) fail('conflict');
    if (record) this.retainedSeed(record);
    const summary = this.summary(grant, seed, record);
    if (seed.provider === 'opencode' && seed.nativeGeneration === 'v2' && seed.embedded) {
      const reference = record?.candidate.openCodeConfiguration ?? seed.embedded.configurationSource;
      try {
        const current = captureOpenCodeConfigurationSource(seed, reference, () => !this.sealed,
          grant.projectPath === null ? 'global' : 'project');
        summary.configurationCurrent = reference !== undefined && current.isCurrent();
      } catch { summary.configurationCurrent = false; }
    }
    return summary;
  }

  retained(raw: unknown): RuntimeSourceSummary[] {
    const { grant: requested } = runtimeSourceReadSchema.parse(raw),
      grant = this.bindGrant(requested),
      seed = this.seed(grant);
    const records = this.read().records.filter((row) => row.grant.targetId === grant.targetId);
    if (records.some((row) => runtimeDigest(row.grant) !== runtimeDigest(grant))) fail('conflict');
    for (const record of records) this.retainedSeed(record);
    return [
      this.summary(grant, seed),
      ...records.map((record) => this.summary(grant, seed, record)),
    ];
  }

  lookup(raw: unknown): RuntimeSourcePublication | null {
    const { grant: requested, commandId } = runtimeSourceLookupSchema.parse(raw),
      grant = this.bindGrant(requested, commandId),
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
      if (saved.phase === 'verifying' && !this.checks.has(commandId))
        return { commandId, phase: 'held', reason: 'native-outcome-unknown' };
      return { commandId, phase: saved.phase, ...(saved.reason ? { reason: saved.reason } : {}) };
    }
    if (record.revision !== saved.revision || runtimeDigest(record.grant) !== runtimeDigest(grant))
      fail('held');
    this.retainedSeed(record);
    if (saved.phase !== 'published')
      this.commands.write({ ...saved, phase: 'published', resourceHeld: false });
    return { commandId, phase: 'published', selection: this.summary(grant, seed, record) };
  }

  /** A restarted installer may finish one original journaled selection; it cannot invent a new one. */
  async recover(
    raw: unknown,
    admit: (profile: ProviderManagementProfile) => void
  ): Promise<RuntimeSourcePublication | null> {
    this.assertWriter();
    if (this.sealed) fail('held');
    const { grant: requested } = runtimeSourceReadSchema.parse(raw);
    const grant = this.bindGrant(requested);
    this.seed(grant);
    const unfinished = [...this.commands.list()].filter(
      (row): row is StoredRuntimeSourceCommand =>
        row.kind === 'runtime.source' &&
        row.sourceId === grant.targetId &&
        row.phase !== 'published' &&
        (row.phase !== 'held' || row.resourceHeld)
    );
    if (!unfinished.length) return null;
    if (unfinished.length !== 1) return fail('held');
    const saved = unfinished[0]!;
    const input = this.publicationSnapshot(saved, grant);
    return this.publish(input, admit);
  }

  private publicationSnapshot(
    saved: StoredRuntimeSourceCommand,
    grant: RuntimeSourceGrant
  ): PublishRuntimeSource {
    const input = readOriginalRuntimeSourcePublication(saved, value => this.seed(value));
    if (runtimeDigest(input.grant) !== runtimeDigest(grant)) return fail('held');
    return input;
  }

  /** Keep old fingerprints intact; only an equal authority set may reuse their original grant. */
  private bindGrant(grant: RuntimeSourceGrant, commandId?: string): RuntimeSourceGrant {
    this.seed(grant);
    const retained = this.read().records.find(record => record.grant.targetId === grant.targetId)?.grant;
    const command = commandId === undefined ? undefined : this.commands.read(commandId);
    if (command && command.kind !== 'runtime.source') return fail('conflict');
    let original = command?.publicationJson
      ? readOriginalRuntimeSourcePublication(command, value => this.seed(value)).grant : retained;
    if (original && retained && command && (command.phase !== 'held' || command.resourceHeld) &&
        runtimeDigest(original) !== runtimeDigest(retained)) return fail('held');
    if (!original) {
      const unfinished = [...this.commands.list()].filter((row): row is StoredRuntimeSourceCommand =>
        row.kind === 'runtime.source' && row.sourceId === grant.targetId &&
        row.phase !== 'published' && (row.phase !== 'held' || row.resourceHeld));
      if (unfinished.length > 1) return fail('held');
      if (unfinished[0]) original = readOriginalRuntimeSourcePublication(
        unfinished[0], value => this.seed(value)).grant;
    }
    if (!original) return grant;
    if (!sameRuntimeSourceGrantAuthority(original, grant)) return fail('conflict');
    return original;
  }

  async publish(
    raw: unknown,
    admit: (profile: ProviderManagementProfile) => void
  ): Promise<RuntimeSourcePublication> {
    this.assertWriter();
    if (this.sealed) fail('held');
    const input = this.capturePublication(raw);
    const fingerprint = runtimeDigest(input),
      pending = this.pending.get(input.commandId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) fail('conflict');
      return pending.result;
    }
    const result = this.publishCandidate(input, admit);
    this.pending.set(input.commandId, { fingerprint, result });
    try {
      return await result;
    } finally {
      if (this.pending.get(input.commandId)?.result === result)
        this.pending.delete(input.commandId);
    }
  }

  /** Same publication owner; retry resumes its original config snapshot, never captures a replacement. */
  async refreshConfiguration(
    raw: unknown,
    admit: (profile: ProviderManagementProfile) => void
  ): Promise<RuntimeSourcePublication> {
    this.assertWriter();
    if (this.sealed) fail('held');
    const input = refreshRuntimeConfigurationSchema.parse(raw);
    input.grant = this.bindGrant(input.grant, input.commandId);
    const seed = this.seed(input.grant);
    const prior = this.commands.read(input.commandId);
    if (prior) {
      if (prior.kind !== 'runtime.source') fail('conflict');
      const original = this.publicationSnapshot(prior, input.grant);
      if (original.intent !== 'configuration' || original.expectedRevision !== input.expectedRevision)
        fail('conflict');
      return this.publish(original, admit);
    }
    if (seed.provider !== 'opencode') fail('invalid');
    if (this.current({ grant: input.grant }).revision !== input.expectedRevision) fail('conflict');
    const previous = this.read().records.find(record => record.grant.targetId === input.grant.targetId &&
      record.revision === input.expectedRevision);
    const candidate: RuntimeSourceCandidate = { ...(previous?.candidate ??
      { sourceKind: 'captured', executable: seed.executable }) };
    if (input.openCodePreferences) candidate.openCodePreferences = input.openCodePreferences;
    if (seed.nativeGeneration === 'v2' && seed.embedded) {
      const captured = captureOpenCodeConfigurationSource(seed, undefined, () => !this.sealed,
        input.grant.projectPath === null ? 'global' : 'project');
      const config = captured.read(), configuredModel = readOpenCodeConfiguredModel(config);
      const selectedModel = readOpenCodeConfiguredModel({ model: candidate.openCodePreferences?.defaultModelId ?? undefined })
        ?? configuredModel ?? seed.nativeModel;
      if (!selectedModel) fail('invalid');
      selectOpenCodeV2ProviderConfiguration(config, selectedModel, seed.environment);
      candidate.openCodeConfiguration = captured.reference;
      delete candidate.openCodeDefault;
      if (configuredModel) candidate.openCodeDefault = configuredModel;
    } else if (seed.nativeGeneration === 'v2' || !input.openCodePreferences) fail('invalid');
    return this.publish({ grant: input.grant, commandId: input.commandId,
      expectedRevision: input.expectedRevision, intent: 'configuration', candidate }, admit);
  }

  private capturePublication(raw: unknown): PublishRuntimeSource {
    const input = publishRuntimeSourceRequestSchema.parse(structuredClone(raw));
    input.grant = this.bindGrant(input.grant, input.commandId);
    if ('candidate' in input) return input;
    const seed = this.seed(input.grant),
      seedRevision = this.seedRevision(input.grant, seed);
    const previous =
      input.expectedRevision === seedRevision
        ? undefined
        : this.read().records.find(
            (row) =>
              row.grant.targetId === input.grant.targetId && row.revision === input.expectedRevision
          );
    if (
      (!previous && input.expectedRevision !== seedRevision) ||
      (previous && runtimeDigest(previous.grant) !== runtimeDigest(input.grant))
    )
      fail('conflict');
    const selection = input.nativeSelection;
    const embedded = selection.embedded ?? previous?.candidate.embedded;
    // Replay inherits only the original expected revision; current is never a repair/default source.
    return publishRuntimeSourceSchema.parse({
      grant: input.grant,
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      candidate: {
        sourceKind: selection.sourceKind,
        executable:
          seed.provider === 'opencode' && seed.nativeGeneration === 'v2'
            ? (previous?.candidate.executable ?? seed.executable)
            : selection.nativeCli.executable,
        ...(embedded ? { embedded } : {}),
        nativeCli: selection.nativeCli,
        ...(previous?.candidate.openCodeConfiguration
          ? { openCodeConfiguration: previous.candidate.openCodeConfiguration } : {}),
        ...(previous?.candidate.openCodeDefault ? { openCodeDefault: previous.candidate.openCodeDefault } : {}),
        ...(previous?.candidate.openCodePreferences ? { openCodePreferences: previous.candidate.openCodePreferences } : {}),
      },
    });
  }

  private async publishCandidate(
    input: PublishRuntimeSource,
    admit: (profile: ProviderManagementProfile) => void
  ): Promise<RuntimeSourcePublication> {
    const seed = this.seed(input.grant);
    const fingerprint = runtimeDigest(input),
      prior = this.commands.read(input.commandId);
    if (prior) {
      if (prior.kind !== 'runtime.source' || prior.fingerprint !== fingerprint) fail('conflict');
      if (prior.phase === 'held' && prior.resourceHeld)
        await this.settleRetainedCleanup(prior, seed, input.candidate);
      const known = this.lookup({ grant: input.grant, commandId: input.commandId });
      if (known?.phase === 'published' || known?.phase === 'held') return known;
    }
    if (this.current({ grant: input.grant }).revision !== input.expectedRevision) fail('conflict');
    assertRuntimeSourceQualification(seed, input.candidate);
    if ((input.intent === 'configuration' && !input.candidate.openCodeConfiguration && !input.candidate.openCodePreferences) ||
        (input.candidate.openCodeConfiguration && input.candidate.openCodeConfiguration.scope !==
          (input.grant.projectPath === null ? 'global' : 'project'))) fail('invalid');
    this.assertSourceReleased(input.grant.targetId, input.commandId);
    const selection = {
      previousRevision: input.expectedRevision,
      commandId: input.commandId,
      grant: input.grant,
      candidate: input.candidate,
      ...(input.intent ? { intent: input.intent } : {}),
    };
    const record: RuntimeSourceRecord = { ...selection, revision: runtimeDigest(selection) };
    // Reject an unrepresentable selected default before reserving its publication command.
    const managementProfile = this.managementProfile(record, seed);
    let receipt: StoredRuntimeSourceCommand = storedRuntimeSourceCommandSchema.parse({
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
      publicationJson: JSON.stringify(input),
      phase: 'prepared',
    });
    if (!prior) this.commands.write(receipt);
    else {
      const saved = this.commands.read(input.commandId);
      if (!saved || saved.kind !== 'runtime.source') fail('held');
      receipt = saved;
    }
    const assertCurrent = () => { this.assertWriter(); if (this.sealed) fail('held'); };
    try {
      await verifyRuntimeSourceCandidate(seed, input.candidate, assertCurrent);
    } catch (error) {
      if (receipt.resourceHeld || !['prepared', 'verified'].includes(receipt.phase)) throw error;
      (this.options.assertCleanupWriter ?? this.assertWriter)();
      const reason = error instanceof OpenCodeConfigurationError ? error.reason : 'source-changed';
      this.commands.write({ ...receipt, phase: 'held', resourceHeld: false, reason });
      throw new RuntimeSourceAdmissionError(reason);
    }
    if (input.candidate.nativeCli && receipt.phase !== 'verified')
      receipt = await this.verifyNative(seed, input.candidate, receipt);
    if (receipt.phase === 'held')
      return {
        commandId: input.commandId,
        phase: 'held',
        ...(receipt.reason ? { reason: receipt.reason } : {}),
      };
    assertCurrent();
    const checks: Awaited<ReturnType<typeof verifyRuntimeSourceExecutable>>[] = [];
    try {
      checks.push(await verifyRuntimeSourceExecutable(input.candidate.executable, assertCurrent));
      if (input.candidate.nativeCli)
        checks.push(await verifyRuntimeSourceExecutable(input.candidate.nativeCli.executable, assertCurrent));
      for (const check of checks) check.assertCurrent();
      if (input.candidate.openCodeConfiguration)
        captureOpenCodeConfigurationSource(seed, input.candidate.openCodeConfiguration);
    } catch (error) {
      for (const check of checks) check.close();
      (this.options.assertCleanupWriter ?? this.assertWriter)();
      const reason = error instanceof OpenCodeConfigurationError ? error.reason : 'source-changed';
      this.commands.write({
        ...receipt,
        phase: 'held',
        resourceHeld: false,
        reason,
      });
      throw new RuntimeSourceAdmissionError(reason);
    }
    try {
      const known = this.lookup({ grant: input.grant, commandId: input.commandId });
      if (known?.phase === 'published') return known;
      // No await separates original fd/path checks from the existing atomic publication.
      // Admission preserves auth/config bindings and cannot replace an admitted profile ID.
      admit(managementProfile);
      this.store.publish(record, this.seedRevision(input.grant, seed));
      this.commands.write({ ...receipt, phase: 'published' });
      return {
        commandId: input.commandId,
        phase: 'published',
        selection: this.summary(input.grant, seed, record),
      };
    } finally {
      for (const check of checks) check.close();
    }
  }

  private assertSourceReleased(sourceId: string, commandId: string): void {
    for (const row of this.commands.list())
      if (
        row.kind === 'runtime.source' &&
        row.sourceId === sourceId &&
        row.commandId !== commandId &&
        (row.resourceHeld || ['prepared', 'verifying', 'verified'].includes(row.phase))
      )
        fail('held');
  }

  private async verifyNative(
    seed: ProviderManagementProfile,
    candidate: RuntimeSourceCandidate,
    receipt: StoredRuntimeSourceCommand
  ): Promise<StoredRuntimeSourceCommand> {
    this.assertWriter();
    if (this.sealed) fail('held');
    this.assertSourceReleased(receipt.sourceId, receipt.commandId);
    const claimed: StoredRuntimeSourceCommand = {
      ...receipt,
      phase: 'verifying',
      resourceHeld: true,
    };
    this.commands.write(claimed);
    let check: RuntimeSourceNativeCheck | undefined,
      identity: RuntimeSourceNativeIdentity | undefined,
      failure: unknown,
      clean = false;
    try {
      const current = () => {
        try {
          this.assertWriter();
          return !this.sealed;
        } catch {
          return false;
        }
      };
      check =
        this.options.createNativeCheck?.(seed, candidate, current) ??
        new RuntimeSourceNativeVersion(seed, candidate, current, this.options.processCustody);
      this.checks.set(receipt.commandId, check);
      identity = await check.run();
    } catch (error) {
      failure = error;
    } finally {
      clean = check ? await check.close().catch(() => false) : true;
      if (clean) this.checks.delete(receipt.commandId);
    }
    (this.options.assertCleanupWriter ?? this.assertWriter)();
    let current = !this.sealed;
    try {
      this.assertWriter();
    } catch {
      current = false;
    }
    const accepted = current && clean && this.identityMatches(seed, candidate, identity);
    const saved: StoredRuntimeSourceCommand = accepted
      ? { ...claimed, ...identity, phase: 'verified', resourceHeld: false }
      : {
          ...claimed,
          ...identity,
          phase: 'held',
          resourceHeld: !clean,
          reason: !clean
            ? 'cleanup-unconfirmed'
            : failure instanceof RuntimeSourceAdmissionError
              ? failure.reason
              : 'native-outcome-unknown',
        };
    this.commands.write(saved);
    return saved;
  }

  private identityMatches(
    seed: ProviderManagementProfile,
    candidate: RuntimeSourceCandidate,
    identity:
      | { nativeVersion?: string | undefined; seedNativeVersion?: string | undefined }
      | undefined
  ): boolean {
    return runtimeSourceNativeIdentityMatches(seed, candidate, identity);
  }

  private async settleRetainedCleanup(
    receipt: StoredRuntimeSourceCommand,
    seed: ProviderManagementProfile,
    candidate: RuntimeSourceCandidate
  ): Promise<void> {
    const check = this.checks.get(receipt.commandId);
    if (!check || !(await check.close().catch(() => false))) return;
    this.assertWriter();
    this.checks.delete(receipt.commandId);
    const { reason: _reason, ...released } = receipt;
    this.commands.write(
      this.identityMatches(seed, candidate, receipt)
        ? { ...released, phase: 'verified', resourceHeld: false }
        : { ...released, phase: 'held', resourceHeld: false, reason: 'native-outcome-unknown' }
    );
  }

  seal(): void {
    this.sealed = true;
  }

  close(): Promise<void> {
    this.sealed = true;
    if (!this.closing) {
      const closing = (async () => {
        const closed = await Promise.all(
          [...this.checks].map(async ([commandId, check]) => {
            const clean = await check.close().catch(() => false);
            if (clean) {
              (this.options.assertCleanupWriter ?? this.assertWriter)();
              const saved = this.commands.read(commandId);
              if (saved?.kind === 'runtime.source' && saved.resourceHeld)
                this.commands.write({
                  ...saved,
                  phase: 'held',
                  resourceHeld: false,
                  reason: 'native-outcome-unknown',
                });
              this.checks.delete(commandId);
            }
            return clean;
          })
        );
        await Promise.allSettled([...this.pending.values()].map((entry) => entry.result));
        if (closed.some((value) => !value) || [...this.commands.list()].some(row =>
          row.kind === 'runtime.source' && row.resourceHeld)) fail('held');
      })();
      this.closing = closing;
      void closing.catch(() => { if (this.closing === closing) this.closing = undefined; });
    }
    return this.closing;
  }

  retainedManagementProfiles(): ProviderManagementProfile[] {
    return this.retainedManagementState().profiles;
  }

  /** Ineligible profiles remain known refusals; their original commands and fences are not removed. */
  retainedManagementState() {
    const profiles: ProviderManagementProfile[] = [];
    const unavailable: { profileId: string; configRevision: string }[] = [];
    for (const record of this.read().records) {
      try { profiles.push(this.managementProfile(record)); }
      catch (error) {
        if (!(error instanceof RuntimeSourceUnavailable)) throw error;
        unavailable.push({ profileId: `runtime-source:${record.revision}`,
          configRevision: `runtime-source:${record.revision}` });
      }
    }
    return { profiles, unavailable, hasCommands: [...this.commands.list()].length !== 0 };
  }

  currentForRecipe(
    scope: RuntimeSourceTeamScope,
    projectPath: string,
    recipe: RuntimeMemberProfile
  ): RuntimeSourceReference | undefined {
    const index = this.read();
    const available = index.current
      .map((pointer) => index.records.find((row) => row.revision === pointer.revision)!)
      .filter(record => record.grant.runtimeId === recipe.provider &&
        this.matchesScope(record.grant, scope, projectPath));
    const project = available.filter((record) => record.grant.projectPath === projectPath);
    const selected = project.length
      ? project
      : available.filter((record) => record.grant.projectPath === null);
    if (selected.length > 1) fail('held');
    const record = selected[0];
    if (record) this.assertReferenceAvailable({ sourceId: record.grant.targetId, revision: record.revision }, scope, projectPath);
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
    if (!record || !this.matchesScope(record.grant, scope, projectPath)) return fail('held');
    this.assertReferenceAvailable(reference, scope, projectPath);
    const seed = this.retainedSeed(record);
    if (seed.provider !== recipe.provider || seed.executable.sha256 !== recipe.executable.sha256)
      throw new RuntimeSourceUnavailable();
    if (
      recipe.provider === 'opencode' &&
      seed.provider === 'opencode' &&
      ((recipe.nativeGeneration ?? 'v1') !== (seed.nativeGeneration ?? 'v1') ||
        recipe.embedded?.manifestSha256 !== seed.embedded?.manifestSha256)
    )
      throw new RuntimeSourceUnavailable();
    return runtimeMemberProfileSchema.parse({
      ...(recipe.provider === 'opencode'
        ? applyOpenCodeRuntimeSource(recipe, record.candidate) : structuredClone(recipe)),
      ...(recipe.provider === 'codex' && record.candidate.nativeCli
        ? { protocolRevision: record.candidate.nativeCli.version } : {}),
      executable: record.candidate.executable,
    });
  }

  /** Private process metadata only; returned recipe/profile bytes and their retained digests stay unchanged. */
  processOrigin(reference: RuntimeSourceReference, scope: RuntimeSourceTeamScope,
    projectPath: string, recipe: RuntimeMemberProfile): RuntimeSourceProcessOrigin | undefined {
    this.resolveRecipe(reference, scope, projectPath, recipe);
    if (recipe.teamId !== scope.teamId) fail('held');
    if (!this.profile.processCustody || !('kind' in this.profile.processCustody) ||
        this.profile.processCustody.kind !== 'main-windows-v1') return undefined;
    return runtimeSourceProcessOriginSchema.parse({ sourceId: reference.sourceId, revision: reference.revision,
      origin: { kind: 'runtime', scope: { teamId: scope.teamId, projectId: scope.projectId,
        workspaceId: scope.workspaceId }, projectPath, teamId: recipe.teamId,
        memberId: recipe.memberId, recipeIdentity: runtimeSourceRecipeIdentity(recipe) } });
  }

  /** Source-management IDs already name one immutable revision; this does not consult the current pointer. */
  managementProcessOrigin(profile: ProviderManagementProfile): RuntimeSourceProcessOrigin | undefined {
    const record = this.read().records.find(row => profile.profileId === `runtime-source:${row.revision}` &&
      profile.configRevision === `runtime-source:${row.revision}`);
    if (!record) return undefined;
    const seed = this.retainedSeed(record);
    if (runtimeDigest(this.managementProfile(record, seed)) !== runtimeDigest(profile)) fail('held');
    return this.managementOrigin(record, seed);
  }

  private managementOrigin(record: RuntimeSourceRecord, seed: ProviderManagementProfile): RuntimeSourceProcessOrigin {
    return runtimeSourceProcessOriginSchema.parse({ sourceId: record.grant.targetId, revision: record.revision,
      origin: { kind: 'management', profileId: seed.profileId, configRevision: seed.configRevision } });
  }

  assertReferenceAvailable(reference: RuntimeSourceReference, scope: RuntimeSourceTeamScope, projectPath: string): void {
    const record = this.read().records.find(row =>
      row.grant.targetId === reference.sourceId && row.revision === reference.revision);
    if (!record || !this.matchesScope(record.grant, scope, projectPath)) fail('held');
    this.retainedSeed(record);
    assertRuntimeSourceScopeAvailable(this.profile, record.grant, scope, projectPath);
  }

  private matchesScope(grant: RuntimeSourceGrant, scope: RuntimeSourceTeamScope, projectPath: string): boolean {
    return runtimeSourceGrantMatchesScope(grant, scope, projectPath);
  }

  private retainedSeed(record: RuntimeSourceRecord): ProviderManagementProfile {
    const seed = this.seed(record.grant, true), receipt = this.commands.read(record.commandId);
    if (!receipt || receipt.kind !== 'runtime.source') return fail('held');
    if (receipt.selectionDigest !== this.seedRevision(record.grant, seed))
      throw new RuntimeSourceUnavailable();
    assertRuntimeSourceQualification(seed, record.candidate);
    if (record.candidate.nativeCli && !this.identityMatches(seed, record.candidate, receipt)) fail('held');
    return seed;
  }

  private seed(raw: RuntimeSourceGrant, retained = false): ProviderManagementProfile {
    this.assertWriter();
    return selectRuntimeSourceSeed(this.profile, raw, retained);
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
      ...(record?.candidate.openCodePreferences ? {
        preferencesDigest: openCodeManagedPreferencesDigest(record.candidate.openCodePreferences),
      } : {}),
      ...(record?.candidate.nativeCli ? { cliVersion: record.candidate.nativeCli.version } : {}),
      ...(seed.provider === 'opencode'
        ? {
            nativeGeneration: seed.nativeGeneration ?? 'v1',
            ...(seed.embedded ? { engineVersion: seed.embedded.version } : {}),
          }
        : {}),
    };
  }

  private managementProfile(record: RuntimeSourceRecord, seed = this.retainedSeed(record)): ProviderManagementProfile {
    const selected = this.summary(record.grant, seed, record);
    return providerManagementProfileSchema.parse({
      ...(seed.provider === 'opencode'
        ? applyOpenCodeRuntimeSource(seed, record.candidate) : structuredClone(seed)),
      ...(seed.provider === 'codex' && record.candidate.nativeCli
        ? { protocolRevision: record.candidate.nativeCli.version } : {}),
      profileId: selected.profileId,
      configRevision: selected.configRevision,
      executable: record.candidate.executable,
    });
  }

  private read(): ReturnType<FileRuntimeSourceIndex['read']> {
    const index = this.store.read();
    validateRuntimeSourceHistory(index, this.commands);
    return index;
  }
}
