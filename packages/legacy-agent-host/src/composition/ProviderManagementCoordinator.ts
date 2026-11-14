import { captureOpenCodeReadinessOrigin } from '../adapters/providers/OpenCodeReadinessOrigin.js';
import type { LocalModelReadinessOrigin } from '../management/commandRecords.js';
import { SkillCoordinator } from '../skills/SkillCoordinator.js';
import { NativeExtensionCoordinator } from '../extensions/NativeExtensionCoordinator.js';
import { ClaudeAuthenticationCoordinator } from './ClaudeAuthenticationCoordinator.js';
import { CodexManagementCoordinator } from './CodexManagementCoordinator.js';
import { ClaudeManagementCoordinator } from './ClaudeManagementCoordinator.js';
import { managementDigest } from '../management/identity.js';
import { z } from 'zod';
import { realpathSync, statSync } from 'node:fs';

import {
  OpenCodeManagementError,
  OpenCodeManagementHost,
} from '../adapters/providers/OpenCodeManagementHost.js';
import { withOpenCodeModelLimits } from '../adapters/providers/withOpenCodeModelLimits.js';
import { selectedOpenCodeManagedLimits } from './openCodeManagedPreferences.js';
import { readOpenCodeCatalog } from '../adapters/providers/readOpenCodeCatalog.js';
import { FileManagementCommandStore } from '../adapters/providers/FileManagementCommandStore.js';
import { CredentialCommandOwner } from '../management/CredentialCommandOwner.js';
import { assertManagementTarget, ManagementCommandError } from '../management/commandRecords.js';
import { ManagementResourceFence } from '../management/ManagementResourceFence.js';
import { OAuthOperationOwner } from '../management/OAuthOperationOwner.js';
import { ModelProbeOwner, nativeLocalReadinessPurpose } from '../management/ModelProbeOwner.js';
import type { ModelProbeInput, NativeModelProbe, NativeModelProbePurpose } from '../management/ModelProbeOwner.js';
import { createV1CoordinationProbe } from '../adapters/providers/OpenCodeCoordinationProbe.js';
import { createOpenCodeLocalModelReadiness } from '../adapters/providers/OpenCodeLocalModelReadiness.js';
import type { NativeReadinessCoordination } from '../adapters/providers/OpenCodeLocalModelReadiness.js';
import type { OpenCodeV1Coordination } from '../adapters/providers/OpenCodeCoordinationProbe.js';
import { closeCoordinationByDeadline } from '../adapters/providers/OpenCodeCoordinationEndpoint.js';
import { createOpenCodeV2ModelProbe } from '../adapters/providers/OpenCodeV2ModelProbe.js';
import { OpenCodeV2ManagementHost } from '../adapters/providers/OpenCodeV2ManagementHost.js';
import { createOpenCodeV2CredentialOperation } from '../adapters/providers/OpenCodeV2CredentialOperation.js';
import { OpenCodeV2CredentialScope } from '../adapters/providers/OpenCodeV2CredentialScope.js';

import type { ProviderManagementCatalog, ProviderOAuthSnapshot } from '../management/contracts.js';
import type {
  OpenCodeManagementProfile,
  ProviderManagementProfile,
} from '../management/profile.js';
import { providerManagementProfileSchema } from '../management/profile.js';
import type { CredentialCommand, CredentialTarget, CredentialProgressWriter } from '../management/CredentialCommandOwner.js';
import type { RegisteredProcessRootSource } from '../process/registeredProcessContracts.js';
import type { StoredCredentialCommand } from '../management/commandRecords.js';

/** The captured Host owns management process custody; Team policy and Session SPI stay separate. */
export class ProviderManagementCoordinator {
  private readonly profiles = new Map<string, OpenCodeManagementProfile>();
  private readonly hosts = new Map<string, OpenCodeManagementHost>();
  private readonly v1EndpointOperations = new Map<string, { tail: Promise<unknown>; pending: number }>();
  private readonly v2Hosts = new Map<string, OpenCodeV2ManagementHost>();
  private readonly v2CatalogReads = new Map<string, Promise<ProviderManagementCatalog>>();
  private readonly v2Keys = new Map<string, ReturnType<typeof createOpenCodeV2CredentialOperation>>();
  private readonly processCustody: RegisteredProcessRootSource | undefined;
  private readonly store: FileManagementCommandStore;
  private readonly fence: ManagementResourceFence;
  private sealed = false;
  private readonly unavailableTargets = new Set<string>();
  readonly codex: CodexManagementCoordinator;
  readonly claude: ClaudeManagementCoordinator;
  readonly claudeAuth: ClaudeAuthenticationCoordinator;
  readonly extensions: NativeExtensionCoordinator;
  readonly skills: SkillCoordinator;
  private readonly replacing = new Set<string>();
  readonly credentials: CredentialCommandOwner;
  readonly oauth: OAuthOperationOwner;
  readonly probes: ModelProbeOwner;

  constructor(
    profiles: ProviderManagementProfile[],
    private readonly assertWriter: () => void,
    storageRoot: string,
    options: {
      onOAuthProgress?(snapshot: ProviderOAuthSnapshot): void;
      unavailableProfiles?: readonly { profileId: string; configRevision: string }[];
      processCustody?: RegisteredProcessRootSource;
    } = {}
  ) {
    this.processCustody = options.processCustody;
    if (new Set(profiles.map((profile) => profile.profileId)).size !== profiles.length)
      throw new ManagementCommandError('invalid');
    this.codex = new CodexManagementCoordinator(
      profiles.filter((profile) => profile.provider === 'codex'),
      assertWriter
    );
    this.claude = new ClaudeManagementCoordinator(
      profiles.filter((profile) => profile.provider === 'claude'),
      assertWriter
    );
    this.claudeAuth = new ClaudeAuthenticationCoordinator(
      profiles.filter((profile) => profile.provider === 'claude'),
      (profileId, revision) => this.claude.target(profileId, revision),
      () => this.assertCurrent()
    );
    for (const profile of structuredClone(profiles)) {
      if (profile.provider !== 'opencode') continue;
      if (this.profiles.has(profile.profileId))
        throw new OpenCodeManagementError('invalid-profile');
      this.profiles.set(profile.profileId, profile);
    }
    const store = this.store = new FileManagementCommandStore(storageRoot);
    for (const target of options.unavailableProfiles ?? [])
      this.unavailableTargets.add(managementDigest(target));
    for (const row of store.list())
      if (!profiles.some(profile => profile.profileId === row.profileId && profile.configRevision === row.configRevision))
        this.unavailableTargets.add(managementDigest({ profileId: row.profileId, configRevision: row.configRevision }));
    const fence = this.fence = new ManagementResourceFence(store.list());
    this.skills = new SkillCoordinator(profiles, {
      store, fence, assertCurrent: () => this.assertCurrent(),
      managementTarget: (id, revision) => this.target(id, revision),
    });
    this.extensions = new NativeExtensionCoordinator(
      profiles.filter((profile) => profile.provider === 'claude'),
      {
        store,
        fence,
        assertCurrent: () => this.assertCurrent(),
        managementTarget: (id, revision) => this.target(id, revision),
      }
    );
    this.credentials = new CredentialCommandOwner({
      store,
      fence,
      assertCurrent: () => this.assertCurrent(),
      select: (profileId, configRevision) => this.target(profileId, configRevision),
      validate: (command) => {
        if (this.claude.has(command.profileId)) {
          if (command.providerId !== 'anthropic' || command.kind !== 'credential.forget')
            throw new ManagementCommandError('invalid');
        } else if (this.profiles.has(command.profileId)) {
          const selected = this.select(command.profileId, command.configRevision);
          if (command.kind === 'credential.refresh' || selected.nativeGeneration === 'v2' &&
              (command.kind !== 'credential.set' || command.metadata && Object.keys(command.metadata).length))
            throw new ManagementCommandError('invalid');
          if (selected.nativeGeneration === 'v2' && command.kind === 'credential.set') {
            const pending = this.credentials.pending({ profileId: command.profileId,
              configRevision: command.configRevision, providerId: command.providerId });
            if (pending && pending.commandId !== command.commandId)
              throw new ManagementCommandError('conflict');
            new OpenCodeV2CredentialScope(selected, command.providerId, () => {
              try { this.assertCurrent(); return true; } catch { return false; }
            }).prepare(command.key, this.replaceableV2Auth(selected, command.providerId));
          }
        } else if (command.providerId !== 'codex' || command.kind === 'credential.set')
          throw new ManagementCommandError('invalid');
      },
      perform: (command, target, progress) => this.performCredential(command, target, progress),
    });
    this.oauth = new OAuthOperationOwner({
      store,
      fence,
      assertWriter: () => this.assertWriter(),
      select: (profileId, configRevision) => this.target(profileId, configRevision),
      prepare: (input) => {
        if (this.claude.has(input.profileId)) return this.claudeAuth.prepare(input);
        if (this.codex.has(input.profileId)) return this.codex.prepareLogin(input);
        const profile = this.select(input.profileId, input.configRevision);
        if (profile.nativeGeneration === 'v2') throw new ManagementCommandError('invalid');
        const timeoutMs = profile.oauthTimeoutMs ?? 17 * 60_000;
        const deadline = Date.now() + timeoutMs;
        let host: OpenCodeManagementHost | undefined;
        return {
          timeoutMs,
          authorize: (fields, signal) =>
            this.withV1Host(profile, { deadline, signal, commandId: input.operationId }, (selected, options) => {
              host = selected;
              return selected.run(
                async (client) => {
                  const methods = (await client.getProviderAuth())[input.providerId];
                  if (!Array.isArray(methods) || methods[input.methodIndex]?.type !== 'oauth')
                    throw new ManagementCommandError('invalid');
                  const value = await client.authorizeProviderOAuth(input.providerId, {
                    method: input.methodIndex,
                    ...(fields ? { inputs: fields } : {}),
                  });
                  return {
                    authorizationUrl: value.url,
                    completionMethod: value.method,
                    instructions: value.instructions,
                  };
                },
                options
              );
            }),
          complete: (code, signal) => {
            if (!host) throw new ManagementCommandError('held');
            return this.withV1Host(profile, { deadline, signal, commandId: input.operationId, originalHost: host }, (selected, options) => selected.run(
              (client) =>
                client.completeProviderOAuth(input.providerId, {
                  method: input.methodIndex,
                  ...(code === undefined ? {} : { code }),
                }),
              options
            ));
          },
          close: () => host ? this.retireHost(profile.profileId, host) : Promise.resolve(true),
        };
      },
      ...(options.onOAuthProgress ? { onProgress: options.onOAuthProgress } : {}),
    });
    this.probes = new ModelProbeOwner({
      store,
      fence,
      assertWriter: () => this.assertWriter(),
      select: (profileId, configRevision) => this.target(profileId, configRevision),
      prepare: (input, isCurrent, purpose, origin) => this.prepareProbe(input, isCurrent, purpose, undefined, origin),
      readinessOriginCurrent: (origin, input, current = () => true) => {
        try { captureOpenCodeReadinessOrigin(origin, this.select(input.profileId, input.configRevision), input.providerId,
          () => { this.assertCurrent(); return current(); }); return true; } catch { return false; }
      },
    });
  }

  private prepareProbe(input: ModelProbeInput, isCurrent: () => boolean,
    purpose?: NativeModelProbePurpose, observeProvider?: (provider: unknown) => boolean,
    origin?: LocalModelReadinessOrigin): NativeModelProbe {
    if (purpose && !this.profiles.has(input.profileId)) throw new ManagementCommandError('invalid');
    if (this.claude.has(input.profileId)) return this.claude.prepareProbe(input, isCurrent);
    if (this.codex.has(input.profileId)) return this.codex.prepareProbe(input, isCurrent);
    const profile = this.select(input.profileId, input.configRevision);
    if (
      input.modelContext !== undefined ||
      (profile.nativeGeneration !== 'v2' && input.effort !== undefined && input.effort !== profile.variant)
    )
      throw new ManagementCommandError('invalid');
    if (purpose === nativeLocalReadinessPurpose) {
      const model = input.modelId.startsWith(input.providerId + '/') ? input.modelId : input.providerId + '/' + input.modelId;
      const limits = profile.nativeGeneration === 'v2' ? undefined
        : input.limits ?? selectedOpenCodeManagedLimits(profile.managedPreferences, model);
      const selected = { ...input, ...(limits ? { limits } : {}) };
      return createOpenCodeLocalModelReadiness(profile, selected, isCurrent, {
        ordinary: (observe, current) => this.prepareProbe(selected, current, undefined, observe),
        coordination: (provider, key, current) => profile.nativeGeneration === 'v2'
          ? createOpenCodeV2ModelProbe(profile, selected, current, {
            ...(this.processCustody ? { processCustody: this.processCustody } : {}),
            coordination: true, readiness: { expectedProvider: provider } })
          : this.prepareCoordination(profile, selected, current, { provider, ...(key === undefined ? {} : { key }) }),
      }, origin);
    }
    if (profile.nativeGeneration === 'v2') {
      const target = this.credentialTarget(profile);
      return createOpenCodeV2ModelProbe(profile, input, () => {
        try {
          this.assertCurrent();
          assertManagementTarget(target, this.credentialTarget(
            this.select(input.profileId, input.configRevision)
          ));
          return isCurrent();
        } catch { return false; }
      }, { ...(this.processCustody ? { processCustody: this.processCustody } : {}),
        ...(purpose ? { coordination: true } : {}), ...(observeProvider ? { readiness: { observeProvider } } : {}) });
    }
    const timeoutMs = profile.modelProbeTimeoutMs ?? 90000;
    let deadline = Date.now() + timeoutMs;
    let host: OpenCodeManagementHost | undefined;
    const qualifiedModel = input.modelId.startsWith(input.providerId + '/')
      ? input.modelId : `${input.providerId}/${input.modelId}`;
    const limits = input.limits ?? selectedOpenCodeManagedLimits(profile.managedPreferences, qualifiedModel);
    if (purpose) {
      const coordination = this.prepareCoordination(profile, { ...input, ...(limits ? { limits } : {}) }, isCurrent);
      if (!coordination) throw new ManagementCommandError('held');
      return coordination;
    }
    if (!limits)
      return {
        timeoutMs,
        run: (signal, originalDeadline) => {
          if (observeProvider) {
            if (originalDeadline === undefined) throw new ManagementCommandError('invalid');
            deadline = originalDeadline;
          }
          return this.withV1Host(profile, { deadline, signal, commandId: input.commandId, isCurrent }, (selected, options) => {
            host = selected;
            return selected.probeModel(
              {
                providerId: input.providerId,
                modelId: input.modelId,
                ...(profile.variant === undefined ? {} : { variant: profile.variant }),
              },
              options.signal,
              options.timeoutMs,
              isCurrent,
              observeProvider ? { deadline, observeProvider } : undefined
            );
          });
        },
        close: () => {
          const work = host ? this.retireHost(profile.profileId, host) : Promise.resolve(true);
          return observeProvider ? closeCoordinationByDeadline(work, deadline) : work;
        },
      };
    // Construction allocates no process. Durable admission must precede native calls.
    const limited = this.createHost(
      withOpenCodeModelLimits(profile, { ...input, limits })
    );
    return {
      timeoutMs,
      run: (signal, originalDeadline) => {
        if (observeProvider) {
          if (originalDeadline === undefined) throw new ManagementCommandError('invalid');
          deadline = originalDeadline;
        }
        return this.withV1Host(profile, { deadline, signal, commandId: input.commandId, isCurrent }, async (selected, options) => {
          host = selected;
          this.replacing.add(profile.profileId);
          const catalog = await selected.run(
            (client) => readOpenCodeCatalog(client, input, input.providerId),
            observeProvider ? { ...options, deadline } : options
          );
          if (!isCurrent()) throw new ManagementCommandError('held');
          const provider = catalog.providers.find((row) => row.providerId === input.providerId);
          const modelId = input.modelId.startsWith(input.providerId + '/')
            ? input.modelId.slice(input.providerId.length + 1)
            : input.modelId;
          if (
            !provider || (input.limits && !provider.configuredAuthless) ||
            !provider.models.some((row) => row.modelId === modelId) ||
            !(await this.retireHost(profile.profileId, selected))
          )
            throw new ManagementCommandError('held');
          options.signal.throwIfAborted();
          this.assertCurrent();
          if (!isCurrent() || Date.now() >= deadline) throw new ManagementCommandError('held');
          this.hosts.set(profile.profileId, limited);
          return limited.probeModel(
            {
              providerId: input.providerId,
              modelId: input.modelId,
              limits,
              ...(profile.variant === undefined ? {} : { variant: profile.variant }),
            },
            options.signal,
            deadline - Date.now(),
            isCurrent,
            observeProvider ? { deadline, observeProvider } : undefined
          );
        });
      },
      close: async () => {
        const closed = await Promise.all([
          host ? this.retireHost(profile.profileId, host) : Promise.resolve(true),
          this.retireHost(profile.profileId, limited),
        ]);
        if (closed.every(Boolean)) this.replacing.delete(profile.profileId);
        return closed.every(Boolean);
      },
    };
  }

  /** Private composition only: ordinary management RPCs cannot request this purpose. */
  startNativeCoordination(input: unknown, isCurrent: () => boolean) {
    this.assertCurrent();
    return this.probes.startNativeCoordination(input, isCurrent);
  }

  startNativeReadiness(input: unknown, isCurrent: () => boolean) {
    this.assertCurrent();
    return this.probes.startNativeReadiness(input, isCurrent);
  }

  private prepareCoordination(profile: OpenCodeManagementProfile, input: ModelProbeInput,
    isCurrent: () => boolean, general?: { provider: Record<string, unknown>; key?: string }): NativeReadinessCoordination | undefined {
    const target = this.credentialTarget(profile);
    const current = () => {
      try {
        this.assertCurrent();
        assertManagementTarget(target, this.credentialTarget(this.select(input.profileId, input.configRevision)));
        return isCurrent();
      } catch { return false; }
    };
    const selected = input.limits ? withOpenCodeModelLimits(profile, { ...input, limits: input.limits }) : profile;
    return createV1CoordinationProbe(selected, input, current, {
      withHost: (operation, action) => this.withV1Host(profile, operation, action),
      create: (derived, coordination) => this.createHost(derived, coordination),
      retire: host => this.retireHost(profile.profileId, host),
      begin: () => { this.replacing.add(profile.profileId); },
      publish: host => { this.hosts.set(profile.profileId, host); },
      release: () => { this.replacing.delete(profile.profileId); },
    }, general);
  }

  private assertCurrent(): void {
    this.assertWriter();
    if (this.sealed) throw new OpenCodeManagementError('unavailable');
  }

  /** Private composition admission, not a management RPC or caller-supplied native profile. */
  admitTeamProbeProfile(raw: ProviderManagementProfile): void {
    this.assertCurrent();
    const profile = providerManagementProfileSchema.parse(raw);
    if (profile.provider === 'claude') this.claude.admitProbeProfile(profile);
    else if (profile.provider === 'codex') this.codex.admitProbeProfile(profile);
    else {
      const previous = this.profiles.get(profile.profileId);
      if (previous && managementDigest(previous) !== managementDigest(profile))
        throw new ManagementCommandError('conflict');
      if (!previous) this.profiles.set(profile.profileId, structuredClone(profile));
    }
    this.unavailableTargets.delete(managementDigest({ profileId: profile.profileId, configRevision: profile.configRevision }));
  }

  /** A newly published base source serves all existing management owners, without replacing old targets. */
  admitRuntimeSourceProfile(raw: ProviderManagementProfile): void {
    const profile = providerManagementProfileSchema.parse(raw);
    this.admitTeamProbeProfile(profile);
    this.skills.admitProfile(profile);
    if (profile.provider === 'claude') {
      this.claudeAuth.admitProfile(profile);
      this.extensions.admitProfile(profile);
    }
  }

  /** A retained unavailable target is a held original intent, never an unknown new profile. */
  assertTargetAvailable(raw: unknown): void {
    const target = z.object({ profileId: z.string(), configRevision: z.string() }).safeParse(raw);
    if (target.success && this.unavailableTargets.has(managementDigest(target.data)))
      throw new ManagementCommandError('held');
  }

  private target(profileId: string, configRevision: string): CredentialTarget {
    this.assertTargetAvailable({ profileId, configRevision });
    return this.claude.has(profileId) ? this.claude.target(profileId, configRevision)
      : this.codex.has(profileId) ? this.codex.target(profileId, configRevision)
        : this.credentialTarget(this.select(profileId, configRevision));
  }

  private select(profileId: string, configRevision: string): OpenCodeManagementProfile {
    this.assertCurrent();
    this.assertTargetAvailable({ profileId, configRevision });
    const profile = this.profiles.get(profileId);
    if (!profile || configRevision !== profile.configRevision)
      throw new OpenCodeManagementError('profile-changed');
    return profile;
  }

  private credentialTarget(profile: OpenCodeManagementProfile): CredentialTarget {
    const directories = Object.fromEntries(
      ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].map((key) => {
        const path = profile.environment[key];
        if (!path || realpathSync(path) !== path)
          throw new OpenCodeManagementError('profile-changed');
        const stat = statSync(path);
        if (!stat.isDirectory()) throw new OpenCodeManagementError('profile-changed');
        return [key, { path, dev: stat.dev, ino: stat.ino }];
      })
    );
    return {
      profileId: profile.profileId,
      configRevision: profile.configRevision,
      selectionDigest: managementDigest({ profile, directories }),
      resourceId: managementDigest(directories.XDG_DATA_HOME),
    };
  }

  private async performCredential(
    command: CredentialCommand,
    target: CredentialTarget,
    progress: CredentialProgressWriter
  ): Promise<{ ok: boolean; settled: boolean; rejected?: boolean }> {
    if (this.claude.has(command.profileId)) return this.claudeAuth.forget(command, target);
    if (!this.profiles.has(command.profileId)) {
      if (command.providerId !== 'codex' || command.kind === 'credential.set')
        throw new ManagementCommandError('invalid');
      return this.codex.mutate(command, target);
    }
    if (command.kind === 'credential.refresh') throw new ManagementCommandError('invalid');
    const profile = this.select(command.profileId, command.configRevision);
    if (profile.nativeGeneration === 'v2') {
      if (command.kind !== 'credential.set') throw new ManagementCommandError('invalid');
      const catalog = this.v2Hosts.get(profile.profileId);
      if (catalog) {
        if (!await catalog.close()) return { ok: false, settled: false };
        if (this.v2Hosts.get(profile.profileId) === catalog) this.v2Hosts.delete(profile.profileId);
      }
      const current = () => {
        try {
          this.assertCurrent();
          assertManagementTarget(target, this.credentialTarget(this.select(command.profileId, command.configRevision)));
          return true;
        } catch { return false; }
      };
      const replaceAuthDigest = this.replaceableV2Auth(profile, command.providerId, command.commandId);
      const operation = createOpenCodeV2CredentialOperation(profile, command, progress, current, {
        ...(this.processCustody ? { processCustody: this.processCustody } : {}),
        ...(replaceAuthDigest ? { replaceAuthDigest } : {}),
      });
      this.v2Keys.set(command.commandId, operation);
      const result = await operation.run();
      if (result.settled && this.v2Keys.get(command.commandId) === operation)
        this.v2Keys.delete(command.commandId);
      return result;
    }
    let host: OpenCodeManagementHost | undefined;
    try {
      const ok = await this.withV1Host(profile, { deadline: Date.now() + profile.timeoutMs, commandId: command.commandId }, (selected, options) => {
        host = selected;
        return selected.run(
          (client) => command.kind === 'credential.set'
            ? client.setProviderAuth(command.providerId, {
                type: 'api',
                key: command.key,
                ...(command.metadata ? { metadata: command.metadata } : {}),
              })
            : client.deleteProviderAuth(command.providerId),
          options
        );
      });
      return { ok: ok === true, settled: true };
    } catch {
      const settled = host ? await this.retireHost(profile.profileId, host) : true;
      return { ok: false, settled };
    }
  }

  pendingCredential(raw: unknown) {
    const input = z.object({ profileId: z.string(), configRevision: z.string(), providerId: z.string() }).strict().parse(raw);
    const generation = this.select(input.profileId, input.configRevision).nativeGeneration ?? 'v1';
    return { generation, receipt: generation === 'v2' ? this.credentials.pending(input) : null };
  }

  private v2CredentialState(profile: OpenCodeManagementProfile, providerId: string, currentCommandId?: string) {
    this.assertCurrent();
    const target = this.credentialTarget(profile);
    let latest: StoredCredentialCommand | undefined, pending = false;
    for (const row of this.store.list()) {
      if (row.kind !== 'credential.set' || row.providerId !== providerId ||
          row.profileId !== target.profileId || row.configRevision !== target.configRevision ||
          row.commandId === currentCommandId) continue;
      assertManagementTarget(row, target);
      pending ||= row.phase !== 'completed' && row.terminalRejection !== true;
      if (row.openCodeV2?.authDigest && row.finishedAtMs !== undefined &&
          (!latest || row.finishedAtMs > latest.finishedAtMs!)) latest = row;
    }
    return { latest, pending };
  }

  /** Private authorization from this owner's rejected publication, never a caller-supplied overwrite flag. */
  private replaceableV2Auth(profile: OpenCodeManagementProfile, providerId: string, currentCommandId?: string): string | undefined {
    this.assertCurrent();
    const target = this.credentialTarget(profile);
    let latest: StoredCredentialCommand | undefined;
    for (const row of this.store.list()) {
      if ((row.kind !== 'credential.set' && row.kind !== 'credential.forget' && row.kind !== 'credential.refresh') ||
          row.providerId !== providerId || row.resourceId !== target.resourceId || row.commandId === currentCommandId) continue;
      const original = this.profiles.get(row.profileId);
      if (!original || original.configRevision !== row.configRevision) throw new ManagementCommandError('held');
      assertManagementTarget(row, this.credentialTarget(original));
      // A source revision cannot turn an unknown original intent into a new Connect, even with the same key.
      if (row.resourceHeld || row.phase !== 'completed' && row.terminalRejection !== true)
        throw new ManagementCommandError('conflict');
      // A confirmed rejection before publication changes neither key nor the previous publication's authority.
      if (row.phase !== 'completed' && !row.openCodeV2?.authDigest) continue;
      if (row.finishedAtMs === undefined) throw new ManagementCommandError('held');
      if (latest?.finishedAtMs === row.finishedAtMs) throw new ManagementCommandError('held');
      if (!latest || row.finishedAtMs > latest.finishedAtMs!) latest = row;
    }
    if (latest?.kind !== 'credential.set' || latest.terminalRejection !== true || latest.resourceHeld ||
        latest.openCodeV2?.phase !== 'probe-completed' || latest.openCodeV2.verification?.ok !== false ||
        this.profiles.get(latest.profileId)?.nativeGeneration !== 'v2') return undefined;
    const auth = new OpenCodeV2CredentialScope(profile, providerId, () => {
      this.assertCurrent(); return true;
    }).capture();
    // The existing digest binds account/provider, both captured roots, auth directories and the selected key.
    return auth.present && auth.digest === latest.openCodeV2.authDigest ? auth.digest : undefined;
  }

  private connectedV2(profile: OpenCodeManagementProfile, providerId: string, authDigest: string): boolean {
    const { latest, pending } = this.v2CredentialState(profile, providerId);
    return !pending && latest?.phase === 'completed' && latest.openCodeV2?.phase === 'probe-completed' &&
      latest.openCodeV2.verification?.ok === true && latest.openCodeV2.authDigest === authDigest;
  }

  private async retireHost(profileId: string, host: OpenCodeManagementHost): Promise<boolean> {
    let clean = false;
    try {
      clean = await host.close();
    } catch {
      /* Unconfirmed writer stays captured and held. */
    }
    if (clean && this.hosts.get(profileId) === host) this.hosts.delete(profileId);
    return clean;
  }

  /** Finish the previous original endpoint operation before any derived V1 owner can replace it. */
  private async withV1Host<T>(
    profile: OpenCodeManagementProfile,
    operation: {
      deadline: number; commandId?: string; signal?: AbortSignal;
      originalHost?: OpenCodeManagementHost; isCurrent?: () => boolean;
    },
    action: (host: OpenCodeManagementHost, options: { signal: AbortSignal; timeoutMs: number }) => Promise<T>
  ): Promise<T> {
    const target = this.credentialTarget(profile);
    const check = () => {
      operation.signal?.throwIfAborted();
      this.assertCurrent();
      assertManagementTarget(target, this.credentialTarget(this.select(profile.profileId, profile.configRevision)));
      if (Date.now() >= operation.deadline || operation.isCurrent?.() === false ||
          operation.originalHost && this.hosts.get(profile.profileId) !== operation.originalHost)
        throw new ManagementCommandError('held');
    };
    check();
    const queue = this.v1EndpointOperations.get(profile.endpoint) ?? { tail: Promise.resolve(), pending: 0 };
    // Native probes return admission before work completes; retain the existing RPC-sized bound here too.
    if (queue.pending >= 32) throw new ManagementCommandError('busy');
    const pending = queue.tail.catch(() => {}).then(async () => {
      check();
      // Read-only callers must not race an active operation's out-of-queue cancellation/close.
      this.fence.assertAvailable(target.resourceId, operation.commandId);
      for (const [profileId, host] of this.hosts) {
        const previous = this.profiles.get(profileId);
        if (profileId === profile.profileId || previous?.endpoint !== profile.endpoint) continue;
        // The occupied host's own namespace matters even if the new profile uses another auth root.
        this.fence.assertAvailable(this.credentialTarget(previous).resourceId, operation.commandId);
        if (!await this.retireHost(profileId, host)) throw new ManagementCommandError('held');
        check();
      }
      this.fence.assertAvailable(target.resourceId, operation.commandId);
      const timeoutMs = operation.deadline - Date.now();
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = operation.signal ? AbortSignal.any([operation.signal, timeout]) : timeout;
      const result = await action(this.getHost(profile), { signal, timeoutMs });
      check();
      return result;
    });
    queue.tail = pending;
    queue.pending++;
    this.v1EndpointOperations.set(profile.endpoint, queue);
    try { return await pending; }
    finally {
      if (--queue.pending === 0 && this.v1EndpointOperations.get(profile.endpoint) === queue)
        this.v1EndpointOperations.delete(profile.endpoint);
    }
  }

  private getHost(profile: OpenCodeManagementProfile): OpenCodeManagementHost {
    this.assertCurrent();
    if (this.replacing.has(profile.profileId)) throw new OpenCodeManagementError('held');
    let host = this.hosts.get(profile.profileId);
    if (!host) {
      host = this.createHost(profile);
      this.hosts.set(profile.profileId, host);
    }
    return host;
  }

  private createHost(profile: OpenCodeManagementProfile,
    coordination?: OpenCodeV1Coordination): OpenCodeManagementHost {
    const isCurrent = () => {
      if (this.sealed) return false;
      try {
        this.assertWriter();
        return true;
      } catch {
        return false;
      }
    };
    return new OpenCodeManagementHost(profile, {
      isCurrent,
      canAllocate: isCurrent,
    }, coordination ? { coordination } : {});
  }

  async catalog(raw: unknown): Promise<ProviderManagementCatalog> {
    const input = z
      .object({
        profileId: z.string().min(1).max(256),
        configRevision: z.string().min(1).max(256),
        providerId: z.string().min(1).max(256).optional(),
        includeModels: z.boolean().optional(),
      })
      .strict()
      .parse(raw);
    const profile = this.select(input.profileId, input.configRevision);
    if (profile.nativeGeneration === 'v2') {
      const deadline = Date.now() + profile.timeoutMs;
      const target = this.credentialTarget(profile);
      // Status, directory and provider reads share this original metadata owner.
      // Complete the whole previous read before another mode can close its child.
      const previous = this.v2CatalogReads.get(profile.profileId) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(async () => {
        const current = this.select(input.profileId, input.configRevision);
        assertManagementTarget(target, this.credentialTarget(current));
        if (Date.now() >= deadline) throw new OpenCodeManagementError('held');
        return this.readV2Catalog(current, input, deadline);
      });
      this.v2CatalogReads.set(profile.profileId, pending);
      try { return await pending; }
      finally {
        if (this.v2CatalogReads.get(profile.profileId) === pending)
          this.v2CatalogReads.delete(profile.profileId);
      }
    }
    const result = await this.withV1Host(profile, { deadline: Date.now() + profile.timeoutMs }, (host, options) => host.run(
      (client) => readOpenCodeCatalog(
          client,
          { profileId: input.profileId, configRevision: input.configRevision },
          input.providerId,
          input.includeModels
        ),
      options
    ));
    this.assertWriter();
    if (this.sealed) throw new OpenCodeManagementError('unavailable');
    return { ...result, runtime: { generation: 'v1' } };
  }

  private async readV2Catalog(
    profile: OpenCodeManagementProfile,
    input: { profileId: string; configRevision: string; providerId?: string | undefined; includeModels?: boolean | undefined },
    deadline: number
  ): Promise<ProviderManagementCatalog> {
    if (this.replacing.has(profile.profileId)) throw new OpenCodeManagementError('held');
    const target = this.credentialTarget(profile);
    const selectedProvider = input.providerId ?? (input.includeModels ? profile.nativeModel?.providerId : undefined);
    let host = this.v2Hosts.get(profile.profileId);
    if (host && !host.matchesCatalog(selectedProvider)) {
      this.replacing.add(profile.profileId);
      const clean = await host.close().catch(() => false);
      if (!clean) throw new OpenCodeManagementError('held');
      if (this.v2Hosts.get(profile.profileId) === host) this.v2Hosts.delete(profile.profileId);
      this.replacing.delete(profile.profileId);
      host = undefined;
    }
    if (!host) {
      assertManagementTarget(target, this.credentialTarget(this.select(input.profileId, input.configRevision)));
      if (Date.now() >= deadline) throw new OpenCodeManagementError('held');
      host = new OpenCodeV2ManagementHost(profile, () => {
        try {
          this.assertCurrent();
          assertManagementTarget(target, this.credentialTarget(this.select(input.profileId, input.configRevision)));
          return true;
        } catch { return false; }
      }, this.processCustody, {
        ...(selectedProvider ? { catalogProviderId: selectedProvider } : {}),
        connected: (providerId, authDigest) => this.connectedV2(profile, providerId, authDigest),
      });
      this.v2Hosts.set(profile.profileId, host);
    }
    try {
      const result = await host.catalog(input.providerId, input.includeModels, deadline);
      this.assertCurrent();
      return result;
    } catch (error) {
      // Failed catalog reads seal their original child. Retire that exact
      // owner only after cleanup; an unknown child keeps the profile held.
      const clean = await host.close().catch(() => false);
      if (clean && this.v2Hosts.get(profile.profileId) === host)
        this.v2Hosts.delete(profile.profileId);
      throw error;
    }
  }

  seal(): void {
    this.sealed = true;
    this.oauth.seal();
    this.codex.seal();
    this.claude.seal();
    this.claudeAuth.seal();
    this.extensions.seal();
    this.probes.seal();
    for (const host of this.hosts.values()) void host.close().catch(() => {});
    for (const host of this.v2Hosts.values()) void host.close().catch(() => {});
    for (const operation of this.v2Keys.values()) void operation.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.seal();
    const results = await Promise.allSettled([
      this.oauth.close().then(() => true),
      this.codex.close().then(() => true),
      this.claude.close().then(() => true),
      this.claudeAuth.close().then(() => true),
      this.extensions.close().then(() => true),
      this.probes.close().then(() => true),
      ...[...this.hosts.values()].map((host) => host.close()),
      ...[...this.v2Hosts.values()].map((host) => host.close()),
      ...[...this.v2Keys.values()].map((operation) => operation.close()),
    ]);
    if (results.some((result) => result.status === 'rejected' || result.value !== true) ||
        [...this.store.list()].some(row => row.resourceHeld))
      throw new OpenCodeManagementError('held');
  }
}
