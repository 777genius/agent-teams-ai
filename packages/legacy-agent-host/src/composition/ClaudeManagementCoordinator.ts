import { z } from 'zod';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createClaudeManagementDiagnostic } from '../adapters/providers/createClaudeCloseDiagnostic.js';
import type { ClaudeManagementStage } from '../adapters/providers/createClaudeCloseDiagnostic.js';
import { ClaudeManagementHost } from '../adapters/providers/ClaudeManagementHost.js';
import { assertManagementTarget, ManagementCommandError } from '../management/commandRecords.js';
import { managementDigest } from '../management/identity.js';
import { claudeManagementProfileSchema } from '../management/profile.js';

import type { ClaudeMetadataSnapshot } from '../management/contracts.js';
import type { ClaudeManagementProfile } from '../management/profile.js';
import type { ManagementTarget } from '../management/commandRecords.js';
import type { ModelProbeInput, NativeModelProbe } from '../management/ModelProbeOwner.js';

/** Captured Claude mechanism selection. Durable model-test intents belong to ModelProbeOwner. */
export class ClaudeManagementCoordinator {
  private readonly profiles: Map<string, ClaudeManagementProfile>;
  private readonly live = new Map<string, ClaudeManagementHost>();
  private readonly metadataReads = new Map<string, Promise<void>>();
  private readonly held = new Set<string>();
  private sealed = false;

  constructor(
    profiles: ClaudeManagementProfile[],
    private readonly assertWriter: () => void
  ) {
    this.profiles = new Map(
      structuredClone(profiles).map((profile) => [profile.profileId, profile])
    );
  }

  has(profileId: string): boolean {
    return this.profiles.has(profileId);
  }

  /** Trusted composition only: immutable digest-keyed probes may select a fresh draft cwd. */
  admitProbeProfile(raw: ClaudeManagementProfile): void {
    this.assertWriter();
    if (this.sealed) throw new ManagementCommandError('held');
    const profile = claudeManagementProfileSchema.parse(raw);
    const previous = this.profiles.get(profile.profileId);
    if (previous && managementDigest(previous) !== managementDigest(profile))
      throw new ManagementCommandError('conflict');
    if (!previous) this.profiles.set(profile.profileId, structuredClone(profile));
  }

  private select(profileId: string, configRevision: string): ClaudeManagementProfile {
    this.assertWriter();
    const profile = this.profiles.get(profileId);
    if (this.sealed || !profile || profile.configRevision !== configRevision)
      throw new ManagementCommandError('invalid');
    return profile;
  }

  target(profileId: string, configRevision: string): ManagementTarget {
    const profile = this.select(profileId, configRevision);
    const config =
      profile.configNamespace === 'native-default'
        ? join(profile.environment.HOME!, '.claude')
        : profile.environment.CLAUDE_CONFIG_DIR!;
    const roots = Object.fromEntries(
      [
        ['cwd', profile.cwd],
        ['home', profile.environment.HOME!],
        ['config', config],
      ].map(([name, path]) => {
        if (!path || realpathSync(path) !== path) throw new ManagementCommandError('held');
        const stat = statSync(path);
        if (!stat.isDirectory()) throw new ManagementCommandError('held');
        return [name, { path, dev: stat.dev, ino: stat.ino }];
      })
    );
    return {
      profileId,
      configRevision,
      selectionDigest: managementDigest({ profile, roots }),
      resourceId: managementDigest({ provider: 'claude', config: roots.config }),
    };
  }

  prepareProbe(input: ModelProbeInput, isCurrent: () => boolean = () => true): NativeModelProbe {
    const profile = this.select(input.profileId, input.configRevision);
    if (input.providerId !== 'anthropic' || input.limits || /[\0\r\n]/u.test(input.modelId))
      throw new ManagementCommandError('invalid');
    const effort = input.effort;
    if (effort === 'none' || effort === 'minimal' || effort === 'ultra')
      throw new ManagementCommandError('invalid');
    const expected = this.target(input.profileId, input.configRevision);
    const key = JSON.stringify([profile.environment.HOME, profile.environment.CLAUDE_CONFIG_DIR]);
    let host: ClaudeManagementHost | undefined;
    const diagnostic = createClaudeManagementDiagnostic(profile, input.commandId);
    return {
      timeoutMs: profile.modelProbeTimeoutMs ?? 90000,
      run: async (signal) => {
        let stage: ClaudeManagementStage = 'probe-target';
        try {
          for (;;) {
            stage = 'probe-target';
            assertManagementTarget(expected, this.target(input.profileId, input.configRevision));
            stage = 'probe-current';
            if (!isCurrent()) throw new ManagementCommandError('held');
            stage = 'probe-aborted';
            if (signal.aborted) throw new ManagementCommandError('held');
            stage = 'probe-namespace-held';
            if (this.held.has(key)) throw new ManagementCommandError('held');
            stage = 'probe-live';
            if (!this.live.has(key)) break;
            const reading = this.metadataReads.get(key);
            stage = 'probe-metadata-missing';
            if (!reading) throw new ManagementCommandError('held');
            // Discovery owns its own cleanup. Waiting must neither cancel that read
            // nor turn this already admitted model intent into a replacement request.
            stage = 'probe-metadata-wait';
            await new Promise<void>((resolve, reject) => {
              const aborted = () => {
                signal.removeEventListener('abort', aborted);
                reject(new ManagementCommandError('held'));
              };
              signal.addEventListener('abort', aborted, { once: true });
              if (signal.aborted) aborted();
              void reading.then(() => {
                signal.removeEventListener('abort', aborted);
                resolve();
              });
            });
            // Recheck the exact target and namespace after every asynchronous wait.
          }
          const current = () => {
            try {
              assertManagementTarget(expected, this.target(input.profileId, input.configRevision));
              return isCurrent() && !this.held.has(key);
            } catch {
              return false;
            }
          };
          stage = 'probe-host';
          host = new ClaudeManagementHost(profile, current);
          this.live.set(key, host);
          stage = 'probe-native';
          return await host.probe(input.modelId, signal, {
            ...(effort === undefined ? {} : { effort }),
            ...(input.modelContext === undefined ? {} : { context: input.modelContext }),
          });
        } catch (error) {
          diagnostic(stage, error);
          throw error;
        }
      },
      close: () => (host ? this.retire(key, host) : Promise.resolve(true)),
    };
  }

  private async retire(key: string, host: ClaudeManagementHost): Promise<boolean> {
    const clean = await host.close();
    if (!clean) this.held.add(key);
    if (clean && this.live.get(key) === host) this.live.delete(key);
    return clean;
  }

  async read(raw: unknown): Promise<ClaudeMetadataSnapshot> {
    const input = z
      .object({ profileId: z.string().min(1).max(256), configRevision: z.string().min(1).max(256) })
      .strict()
      .parse(raw);
    const profile = this.select(input.profileId, input.configRevision);
    const key = JSON.stringify([profile.environment.HOME, profile.environment.CLAUDE_CONFIG_DIR]);
    if (this.live.has(key) || this.held.has(key)) throw new ManagementCommandError('held');
    const host = new ClaudeManagementHost(profile, () => {
      try {
        this.assertWriter();
        return !this.sealed;
      } catch {
        return false;
      }
    });
    let finished!: () => void;
    const reading = new Promise<void>((resolve) => {
      finished = resolve;
    });
    this.metadataReads.set(key, reading);
    this.live.set(key, host);
    try {
      return await host.read();
    } finally {
      try {
        await this.retire(key, host);
      } finally {
        if (this.metadataReads.get(key) === reading) this.metadataReads.delete(key);
        finished();
      }
    }
  }

  seal(): void {
    this.sealed = true;
    for (const host of this.live.values()) void host.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.seal();
    const results = await Promise.allSettled([...this.live.values()].map((host) => host.close()));
    if (results.some((result) => result.status !== 'fulfilled' || !result.value))
      throw new ManagementCommandError('held');
  }
}
