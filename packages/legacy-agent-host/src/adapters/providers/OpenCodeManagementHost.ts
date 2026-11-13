import { randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { OpenCodeClientFactory } from '@agent-teams/provider-implementations/opencode';

import { CapturedProcess } from './CapturedProcess.js';
import { runOpenCodeModelProbe } from './runOpenCodeModelProbe.js';
import { closeCoordinationByDeadline } from './OpenCodeCoordinationEndpoint.js';
import { assertCoordinationDeadline, openV1CoordinationSession, runNativeCoordination, readNativeCoordination } from './OpenCodeCoordinationProbe.js';
import type { OpenCodeV1Coordination, NativeCoordinationObservation } from './OpenCodeCoordinationProbe.js';
import type { Session } from '@agent-teams/provider-session-contracts';
import { openCodeManagementProfileSchema } from '../../management/profile.js';

import type { ProviderModelProbeLimits } from '../../management/contracts.js';
import type { OpenCodeClient } from '@agent-teams/provider-implementations/opencode';
import type { CapturedProcessPort } from './CapturedProcess.js';
import type { OpenCodeManagementProfile } from '../../management/profile.js';

export type { OpenCodeManagementProfile } from '../../management/profile.js';

export type OpenCodeManagementClient = Pick<
  OpenCodeClient,
  | 'getConfig'
  | 'getProviders'
  | 'getConfigProviders'
  | 'getProviderAuth'
  | 'authorizeProviderOAuth'
  | 'completeProviderOAuth'
  | 'setProviderAuth'
  | 'deleteProviderAuth'
>;

export class OpenCodeManagementError extends Error {
  constructor(readonly code: 'invalid-profile' | 'unavailable' | 'profile-changed' | 'held') {
    super(`OpenCode management ${code}`);
  }
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OpenCodeManagementError('invalid-profile');
  return value as Record<string, unknown>;
};

/** Captures one management server; only the explicit no-tool model probe creates a session. */
export class OpenCodeManagementHost {
  private readonly profile: OpenCodeManagementProfile;
  private readonly custody: CapturedProcessPort;
  private readonly password = randomBytes(32).toString('base64url');
  private readonly witness = randomBytes(32).toString('base64url');
  private readonly witnessAgent = `management_${randomBytes(12).toString('hex')}`;
  private readonly abort = new AbortController();
  private readonly factory: OpenCodeClientFactory;
  private readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly coordination: OpenCodeV1Coordination | undefined;
  private coordinationDriver?: Session;
  private coordinationRun?: Promise<boolean>;
  private coordinationResult: NativeCoordinationObservation | undefined;
  private admittedDeadline?: number;
  private stopping?: Promise<boolean>;
  private opening?: Promise<void>;
  private closing?: Promise<boolean>;
  private sealed = false;
  private ready = false;
  private readonly directories = new Map<string, { dev: number; ino: number }>();

  constructor(
    profile: OpenCodeManagementProfile,
    private readonly authority: { canAllocate(): boolean; isCurrent(): boolean },
    options: {
      createProcess?(
        profile: OpenCodeManagementProfile,
        canAllocate: () => boolean
      ): CapturedProcessPort;
      fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
      coordination?: OpenCodeV1Coordination;
    } = {}
  ) {
    const selected = openCodeManagementProfileSchema.safeParse(profile);
    if (!selected.success) throw new OpenCodeManagementError('invalid-profile');
    this.profile = structuredClone(selected.data);
    this.coordination = options.coordination;
    let endpoint: URL;
    try {
      endpoint = new URL(this.profile.endpoint);
    } catch {
      throw new OpenCodeManagementError('invalid-profile');
    }
    if (
      this.profile.provider !== 'opencode' ||
      this.profile.nativeGeneration === 'v2' ||
      !this.profile.profileId ||
      !this.profile.accountBinding ||
      !this.profile.configRevision ||
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      !endpoint.port ||
      endpoint.origin !== this.profile.endpoint ||
      !Number.isSafeInteger(this.profile.timeoutMs) ||
      this.profile.timeoutMs < 1 ||
      this.profile.timeoutMs > 300_000
    )
      throw new OpenCodeManagementError('invalid-profile');
    try {
      for (const path of [
        this.profile.cwd,
        ...['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].map(
          (key) => this.profile.environment[key]
        ),
      ]) {
        if (!path || realpathSync(path) !== path) throw new Error('directory');
        const stat = statSync(path);
        if (!stat.isDirectory()) throw new Error('directory');
        this.directories.set(path, { dev: stat.dev, ino: stat.ino });
      }
    } catch {
      throw new OpenCodeManagementError('invalid-profile');
    }
    const configured = this.profile.environment.OPENCODE_CONFIG_CONTENT;
    let config: Record<string, unknown>;
    try {
      config = configured === undefined ? {} : object(JSON.parse(configured) as unknown);
    } catch {
      throw new OpenCodeManagementError('invalid-profile');
    }
    if (this.coordination) config = structuredClone(this.coordination.config);
    const agents = config.agent === undefined ? {} : object(config.agent);
    this.profile.environment = {
      ...this.profile.environment,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...config,
        // Management conversations are explicit model probes and never execute tools.
        permission: this.coordination ? config.permission : { '*': 'deny' },
        // A private disabled agent witnesses this exact server's effective config.
        // It is not a conversation or a Team member and never executes.
        agent: {
          ...agents,
          [this.witnessAgent]: { prompt: this.witness, disable: true, hidden: true },
        },
      }),
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_SERVER_PASSWORD: this.password,
    };
    this.custody = (
      options.createProcess ??
      ((selection, canAllocate) => new CapturedProcess(selection, canAllocate))
    )(
      structuredClone(this.profile),
      () => !this.sealed && this.authority.canAllocate() && this.authority.isCurrent() &&
        (!this.coordination || this.coordination.isCurrent() && Date.now() < this.coordination.deadline) &&
        (this.admittedDeadline === undefined || Date.now() < this.admittedDeadline)
    );
    this.fetchImpl = async (input, init) => {
        this.assertCurrent();
        const request = new Request(input, init);
        if (new URL(request.url).origin !== this.profile.endpoint)
          throw new OpenCodeManagementError('profile-changed');
        const headers = new Headers(request.headers);
        headers.set(
          'authorization',
          'Basic ' + Buffer.from(`opencode:${this.password}`).toString('base64')
        );
        headers.set('x-opencode-directory', this.profile.cwd);
        const deadline = this.coordination?.deadline ?? this.admittedDeadline;
        if (deadline !== undefined) assertCoordinationDeadline(deadline, this.abort.signal,
          this.coordination?.isCurrent ?? (() => this.authority.isCurrent()));
        const signal = deadline !== undefined ? AbortSignal.any([request.signal, this.abort.signal,
          AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) : request.signal;
        const response = await (options.fetchImpl ?? fetch)(
          new Request(request, { headers, redirect: 'error', signal })
        );
        try {
          this.assertCurrent();
        } catch (error) {
          await response.body?.cancel().catch(() => {});
          throw error;
        }
        return response;
      };
    this.factory = new OpenCodeClientFactory({ fetchImpl: this.fetchImpl });
  }

  private assertCurrent(): void {
    if (this.sealed || !this.authority.isCurrent() || !this.custody.isRunning())
      throw new OpenCodeManagementError('unavailable');
    if (this.coordination)
      assertCoordinationDeadline(this.coordination.deadline, this.abort.signal, this.coordination.isCurrent);
    if (this.admittedDeadline !== undefined && Date.now() >= this.admittedDeadline)
      throw new OpenCodeManagementError('unavailable');
    this.verifyDirectories();
  }

  private verifyDirectories(): void {
    try {
      for (const [path, identity] of this.directories) {
        const stat = statSync(path);
        if (
          realpathSync(path) !== path ||
          !stat.isDirectory() ||
          stat.dev !== identity.dev ||
          stat.ino !== identity.ino
        )
          throw new Error('directory');
      }
    } catch {
      throw new OpenCodeManagementError('profile-changed');
    }
  }

  private async verifyConfig(client: OpenCodeClient): Promise<void> {
    this.assertConfig(await client.getConfig());
  }

  private assertConfig(config: unknown): void {
    const agents =
      config && typeof config === 'object' ? (config as Record<string, unknown>).agent : undefined;
    const agent =
      agents && typeof agents === 'object'
        ? (agents as Record<string, unknown>)[this.witnessAgent]
        : undefined;
    if (
      !agent ||
      typeof agent !== 'object' ||
      (agent as Record<string, unknown>).prompt !== this.witness ||
      (agent as Record<string, unknown>).disable !== true ||
      (agent as Record<string, unknown>).hidden !== true
    )
      throw new OpenCodeManagementError('profile-changed');
    this.assertCurrent();
  }

  start(): Promise<void> {
    if (this.sealed) return Promise.reject(new OpenCodeManagementError('unavailable'));
    this.opening ??= this.open();
    return this.opening;
  }

  private async open(): Promise<void> {
    try {
      if (!this.authority.canAllocate() || !this.authority.isCurrent())
        throw new OpenCodeManagementError('unavailable');
      this.verifyDirectories();
      this.coordination?.beforeAllocation();
      const endpoint = new URL(this.profile.endpoint);
      const child = this.custody.launch({
        command: this.profile.executable.path,
        cwd: this.profile.cwd,
        args: ['serve', '--hostname', '127.0.0.1', '--port', endpoint.port],
        signal: this.abort.signal,
      });
      child.stdout.resume();
      const admitted = this.coordination?.deadline ?? this.admittedDeadline;
      const deadline = performance.now() + (admitted !== undefined
        ? Math.min(this.profile.timeoutMs, admitted - Date.now()) : this.profile.timeoutMs);
      while (performance.now() < deadline) {
        this.assertCurrent();
        const client = this.factory.create(this.profile.endpoint, {
          signal: this.abort.signal,
          remainingMs: () => Math.min(1000, deadline - performance.now()),
        });
        let config: unknown;
        try {
          config = await client.getConfig();
        } catch {
          this.assertCurrent();
          await delay(25, undefined, { signal: this.abort.signal });
          continue;
        }
        this.assertConfig(config);
        this.assertCurrent();
        this.ready = true;
        return;
      }
      throw new OpenCodeManagementError('unavailable');
    } catch (error) {
      const clean = await this.close();
      if (!clean) throw new OpenCodeManagementError('held');
      throw error instanceof OpenCodeManagementError
        ? error
        : new OpenCodeManagementError('unavailable');
    }
  }

  async run<T>(
    action: (client: OpenCodeManagementClient) => Promise<T>,
    options: { signal?: AbortSignal; timeoutMs?: number; deadline?: number } = {}
  ): Promise<T> {
    return this.runNative(
      (client) =>
        action({
          getConfig: client.getConfig.bind(client),
          getProviders: client.getProviders.bind(client),
          getConfigProviders: client.getConfigProviders.bind(client),
          getProviderAuth: client.getProviderAuth.bind(client),
          authorizeProviderOAuth: client.authorizeProviderOAuth.bind(client),
          completeProviderOAuth: client.completeProviderOAuth.bind(client),
          setProviderAuth: client.setProviderAuth.bind(client),
          deleteProviderAuth: client.deleteProviderAuth.bind(client),
        }),
      options
    );
  }

  probeModel(
    input: {
      providerId: string;
      modelId: string;
      variant?: string;
      limits?: ProviderModelProbeLimits;
    },
    signal: AbortSignal,
    timeoutMs: number,
    isCurrent?: () => boolean,
    readiness?: { deadline: number; observeProvider(provider: unknown): boolean }
  ): Promise<boolean> {
    let selectedProvider: Record<string, unknown> | undefined;
    return this.runNative(
      (client) =>
        runOpenCodeModelProbe(readiness ? {
          getConfig: async () => {
            const config = await client.getConfig(); this.assertConfig(config);
            const providers = object(object(config).provider ?? {});
            selectedProvider = object(providers[input.providerId] ?? {});
            return config;
          },
          getProviders: async () => {
            const providers = await client.getProviders();
            const selected = providers.all?.filter(provider => provider.id === input.providerId);
            if (!selectedProvider || selected?.length !== 1) throw new OpenCodeManagementError('unavailable');
            const native = object(selected[0]), models = object(native.models);
            const modelId = input.modelId.startsWith(input.providerId + '/')
              ? input.modelId.slice(input.providerId.length + 1) : input.modelId;
            const api = object(object(models[modelId]).api), options = object(native.options);
            const configuredModel = object(object(selectedProvider.models ?? {})[modelId] ?? {});
            if (typeof api.npm !== 'string' || !api.npm || typeof api.id !== 'string' || !api.id ||
                native.key !== undefined && typeof native.key !== 'string' ||
                options.apiKey !== undefined && typeof options.apiKey !== 'string')
              throw new OpenCodeManagementError('unavailable');
            // Preserve the pinned native SDK's selected URL/key precedence; unknown routes cannot qualify.
            const applicable = readiness.observeProvider({ ...selectedProvider, npm: api.npm, options: {
              ...options, baseURL: typeof options.baseURL === 'string' && options.baseURL !== '' ? options.baseURL : api.url,
              ...(options.apiKey === undefined && native.key ? { apiKey: native.key } : {}),
            } });
            if (applicable && api.id !== (configuredModel.id ?? modelId))
              throw new OpenCodeManagementError('unavailable');
            return providers;
          },
          listExperimentalToolIds: client.listExperimentalToolIds.bind(client),
          createSession: client.createSession.bind(client),
          sendSessionMessage: client.sendSessionMessage.bind(client),
        } : client, {
          ...input,
          cwd: this.profile.cwd,
          ...(isCurrent ? { isCurrent } : {}),
        }),
      { signal, timeoutMs, ...(readiness ? { deadline: readiness.deadline } : {}) }
    );
  }

  /** Private purpose only; startup and the public Session driver share the admitted absolute deadline. */
  probeCoordination(signal: AbortSignal): Promise<boolean> {
    return this.coordinationRun ??= (async () => {
      const selected = this.coordination;
      if (!selected) throw new OpenCodeManagementError('invalid-profile');
      const check = () => assertCoordinationDeadline(selected.deadline, signal, selected.isCurrent);
      check();
      await this.start();
      check(); this.assertCurrent();
      const client = this.factory.create(this.profile.endpoint, {
        signal: AbortSignal.any([signal, this.abort.signal]),
        remainingMs: () => selected.deadline - Date.now(),
      });
      const opened = await openV1CoordinationSession({
        profile: this.profile, input: selected.input, endpoint: selected.endpoint, client,
        fetchImpl: this.fetchImpl, signal, deadline: selected.deadline,
        isCurrent: () => { try { this.assertCurrent(); return true; } catch { return false; } },
        confirmStopped: () => this.stopOwned(), ...(selected.readiness ? { readiness: true } : {}),
      });
      this.coordinationDriver = opened.driver;
      check(); this.assertCurrent();
      if (selected.readiness) {
        this.coordinationResult = await readNativeCoordination(opened.driver, opened.nativeSessionId, selected.endpoint,
          opened.identity, signal, selected.deadline, selected.isCurrent);
        return this.coordinationResult?.status === 'compatible';
      }
      return runNativeCoordination(opened.driver, opened.nativeSessionId, selected.endpoint,
        opened.identity, signal, selected.deadline, selected.isCurrent);
    })();
  }

  coordinationObservation(): NativeCoordinationObservation | undefined {
    return this.coordinationResult === undefined ? undefined : { ...this.coordinationResult };
  }

  private stopOwned(): Promise<boolean> {
    return this.stopping ??= this.custody.confirmStopped();
  }

  private async runNative<T>(
    action: (client: OpenCodeClient) => Promise<T>,
    options: { signal?: AbortSignal; timeoutMs?: number; deadline?: number }
  ): Promise<T> {
    try {
      const timeoutMs = options.timeoutMs ?? this.profile.timeoutMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 17 * 60_000)
        throw new OpenCodeManagementError('invalid-profile');
      if (options.deadline !== undefined) {
        if (!Number.isSafeInteger(options.deadline) || options.deadline <= Date.now() ||
            this.admittedDeadline !== undefined && this.admittedDeadline !== options.deadline)
          throw new OpenCodeManagementError('held');
        this.admittedDeadline = options.deadline;
      }
      options.signal?.throwIfAborted();
      await this.start();
      options.signal?.throwIfAborted();
      this.assertCurrent();
      if (!this.ready) throw new OpenCodeManagementError('unavailable');
      const deadline = performance.now() + (options.deadline === undefined ? timeoutMs :
        Math.min(timeoutMs, options.deadline - Date.now()));
      const client = this.factory.create(this.profile.endpoint, {
        signal: options.signal
          ? AbortSignal.any([this.abort.signal, options.signal])
          : this.abort.signal,
        remainingMs: () => deadline - performance.now(),
      });
      await this.verifyConfig(client);
      const result = await action(client);
      this.assertCurrent();
      options.signal?.throwIfAborted();
      return result;
    } catch (error) {
      // Provider responses may contain credentials; only normalized failures leave this adapter.
      throw error instanceof OpenCodeManagementError
        ? error
        : new OpenCodeManagementError('unavailable');
    }
  }

  close(): Promise<boolean> {
    this.sealed = true;
    this.ready = false;
    this.custody.seal();
    this.abort.abort();
    if (this.coordination) {
      this.coordination.endpoint.seal();
      this.closing ??= closeCoordinationByDeadline((async () => {
        let clean = true;
        try {
          if (this.coordinationDriver) clean = (await this.coordinationDriver.close()).cleanup === 'confirmed';
        } catch { clean = false; }
        try { clean = await this.stopOwned() && clean; } catch { clean = false; }
        return clean;
      })(), this.coordination.deadline);
    } else this.closing ??= this.admittedDeadline === undefined ? this.custody.confirmStopped()
      : closeCoordinationByDeadline(this.stopOwned(), this.admittedDeadline);
    return this.closing;
  }
}
