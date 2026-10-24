import { realpathSync, statSync } from 'node:fs';
import { z } from 'zod';

import { CodexManagementHost } from '../adapters/providers/CodexManagementHost.js';
import { assertManagementTarget, ManagementCommandError } from '../management/commandRecords.js';
import { managementDigest } from '../management/identity.js';
import { codexManagementProfileSchema } from '../management/profile.js';

import type { CodexManagementProfile } from '../management/profile.js';
import type { CodexMetadataSnapshot } from '../management/contracts.js';
import type { ManagementTarget } from '../management/commandRecords.js';
import type { ModelProbeInput, NativeModelProbe } from '../management/ModelProbeOwner.js';

/** Selected finite Codex account operations, separate from OAuth and conversation owners. */
export class CodexManagementCoordinator {
  private readonly profiles: Map<string, CodexManagementProfile>;
  private readonly live = new Set<CodexManagementHost>();
  private readonly running = new Map<string, Promise<unknown>>();
  private sealed = false;
  private readonly held = new Set<string>();
  private readonly queued = new Map<string, number>();

  constructor(
    profiles: CodexManagementProfile[],
    private readonly assertWriter: () => void
  ) {
    this.profiles = new Map(
      structuredClone(profiles).map((profile) => [profile.profileId, profile])
    );
  }

  has(profileId: string): boolean {
    return this.profiles.has(profileId);
  }

  /** Trusted immutable selections only; no caller-supplied executable/account RPC. */
  admitProbeProfile(raw: CodexManagementProfile): void {
    this.assertWriter();
    if (this.sealed) throw new ManagementCommandError('held');
    const profile = codexManagementProfileSchema.parse(raw);
    const previous = this.profiles.get(profile.profileId);
    if (previous && managementDigest(previous) !== managementDigest(profile))
      throw new ManagementCommandError('conflict');
    if (!previous) this.profiles.set(profile.profileId, structuredClone(profile));
  }

  prepareProbe(input: ModelProbeInput, isCurrent: () => boolean): NativeModelProbe {
    const profile = this.select(input.profileId, input.configRevision);
    if (
      input.providerId !== 'codex' ||
      input.limits ||
      (input.effort !== undefined && input.effort !== profile.reasoningEffort) ||
      input.modelContext !== undefined ||
      /[\0\r\n]/u.test(input.modelId)
    )
      throw new ManagementCommandError('invalid');
    const target = this.target(input.profileId, input.configRevision);
    const abort = new AbortController();
    let host: CodexManagementHost | undefined;
    let pending: Promise<boolean> | undefined;
    return {
      timeoutMs: profile.modelProbeTimeoutMs ?? 90000,
      run: (signal) => {
        const combined = AbortSignal.any([signal, abort.signal]);
        pending = this.enqueue(
          profile,
          async (captured) => {
            combined.throwIfAborted();
            if (!isCurrent()) throw new ManagementCommandError('held');
            host = captured;
            return captured.probe(input.modelId, combined, isCurrent);
          },
          target
        );
        return pending;
      },
      close: async () => {
        abort.abort();
        const clean = host ? await host.close() : true;
        // A queued request must retire before its account fence may be reused.
        await pending?.catch(() => {});
        return clean;
      },
    };
  }

  private select(profileId: string, configRevision: string): CodexManagementProfile {
    this.assertWriter();
    const profile = this.profiles.get(profileId);
    if (this.sealed || !profile || profile.configRevision !== configRevision)
      throw new ManagementCommandError('invalid');
    return profile;
  }

  target(profileId: string, configRevision: string): ManagementTarget {
    const profile = this.select(profileId, configRevision);
    const roots = Object.fromEntries(
      ['cwd', 'HOME', 'CODEX_HOME'].map((key) => {
        const path = key === 'cwd' ? profile.cwd : profile.environment[key]!;
        if (realpathSync(path) !== path) throw new ManagementCommandError('held');
        const stat = statSync(path);
        if (!stat.isDirectory()) throw new ManagementCommandError('held');
        return [key, { path, dev: stat.dev, ino: stat.ino }];
      })
    );
    return {
      profileId,
      configRevision,
      selectionDigest: managementDigest({ profile, roots }),
      resourceId: managementDigest({
        provider: 'codex',
        root: roots.CODEX_HOME,
      }),
    };
  }

  async read(raw: unknown): Promise<CodexMetadataSnapshot> {
    const input = z
      .object({
        profileId: z.string().min(1).max(256),
        configRevision: z.string().min(1).max(256),
        includeModels: z.boolean().optional(),
        includeRateLimits: z.boolean().optional(),
      })
      .strict()
      .parse(raw);
    const profile = this.select(input.profileId, input.configRevision);
    return this.enqueue(profile, (host) =>
      host.read(input.includeModels === true, input.includeRateLimits === true)
    );
  }

  async mutate(
    input: {
      profileId: string;
      configRevision: string;
      kind: 'credential.forget' | 'credential.refresh';
    },
    expected: ManagementTarget
  ): Promise<{ ok: boolean; settled: boolean }> {
    const profile = this.select(input.profileId, input.configRevision);
    try {
      return await this.enqueue(
        profile,
        async (host) => {
          let ok = false;
          try {
            ok = await host.mutate(input.kind);
          } catch {
            /* UNKNOWN is retained by the credential owner; never replay. */
          }
          return { ok, settled: await host.close() };
        },
        expected
      );
    } catch {
      return { ok: false, settled: false };
    }
  }

  private async enqueue<T>(
    profile: CodexManagementProfile,
    action: (host: CodexManagementHost) => Promise<T>,
    expected = this.target(profile.profileId, profile.configRevision)
  ): Promise<T> {
    const key = expected.resourceId;
    const count = this.queued.get(key) ?? 0;
    if (count >= 8 || this.held.has(key)) throw new ManagementCommandError('held');
    this.queued.set(key, count + 1);
    const previous = this.running.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.runOnce(profile, expected, action));
    this.running.set(key, pending);
    try {
      return await pending;
    } finally {
      const left = this.queued.get(key)! - 1;
      if (left) this.queued.set(key, left);
      else this.queued.delete(key);
      if (this.running.get(key) === pending) this.running.delete(key);
    }
  }

  private async runOnce<T>(
    profile: CodexManagementProfile,
    expected: ManagementTarget,
    action: (host: CodexManagementHost) => Promise<T>
  ): Promise<T> {
    const assertBound = () => {
      assertManagementTarget(expected, this.target(profile.profileId, profile.configRevision));
      if (this.held.has(expected.resourceId)) throw new ManagementCommandError('held');
    };
    assertBound();
    const host = new CodexManagementHost(profile, () => {
      try {
        assertBound();
        return true;
      } catch {
        return false;
      }
    });
    this.live.add(host);
    try {
      const result = await action(host);
      assertBound();
      return result;
    } finally {
      if (await host.close()) this.live.delete(host);
      else this.held.add(expected.resourceId);
    }
  }

  seal(): void {
    this.sealed = true;
    for (const host of this.live) void host.close().catch(() => {});
  }
  async close(): Promise<void> {
    this.seal();
    const closed = await Promise.allSettled([...this.live].map((host) => host.close()));
    if (closed.some((result) => result.status !== 'fulfilled' || result.value !== true))
      throw new ManagementCommandError('held');
  }
}
