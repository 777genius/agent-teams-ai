import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createOpenCodeV2OwnedSessionClient, createOpenCodeV2CredentialClient } from '@agent-teams/provider-implementations/opencode';

import { hasUntrustedOpenCodeBinaryOverride } from '../../composition/openCodeV2Environment.js';
import { managementDigest } from '../../management/identity.js';
import { openCodeManagementProfileSchema } from '../../management/profile.js';
import { OpenCodeManagementError } from './OpenCodeManagementHost.js';
import { openCodeV2NoToolConfig } from './OpenCodeV2EmbeddedConfig.js';
import { createOpenCodeV2EmbeddedServer } from './OpenCodeV2EmbeddedServer.js';
import { isConfiguredAuthless } from './openCodeConfiguredAuthless.js';
import { captureOpenCodeV2SessionCredential } from './OpenCodeV2SessionCredential.js';
import { OpenCodeV2CredentialScope } from './OpenCodeV2CredentialScope.js';
import { captureOpenCodeV2Configuration } from './OpenCodeV2CapturedConfiguration.js';
import { createOpenCodeMetadataDiagnostic } from './createClaudeCloseDiagnostic.js';

import type { ProviderManagementCatalog } from '../../management/contracts.js';
import type { OpenCodeManagementProfile } from '../../management/profile.js';
import type { RegisteredProcessRootSource } from '../../process/registeredProcessContracts.js';

const held = (): never => { throw new OpenCodeManagementError('held'); };
type Identity = { dev: bigint; ino: bigint };
type NativeClient = ReturnType<typeof createOpenCodeV2OwnedSessionClient>;
type KeyClient = ReturnType<typeof createOpenCodeV2CredentialClient>;
export interface OpenCodeV2KeyOperation {
  readonly integrationId: string;
  read: KeyClient['read'];
  connectKey: KeyClient['connectKey'];
  rollbackOwnedKey: KeyClient['rollbackOwnedKey'];
  readCatalog(): ReturnType<NativeClient['readCatalog']>;
}
export function openCodeV2KeyNamespace(profile: OpenCodeManagementProfile, commandId: string): string {
  if (typeof commandId !== 'string' || !commandId || commandId.length > 256 || /[\0\r\n]/u.test(commandId)) return held();
  return managementDigest({ profile, commandId });
}

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
  private readonly catalogCredential?: ReturnType<typeof captureOpenCodeV2SessionCredential>;
  private readonly configuration: ReturnType<typeof captureOpenCodeV2Configuration>;
  private readonly configuredProviderId: string;
  private readonly metadataDiagnostic?: ReturnType<typeof createOpenCodeMetadataDiagnostic>;

  constructor(
    raw: OpenCodeManagementProfile,
    private readonly isCurrent: () => boolean,
    private readonly processCustody?: RegisteredProcessRootSource,
    private readonly options: {
      retainedCommandId?: string;
      catalogProviderId?: string;
      configurationProviderId?: string;
      connected?(providerId: string, authDigest: string): boolean;
    } = {},
  ) {
    const selected = openCodeManagementProfileSchema.safeParse(raw);
    if (!selected.success || selected.data.nativeGeneration !== 'v2' ||
        selected.data.protocolRevision !== '2.1.4' || !selected.data.embedded || !selected.data.nativeModel ||
        hasUntrustedOpenCodeBinaryOverride(selected.data.environment))
      throw new OpenCodeManagementError('invalid-profile');
    this.profile = structuredClone(selected.data);
    this.options = Object.freeze({ ...options });
    if (!this.options.retainedCommandId)
      this.metadataDiagnostic = createOpenCodeMetadataDiagnostic(this.profile, this.options.catalogProviderId);
    try {
      for (const directory of [this.profile.cwd, ...['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
        .map(key => this.profile.environment[key])]) {
        if (!directory) throw new OpenCodeManagementError('held');
        const stat = lstatSync(directory, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory)
          throw new OpenCodeManagementError('held');
        this.directories.set(directory, { dev: stat.dev, ino: stat.ino });
      }
    } catch { held(); }
    this.configuredProviderId = this.options.configurationProviderId ??
      this.options.catalogProviderId ?? this.profile.nativeModel!.providerId;
    this.configuration = captureOpenCodeV2Configuration(this.profile,
      { providerId: this.configuredProviderId, modelId: this.profile.nativeModel!.modelId },
      () => this.selectionCurrent(), 'catalog');
    if (this.options.catalogProviderId) this.catalogCredential = captureOpenCodeV2SessionCredential(
      this.profile, this.options.catalogProviderId, this.configuration.isCurrent);
  }

  private selectionCurrent(): boolean {
    if (this.sealed || this.abort.signal.aborted || hasUntrustedOpenCodeBinaryOverride(process.env)) return false;
    try {
      if (!this.isCurrent()) return false;
      for (const [directory, identity] of this.directories) {
        const stat = lstatSync(directory, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory ||
            stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
      }
      return true;
    } catch { return false; }
  }

  private current(): boolean {
    return this.catalogCredential?.isCurrent() ?? this.configuration.isCurrent();
  }

  matchesCatalog(providerId: string | undefined): boolean {
    return !this.options.retainedCommandId && this.options.catalogProviderId === providerId;
  }

  private assertCurrent(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!this.current()) held();
  }

  private async namespace(root: string): Promise<string> {
    const directory = this.options.retainedCommandId
      ? join(root, 'agent-teams-v2-key-' + openCodeV2KeyNamespace(this.profile, this.options.retainedCommandId))
      : await mkdtemp(join(root, 'agent-teams-v2-catalog-'));
    // A new command never adopts an uncertain previous database or retries its native POST.
    if (this.options.retainedCommandId) await mkdir(directory, { mode: 0o700 });
    const stat = lstatSync(directory, { bigint: true });
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
      config: openCodeV2NoToolConfig(this.profile, this.configuration.configuration, this.configuredProviderId).config,
      canAllocate: () => this.current(),
      startupTimeoutMs: Math.min(this.profile.timeoutMs, 180_000),
      ...(this.processCustody ? { processCustody: this.processCustody } : {}),
    });
    this.ready = await this.server.start(signal);
    this.metadataDiagnostic?.ready(this.ready);
    this.assertCurrent(signal);
  }

  private async nativeClient(signal: AbortSignal, deadline: number) {
    this.assertCurrent(signal);
    await (this.starting ??= this.start(signal));
    this.assertCurrent(signal);
    if (!this.ready || !this.server) return held();
    const ready = this.ready, server = this.server;
    const config = {
      endpoint: ready.endpoint,
      directory: this.profile.cwd,
      version: '2.1.4' as const, signal, deadline,
      beforeRequest: async (requestSignal: AbortSignal) => {
        this.assertCurrent(requestSignal);
        const actual = await server.readNativeCustody(requestSignal);
        this.assertCurrent(requestSignal);
        if (!actual || actual.pid !== ready.pid || actual.startIdentity !== ready.startIdentity ||
            actual.executableSha256 !== this.profile.executable.sha256 || actual.version !== '2.1.4') held();
      },
      readPassword: () => { this.assertCurrent(signal); return server.readPassword(); },
    };
    return { ready, config, client: createOpenCodeV2OwnedSessionClient({
      ...config,
      // Read-only owner APIs use a bound identifier; this path never creates that session.
      nativeSessionId: 'ses_' + managementDigest(this.profile).slice(0, 40),
    }) };
  }

  private async read(providerId: string | undefined, includeModels: boolean, deadline: number): Promise<ProviderManagementCatalog> {
    const remaining = Math.min(this.profile.timeoutMs, deadline - Date.now());
    if (!Number.isSafeInteger(remaining) || remaining <= 0) return held();
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(remaining)]);
    const { client, config, ready } = await this.nativeClient(signal, deadline);
    const selected = this.profile.nativeModel!;
    let result: ProviderManagementCatalog | undefined, failure: unknown, failed = false;
    try {
      const identity = await client.identity();
      if (identity.pid !== ready.pid || identity.version !== '2.1.4' || !(await client.builtinPluginsOnly()) ||
          !(await client.savedPermissionsEmpty()) || (await client.readMcp()).length !== 0) held();
      await this.catalogCredential?.prepare(config, client);
      let catalog = await client.readDirectory();
      // Await metadata activation inside the original deadline; never warm it with a prompt.
      while (!catalog.providers.length && !catalog.integrations.length && !signal.aborted) {
        await delay(50, undefined, { signal });
        catalog = await client.readDirectory();
      }
      this.assertCurrent(signal);
      const providers = new Map(catalog.providers.map(row => [row.id, row]));
      const integrations = new Map(catalog.integrations.map(row => [row.id, row]));
      const ids = new Set([...providers.keys(), ...integrations.keys()]);
      const sources = new Set(new OpenCodeV2CredentialScope(this.profile, selected.providerId,
        () => this.current()).providerIds());
      result = {
        profileId: this.profile.profileId, configRevision: this.profile.configRevision,
        runtime: { generation: 'v2', version: identity.version },
        configuredDefaultModelId: catalog.defaultModel
          ? catalog.defaultModel.providerId + '/' + catalog.defaultModel.modelId : null,
        providers: [...ids].filter(id => (providerId === undefined || providerId === id) &&
          !['kimi-for-coding', 'kiro', 'cursor-acp'].includes(id) &&
          (!['exa', 'tavily'].includes(id) || providers.get(id)?.integrationId)).map(id => {
          const provider = providers.get(id);
          const integration = integrations.get(provider ? provider.integrationId ?? '' : id);
          const models = catalog.models.filter(model => model.providerId === id && model.enabled);
          const configuration = id === this.configuredProviderId ? this.configuration.configuration : undefined;
          const configuredAuthless = !!configuration && isConfiguredAuthless({ id,
            npm: ['aisdk:@ai-sdk/openai-compatible', '@opencode/ai/providers/openai-compatible']
              .includes(String(configuration.package)) ? '@ai-sdk/openai-compatible' : undefined,
            options: configuration.settings,
          });
          const source = sources.has(id) ? new OpenCodeV2CredentialScope(this.profile, id,
            () => this.current()).capture() : undefined;
          return {
            providerId: id, displayName: integration?.name ?? provider?.name ?? id,
            source: source ? 'api' as const : configuration ? 'config' as const : null,
            // Passive directory does not import keys or infer authentication from inventory.
            connected: !!source && this.options.connected?.(id, source.digest) === true,
            configured: source !== undefined || configuration !== undefined, configuredAuthless,
            defaultModelId: catalog.defaultModel?.providerId === id ? catalog.defaultModel.modelId : null,
            modelCount: models.length,
            models: providerId === undefined && !includeModels ? [] : models.map(model => ({
              modelId: model.id, displayName: model.name, contextTokens: model.contextTokens,
              outputTokens: model.outputTokens, free: null, declaredInputModalities: model.inputModalities,
              variants: model.variants,
            })),
            authMethods: integration?.plainKey ? ['api' as const] : [],
          };
        }),
      };
    } catch (error) { failed = true; failure = error; }
    for (const wire of [client]) {
      try { await wire?.dispose(); }
      catch (error) { this.cleanupUnknown = true; if (!failed) { failed = true; failure = error; } }
    }
    if (failed) throw failure;
    this.assertCurrent(signal);
    return result!;
  }

  private async tracked<T>(operation: () => Promise<T>): Promise<T> {
    const settled = Promise.withResolvers<void>();
    this.pending.add(settled.promise);
    let result: T | undefined, failure: unknown, failed = false;
    try { result = await operation(); }
    catch (error) { failed = true; failure = error; }
    finally { this.pending.delete(settled.promise); settled.resolve(); }
    if (failed) {
      await this.close();
      throw failure;
    }
    return result!;
  }

  catalog(providerId?: string, includeModels = false, deadline = Date.now() + this.profile.timeoutMs): Promise<ProviderManagementCatalog> {
    return this.tracked(() => this.read(providerId, includeModels, deadline));
  }

  /** One retained native credential database under the existing durable command/fence. */
  keyOperation<T>(providerId: string, operation: (native: OpenCodeV2KeyOperation) => Promise<T>): Promise<T> {
    if (!this.options.retainedCommandId) return Promise.reject(new OpenCodeManagementError('invalid-profile'));
    return this.tracked(async () => {
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.profile.timeoutMs)]);
      const { client, config, ready } = await this.nativeClient(signal, Date.now() + this.profile.timeoutMs);
      let key: KeyClient | undefined, result: T | undefined, failure: unknown, failed = false;
      try {
        const identity = await client.identity();
        if (identity.pid !== ready.pid || identity.version !== '2.1.4' || !(await client.builtinPluginsOnly()) ||
            !(await client.savedPermissionsEmpty()) || (await client.readMcp()).length !== 0) held();
        const directory = await client.readDirectory();
        const provider = directory.providers.find(row => row.id === providerId);
        const integrationId = provider ? provider.integrationId
          : directory.integrations.find(row => row.id === providerId &&
            !['exa', 'tavily', 'kimi-for-coding', 'kiro', 'cursor-acp'].includes(row.id))?.id;
        if (!integrationId) return held();
        key = createOpenCodeV2CredentialClient({ ...config, integrationId });
        result = await operation({ integrationId, read: key.read, connectKey: key.connectKey,
          rollbackOwnedKey: key.rollbackOwnedKey, readCatalog: async () => {
            let catalog = await client.readCatalog(providerId);
            while (!catalog.models.some(model => model.enabled) && !signal.aborted) {
              await delay(50, undefined, { signal });
              catalog = await client.readCatalog(providerId);
            }
            return catalog;
          } });
        this.assertCurrent(signal);
      } catch (error) { failed = true; failure = error; }
      for (const wire of [key, client]) {
        try { await wire?.dispose(); }
        catch (error) { this.cleanupUnknown = true; if (!failed) { failed = true; failure = error; } }
      }
      if (failed) throw failure;
      return result!;
    });
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
          const stat = lstatSync(directory, { bigint: true });
          if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory ||
              stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
          // The native DB is retained only for its original key intent/readback. Passive catalog
          // namespaces remain disposable; no journal or raw key copy is created here.
          if (!this.options.retainedCommandId) await rm(directory, { recursive: true, force: true });
        }
        return true;
      } catch { return false; }
    })().then(clean => {
      this.metadataDiagnostic?.closed(clean);
      return clean;
    }, error => {
      this.metadataDiagnostic?.closed(false);
      throw error;
    }));
  }
}
