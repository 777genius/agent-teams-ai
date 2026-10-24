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
import { readOpenCodeCatalog } from '../adapters/providers/readOpenCodeCatalog.js';
import { FileManagementCommandStore } from '../adapters/providers/FileManagementCommandStore.js';
import { CredentialCommandOwner } from '../management/CredentialCommandOwner.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import { ManagementResourceFence } from '../management/ManagementResourceFence.js';
import { OAuthOperationOwner } from '../management/OAuthOperationOwner.js';
import { ModelProbeOwner } from '../management/ModelProbeOwner.js';

import type { ProviderManagementCatalog, ProviderOAuthSnapshot } from '../management/contracts.js';
import type {
  OpenCodeManagementProfile,
  ProviderManagementProfile,
} from '../management/profile.js';
import { providerManagementProfileSchema } from '../management/profile.js';
import type { CredentialCommand, CredentialTarget } from '../management/CredentialCommandOwner.js';

/** The captured Host owns management process custody; Team policy and Session SPI stay separate. */
export class ProviderManagementCoordinator {
  private readonly profiles = new Map<string, OpenCodeManagementProfile>();
  private readonly hosts = new Map<string, OpenCodeManagementHost>();
  private sealed = false;
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
    options: { onOAuthProgress?(snapshot: ProviderOAuthSnapshot): void } = {}
  ) {
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
    const store = new FileManagementCommandStore(storageRoot);
    const fence = new ManagementResourceFence(store.list());
    this.skills = new SkillCoordinator(profiles, {
      store, fence, assertCurrent: () => this.assertCurrent(),
      managementTarget: (id, revision) => this.claude.has(id)
        ? this.claude.target(id, revision)
        : this.codex.has(id) ? this.codex.target(id, revision)
          : this.credentialTarget(this.select(id, revision)),
    });
    this.extensions = new NativeExtensionCoordinator(
      profiles.filter((profile) => profile.provider === 'claude'),
      {
        store,
        fence,
        assertCurrent: () => this.assertCurrent(),
        managementTarget: (id, revision) => this.claude.target(id, revision),
      }
    );
    this.credentials = new CredentialCommandOwner({
      store,
      fence,
      assertCurrent: () => this.assertCurrent(),
      select: (profileId, configRevision) =>
        this.claude.has(profileId)
          ? this.claude.target(profileId, configRevision)
          : this.profiles.has(profileId)
            ? this.credentialTarget(this.select(profileId, configRevision))
            : this.codex.target(profileId, configRevision),
      validate: (command) => {
        if (this.claude.has(command.profileId)) {
          if (command.providerId !== 'anthropic' || command.kind !== 'credential.forget')
            throw new ManagementCommandError('invalid');
        } else if (this.profiles.has(command.profileId)) {
          if (command.kind === 'credential.refresh') throw new ManagementCommandError('invalid');
        } else if (command.providerId !== 'codex' || command.kind === 'credential.set')
          throw new ManagementCommandError('invalid');
      },
      perform: (command, target) => this.performCredential(command, target),
    });
    this.oauth = new OAuthOperationOwner({
      store,
      fence,
      assertWriter: () => this.assertWriter(),
      select: (profileId, configRevision) =>
        this.claude.has(profileId)
          ? this.claude.target(profileId, configRevision)
          : this.credentialTarget(this.select(profileId, configRevision)),
      prepare: (input) => {
        if (this.claude.has(input.profileId)) return this.claudeAuth.prepare(input);
        const profile = this.select(input.profileId, input.configRevision);
        const host = this.getHost(profile);
        const timeoutMs = profile.oauthTimeoutMs ?? 17 * 60_000;
        return {
          timeoutMs,
          authorize: (fields, signal) =>
            host.run(
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
              { signal, timeoutMs }
            ),
          complete: (code, signal) =>
            host.run(
              (client) =>
                client.completeProviderOAuth(input.providerId, {
                  method: input.methodIndex,
                  ...(code === undefined ? {} : { code }),
                }),
              { signal, timeoutMs }
            ),
          close: () => this.retireHost(profile.profileId, host),
        };
      },
      ...(options.onOAuthProgress ? { onProgress: options.onOAuthProgress } : {}),
    });
    this.probes = new ModelProbeOwner({
      store,
      fence,
      assertWriter: () => this.assertWriter(),
      select: (profileId, configRevision) =>
        this.claude.has(profileId)
          ? this.claude.target(profileId, configRevision)
          : this.codex.has(profileId)
            ? this.codex.target(profileId, configRevision)
            : this.credentialTarget(this.select(profileId, configRevision)),
      prepare: (input, isCurrent) => {
        if (this.claude.has(input.profileId)) return this.claude.prepareProbe(input, isCurrent);
        if (this.codex.has(input.profileId)) return this.codex.prepareProbe(input, isCurrent);
        const profile = this.select(input.profileId, input.configRevision);
        if (
          input.modelContext !== undefined ||
          (input.effort !== undefined && input.effort !== profile.variant)
        )
          throw new ManagementCommandError('invalid');
        const host = this.getHost(profile);
        const timeoutMs = profile.modelProbeTimeoutMs ?? 90000;
        if (!input.limits)
          return {
            timeoutMs,
            run: (signal) =>
              host.probeModel(
                {
                  providerId: input.providerId,
                  modelId: input.modelId,
                  ...(profile.variant === undefined ? {} : { variant: profile.variant }),
                },
                signal,
                timeoutMs,
                isCurrent
              ),
            close: () => this.retireHost(profile.profileId, host),
          };
        // Construction allocates no process. Durable admission must precede native calls.
        const limited = this.createHost(
          withOpenCodeModelLimits(profile, { ...input, limits: input.limits })
        );
        return {
          timeoutMs,
          run: async (signal) => {
            this.replacing.add(profile.profileId);
            const catalog = await host.run(
              (client) => readOpenCodeCatalog(client, input, input.providerId),
              { signal, timeoutMs }
            );
            if (!isCurrent()) throw new ManagementCommandError('held');
            const provider = catalog.providers.find((row) => row.providerId === input.providerId);
            const modelId = input.modelId.startsWith(input.providerId + '/')
              ? input.modelId.slice(input.providerId.length + 1)
              : input.modelId;
            if (
              !provider?.configuredAuthless ||
              !provider.models.some((row) => row.modelId === modelId) ||
              !(await this.retireHost(profile.profileId, host))
            )
              throw new ManagementCommandError('held');
            signal.throwIfAborted();
            this.assertCurrent();
            this.hosts.set(profile.profileId, limited);
            return limited.probeModel(
              {
                providerId: input.providerId,
                modelId: input.modelId,
                limits: input.limits!,
                ...(profile.variant === undefined ? {} : { variant: profile.variant }),
              },
              signal,
              timeoutMs,
              isCurrent
            );
          },
          close: async () => {
            const closed = await Promise.all([
              this.retireHost(profile.profileId, host),
              this.retireHost(profile.profileId, limited),
            ]);
            if (closed.every(Boolean)) this.replacing.delete(profile.profileId);
            return closed.every(Boolean);
          },
        };
      },
    });
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
  }

  private select(profileId: string, configRevision: string): OpenCodeManagementProfile {
    this.assertCurrent();
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
    target: CredentialTarget
  ): Promise<{ ok: boolean; settled: boolean }> {
    if (this.claude.has(command.profileId)) return this.claudeAuth.forget(command, target);
    if (!this.profiles.has(command.profileId)) {
      if (command.providerId !== 'codex' || command.kind === 'credential.set')
        throw new ManagementCommandError('invalid');
      return this.codex.mutate(command, target);
    }
    if (command.kind === 'credential.refresh') throw new ManagementCommandError('invalid');
    const profile = this.select(command.profileId, command.configRevision);
    const host = this.getHost(profile);
    try {
      const ok = await host.run((client) =>
        command.kind === 'credential.set'
          ? client.setProviderAuth(command.providerId, {
              type: 'api',
              key: command.key,
              ...(command.metadata ? { metadata: command.metadata } : {}),
            })
          : client.deleteProviderAuth(command.providerId)
      );
      return { ok: ok === true, settled: true };
    } catch {
      const settled = await this.retireHost(profile.profileId, host);
      return { ok: false, settled };
    }
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

  private createHost(profile: OpenCodeManagementProfile): OpenCodeManagementHost {
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
    });
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
    const host = this.getHost(profile);
    const result = await host.run((client) =>
      readOpenCodeCatalog(
        client,
        {
          profileId: input.profileId,
          configRevision: input.configRevision,
        },
        input.providerId,
        input.includeModels
      )
    );
    this.assertWriter();
    if (this.sealed) throw new OpenCodeManagementError('unavailable');
    return result;
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
    ]);
    if (results.some((result) => result.status === 'rejected' || result.value !== true))
      throw new OpenCodeManagementError('held');
  }
}
