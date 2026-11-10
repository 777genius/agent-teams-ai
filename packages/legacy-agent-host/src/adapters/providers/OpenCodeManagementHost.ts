import { randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { OpenCodeClientFactory } from '@agent-teams/provider-implementations/opencode';

import { CapturedProcess } from './CapturedProcess.js';
import { runOpenCodeModelProbe } from './runOpenCodeModelProbe.js';
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
    } = {}
  ) {
    const selected = openCodeManagementProfileSchema.safeParse(profile);
    if (!selected.success) throw new OpenCodeManagementError('invalid-profile');
    this.profile = structuredClone(selected.data);
    let endpoint: URL;
    try {
      endpoint = new URL(this.profile.endpoint);
    } catch {
      throw new OpenCodeManagementError('invalid-profile');
    }
    if (
      this.profile.provider !== 'opencode' ||
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
    const agents = config.agent === undefined ? {} : object(config.agent);
    this.profile.environment = {
      ...this.profile.environment,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...config,
        // Management conversations are explicit model probes and never execute tools.
        permission: { '*': 'deny' },
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
      () => !this.sealed && this.authority.canAllocate() && this.authority.isCurrent()
    );
    this.factory = new OpenCodeClientFactory({
      fetchImpl: async (input, init) => {
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
        const response = await (options.fetchImpl ?? fetch)(
          new Request(request, { headers, redirect: 'error' })
        );
        try {
          this.assertCurrent();
        } catch (error) {
          await response.body?.cancel().catch(() => {});
          throw error;
        }
        return response;
      },
    });
  }

  private assertCurrent(): void {
    if (this.sealed || !this.authority.isCurrent() || !this.custody.isRunning())
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
      const endpoint = new URL(this.profile.endpoint);
      const child = this.custody.launch({
        command: this.profile.executable.path,
        cwd: this.profile.cwd,
        args: ['serve', '--hostname', '127.0.0.1', '--port', endpoint.port],
        signal: this.abort.signal,
      });
      child.stdout.resume();
      const deadline = performance.now() + this.profile.timeoutMs;
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
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
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
    isCurrent?: () => boolean
  ): Promise<boolean> {
    return this.runNative(
      (client) =>
        runOpenCodeModelProbe(client, {
          ...input,
          cwd: this.profile.cwd,
          ...(isCurrent ? { isCurrent } : {}),
        }),
      { signal, timeoutMs }
    );
  }

  private async runNative<T>(
    action: (client: OpenCodeClient) => Promise<T>,
    options: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<T> {
    try {
      const timeoutMs = options.timeoutMs ?? this.profile.timeoutMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 17 * 60_000)
        throw new OpenCodeManagementError('invalid-profile');
      options.signal?.throwIfAborted();
      await this.start();
      options.signal?.throwIfAborted();
      this.assertCurrent();
      if (!this.ready) throw new OpenCodeManagementError('unavailable');
      const deadline = performance.now() + timeoutMs;
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
    this.closing ??= this.custody.confirmStopped();
    return this.closing;
  }
}
