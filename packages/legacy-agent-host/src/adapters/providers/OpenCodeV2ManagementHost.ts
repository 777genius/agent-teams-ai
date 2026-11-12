import { lstatSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createOpenCodeV2OwnedSessionClient } from '@agent-teams/provider-implementations/opencode';

import { hasUntrustedOpenCodeBinaryOverride } from '../../composition/openCodeV2Environment.js';
import { managementDigest } from '../../management/identity.js';
import { openCodeManagementProfileSchema } from '../../management/profile.js';
import { OpenCodeManagementError } from './OpenCodeManagementHost.js';
import { openCodeV2NoToolConfig } from './OpenCodeV2EmbeddedConfig.js';
import { createOpenCodeV2EmbeddedServer } from './OpenCodeV2EmbeddedServer.js';
import { isConfiguredAuthless } from './openCodeConfiguredAuthless.js';

import type { ProviderManagementCatalog } from '../../management/contracts.js';
import type { OpenCodeManagementProfile } from '../../management/profile.js';
import type { RegisteredProcessRootSource } from '../../process/registeredProcessContracts.js';

const held = (): never => { throw new OpenCodeManagementError('held'); };
type Identity = { dev: number; ino: number };

/** One captured, read-only metadata child. Catalog reads never create a session or submit a prompt. */
export class OpenCodeV2ManagementHost {
  private readonly profile: OpenCodeManagementProfile;
  private readonly directories = new Map<string, Identity>();
  private readonly namespaces = new Map<string, Identity>();
  private readonly abort = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private sealed = false;
  private cleanupUnknown = false;
  private starting?: Promise<void>;
  private closing?: Promise<boolean>;
  private server?: ReturnType<typeof createOpenCodeV2EmbeddedServer>;
  private ready?: Awaited<ReturnType<NonNullable<OpenCodeV2ManagementHost['server']>['start']>>;

  constructor(
    raw: OpenCodeManagementProfile,
    private readonly isCurrent: () => boolean,
    private readonly processCustody?: RegisteredProcessRootSource,
  ) {
    const selected = openCodeManagementProfileSchema.safeParse(raw);
    if (!selected.success || selected.data.nativeGeneration !== 'v2' ||
        selected.data.protocolRevision !== '2.1.4' || !selected.data.embedded || !selected.data.nativeModel ||
        hasUntrustedOpenCodeBinaryOverride(selected.data.environment))
      throw new OpenCodeManagementError('invalid-profile');
    this.profile = structuredClone(selected.data);
    try {
      for (const directory of [this.profile.cwd, ...['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
        .map(key => this.profile.environment[key])]) {
        if (!directory) return held();
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) return held();
        this.directories.set(directory, { dev: stat.dev, ino: stat.ino });
      }
    } catch { held(); }
  }

  private current(): boolean {
    if (this.sealed || this.abort.signal.aborted || hasUntrustedOpenCodeBinaryOverride(process.env)) return false;
    try {
      if (!this.isCurrent()) return false;
      for (const [directory, identity] of this.directories) {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory ||
            stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
      }
      return true;
    } catch { return false; }
  }

  private assertCurrent(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!this.current()) held();
  }

  private async namespace(root: string): Promise<string> {
    const directory = await mkdtemp(join(root, 'agent-teams-v2-catalog-'));
    const stat = lstatSync(directory);
    this.namespaces.set(directory, { dev: stat.dev, ino: stat.ino });
    return directory;
  }

  private async start(signal: AbortSignal): Promise<void> {
    this.assertCurrent(signal);
    const data = await this.namespace(this.profile.environment.XDG_DATA_HOME!);
    this.assertCurrent(signal);
    const configuration = await this.namespace(this.profile.environment.XDG_CONFIG_HOME!);
    this.assertCurrent(signal);
    this.server = createOpenCodeV2EmbeddedServer({
      profile: this.profile,
      embedded: this.profile.embedded!,
      databasePath: join(data, 'catalog.sqlite'),
      configDirectory: configuration,
      config: openCodeV2NoToolConfig(this.profile).config,
      canAllocate: () => this.current(),
      startupTimeoutMs: Math.min(this.profile.timeoutMs, 180_000),
      ...(this.processCustody ? { processCustody: this.processCustody } : {}),
    });
    this.ready = await this.server.start(signal);
    this.assertCurrent(signal);
  }

  private async read(providerId: string | undefined, includeModels: boolean): Promise<ProviderManagementCatalog> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.profile.timeoutMs)]);
    const deadline = Date.now() + this.profile.timeoutMs;
    this.assertCurrent(signal);
    await (this.starting ??= this.start(signal));
    this.assertCurrent(signal);
    if (!this.ready || !this.server) return held();
    const ready = this.ready, server = this.server, selected = this.profile.nativeModel!;
    const client = createOpenCodeV2OwnedSessionClient({
      endpoint: ready.endpoint,
      directory: this.profile.cwd,
      // The owner client requires a bound identifier; metadata never creates this session.
      nativeSessionId: 'ses_' + managementDigest(this.profile).slice(0, 40),
      version: '2.1.4', signal, deadline,
      beforeRequest: async requestSignal => {
        this.assertCurrent(requestSignal);
        const actual = await server.readNativeCustody(requestSignal);
        this.assertCurrent(requestSignal);
        if (!actual || actual.pid !== ready.pid || actual.startIdentity !== ready.startIdentity ||
            actual.executableSha256 !== this.profile.executable.sha256 || actual.version !== '2.1.4') held();
      },
      readPassword: () => { this.assertCurrent(signal); return server.readPassword(); },
    });
    let result: ProviderManagementCatalog | undefined, failure: unknown, failed = false;
    try {
      if ((await client.identity()).pid !== ready.pid || !(await client.builtinPluginsOnly()) ||
          !(await client.savedPermissionsEmpty()) || (await client.readMcp()).length !== 0) held();
      // The native model list is a startup snapshot; wait within this same finite
      // request for plugin activation, without creating a conversation to warm it.
      let catalog = await client.readCatalog(selected.providerId);
      while ((!catalog.provider || !catalog.defaultModel ||
        !catalog.models.some(model => model.id === selected.modelId)) && !signal.aborted) {
        await delay(50, undefined, { signal });
        catalog = await client.readCatalog(selected.providerId);
      }
      this.assertCurrent(signal);
      if (!catalog.provider || catalog.defaultModel?.providerId !== selected.providerId ||
          catalog.defaultModel.modelId !== selected.modelId) return held();
      const models = catalog.models.filter(model => model.enabled);
      const requested = providerId === undefined || providerId === selected.providerId;
      const configuration = this.profile.embedded?.providerConfiguration;
      // Reuse the existing explicit local-route policy, adapting only the native
      // V2 field names. This metadata forces an actual probe in existing consumers.
      const configuredAuthless = !!configuration && isConfiguredAuthless({
        id: selected.providerId,
        npm: ['aisdk:@ai-sdk/openai-compatible', '@opencode/ai/providers/openai-compatible']
          .includes(String(configuration.package)) ? '@ai-sdk/openai-compatible' : undefined,
        options: configuration.settings,
      });
      result = {
        profileId: this.profile.profileId, configRevision: this.profile.configRevision,
        configuredDefaultModelId: selected.providerId + '/' + selected.modelId,
        providers: !requested ? [] : [{
          providerId: selected.providerId, displayName: catalog.provider.name,
          source: this.profile.embedded?.providerConfiguration ? 'config' : null,
          // Native activation is inventory only. Existing consumers interpret
          // connected as credentialed, so only the explicit probe can qualify access.
          connected: false,
          configured: this.profile.embedded?.providerConfiguration !== undefined,
          configuredAuthless,
          defaultModelId: catalog.defaultModel.modelId, modelCount: models.length,
          models: providerId === undefined && !includeModels ? [] : models.map(model => ({
            modelId: model.id, displayName: model.name, contextTokens: model.contextTokens,
            outputTokens: model.outputTokens, free: null, declaredInputModalities: model.inputModalities,
          })),
          // Vendor auth/OAuth has not been qualified by this metadata path.
          authMethods: [], ...(providerId === undefined ? {} : { authOptions: [] }),
        }],
      };
    } catch (error) { failed = true; failure = error; }
    try { await client.dispose(); }
    catch (error) { this.cleanupUnknown = true; if (!failed) { failed = true; failure = error; } }
    if (failed) throw failure;
    this.assertCurrent(signal);
    return result!;
  }

  async catalog(providerId?: string, includeModels = false): Promise<ProviderManagementCatalog> {
    const settled = Promise.withResolvers<void>();
    this.pending.add(settled.promise);
    let result: ProviderManagementCatalog | undefined, failure: unknown, failed = false;
    try { result = await this.read(providerId, includeModels); }
    catch (error) { failed = true; failure = error; }
    finally { this.pending.delete(settled.promise); settled.resolve(); }
    if (failed) {
      await this.close();
      throw failure;
    }
    return result!;
  }

  close(): Promise<boolean> {
    this.sealed = true;
    return (this.closing ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let clean = false;
      try {
        clean = await Promise.race([
          // Seal blocks new credentials. Drain finite custody acquisitions before
          // aborting their wire so an ordinary Quit does not manufacture UNKNOWN.
          Promise.all([...this.pending, this.starting?.catch(() => {})]).then(() => true),
          new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000); }),
        ]);
      } finally { clearTimeout(timer); }
      this.abort.abort();
      await this.starting?.catch(() => {});
      clean = clean && !this.cleanupUnknown;
      try { if (this.server) clean = (await this.server.stopOwned()) && clean; }
      catch { clean = false; }
      if (!clean) return false;
      try {
        for (const [directory, identity] of this.namespaces) {
          const stat = lstatSync(directory);
          if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory ||
              stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
          await rm(directory, { recursive: true, force: true });
        }
        return true;
      } catch { return false; }
    })());
  }
}
