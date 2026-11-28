import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { probeClaudeModel, readClaudeMetadata } from '@agent-teams/provider-implementations/claude';

import { createClaudeManagementDiagnostic } from './createClaudeCloseDiagnostic.js';
import { CapturedProcess } from './CapturedProcess.js';
import { ManagementCommandError } from '../../management/commandRecords.js';
import { claudeManagementProfileSchema } from '../../management/profile.js';

import type { CapturedProcessPort } from './CapturedProcess.js';
import type { ClaudeMetadataSnapshot } from '../../management/contracts.js';
import type { ClaudeManagementProfile } from '../../management/profile.js';
import type { ClaudeModelProbeConfig } from '@agent-teams/provider-implementations/claude';

/** Finite native metadata/model tests. No Team bootstrap or conversation owner. */
export class ClaudeManagementHost {
  private readonly profile: ClaudeManagementProfile;
  private readonly custody: CapturedProcessPort;
  private readonly diagnostic: ReturnType<typeof createClaudeManagementDiagnostic>;
  private readonly roots = new Map<string, { dev: number; ino: number }>();
  private readonly abort = new AbortController();
  private sealed = false;
  private used = false;
  private closing?: Promise<boolean>;

  constructor(
    profile: ClaudeManagementProfile,
    private readonly isCurrent: () => boolean,
    createProcess = (
      selected: ClaudeManagementProfile,
      current: () => boolean
    ): CapturedProcessPort => new CapturedProcess(selected, current)
  ) {
    const parsed = claudeManagementProfileSchema.safeParse(profile);
    if (!parsed.success) throw new ManagementCommandError('invalid');
    this.profile = structuredClone(parsed.data);
    this.diagnostic = createClaudeManagementDiagnostic(this.profile);
    const configRoot =
      this.profile.configNamespace === 'native-default'
        ? join(this.profile.environment.HOME!, '.claude')
        : this.profile.environment.CLAUDE_CONFIG_DIR!;
    for (const root of [this.profile.cwd, this.profile.environment.HOME!, configRoot]) {
      if (realpathSync(root) !== root) throw new ManagementCommandError('invalid');
      const stat = statSync(root);
      if (!stat.isDirectory()) throw new ManagementCommandError('invalid');
      this.roots.set(root, { dev: stat.dev, ino: stat.ino });
    }
    this.custody = createProcess(this.profile, () => this.current());
  }

  private current(allowSealed = false): boolean {
    try {
      if ((!allowSealed && this.sealed) || !this.isCurrent()) return false;
      for (const [root, expected] of this.roots) {
        if (realpathSync(root) !== root) return false;
        const stat = statSync(root);
        if (!stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino)
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async read(): Promise<ClaudeMetadataSnapshot> {
    return this.run('metadata', async () => {
      const metadata = await readClaudeMetadata(
        {
          cwd: this.profile.cwd,
          executablePath: this.profile.executable.path,
          environment: { ...this.profile.environment },
          configNamespace: this.profile.configNamespace,
          ...(this.profile.settingSources
            ? { settingSources: [...this.profile.settingSources] }
            : {}),
          timeoutMs: this.profile.timeoutMs,
          launch: this.custody.launch,
          confirmStopped: () => this.close(),
        },
        this.abort.signal
      );
      // Owned cleanup sealed this Host; its original writer and roots must still be current.
      if (!this.current(true)) throw new ManagementCommandError('held');
      return {
        profileId: this.profile.profileId,
        configRevision: this.profile.configRevision,
        account: {
          apiProvider: metadata.account.apiProvider ?? null,
          tokenSource: metadata.account.tokenSource ?? null,
          apiKeySource: metadata.account.apiKeySource ?? null,
          subscriptionType: metadata.account.subscriptionType ?? null,
        },
        models: metadata.models.map((row) => ({
          modelId: row.value,
          resolvedModel: row.resolvedModel ?? null,
          displayName: row.displayName,
          description: row.description,
          supportedEffortLevels: row.supportedEffortLevels ?? [],
          supportsFastMode: row.supportsFastMode ?? null,
        })),
      };
    });
  }

  probe(
    model: string,
    signal: AbortSignal,
    options?: Pick<ClaudeModelProbeConfig, 'effort' | 'context'>
  ): Promise<boolean> {
    return this.run('probe', () =>
      probeClaudeModel(
        {
          cwd: this.profile.cwd,
          executablePath: this.profile.executable.path,
          environment: { ...this.profile.environment },
          configNamespace: this.profile.configNamespace,
          ...(this.profile.settingSources
            ? { settingSources: [...this.profile.settingSources] }
            : {}),
          timeoutMs: this.profile.modelProbeTimeoutMs ?? 90000,
          model,
          ...(options?.effort === undefined ? {} : { effort: options.effort }),
          ...(options?.context === undefined ? {} : { context: options.context }),
          launch: this.custody.launch,
          confirmStopped: () => this.close(),
          canSubmit: () => this.current(),
        },
        AbortSignal.any([this.abort.signal, signal])
      )
    );
  }

  private async run<T>(stage: 'metadata' | 'probe', action: () => Promise<T>): Promise<T> {
    if (this.used || !this.current()) {
      this.diagnostic(stage === 'probe' ? 'host-probe-guard' : 'host-metadata-guard', new ManagementCommandError('held'));
      throw new ManagementCommandError('held');
    }
    this.used = true;
    let result: { value: T } | undefined;
    try {
      result = { value: await action() };
    } catch (error) {
      this.diagnostic(stage === 'probe' ? 'host-probe' : 'host-metadata', error);
    }
    const closed = await this.close().catch((error: unknown) => {
      this.diagnostic('host-cleanup', error);
      return false;
    });
    if (!closed) {
      this.diagnostic('host-cleanup', new Error('cleanup-unconfirmed'));
      throw new ManagementCommandError('held');
    }
    if (!this.current(true)) {
      this.diagnostic('host-result-current', new ManagementCommandError('held'));
      throw new ManagementCommandError('held');
    }
    if (!result) throw new ManagementCommandError('held');
    return result.value;
  }

  close(): Promise<boolean> {
    if (this.closing) return this.closing;
    this.sealed = true;
    // Cache before entering custody ports; reentrant close joins the same stop budget.
    this.closing = Promise.resolve().then(() => {
      this.custody.seal();
      return this.custody.confirmStopped();
    }).finally(() => { this.abort.abort(); });
    return this.closing;
  }
}
