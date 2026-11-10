import { realpathSync, statSync } from 'node:fs';

import { CodexAppServerClient, probeCodexModel } from '@agent-teams/provider-implementations/codex';

import { CapturedProcess } from './CapturedProcess.js';
import { codexByteTransport } from './codexByteTransport.js';
import { ManagementCommandError } from '../../management/commandRecords.js';
import { codexManagementProfileSchema } from '../../management/profile.js';

import type { CapturedProcessPort } from './CapturedProcess.js';
import type { CodexManagementProfile } from '../../management/profile.js';
import type { CodexMetadataSnapshot } from '../../management/contracts.js';

/** One finite native read. Host owns launch/namespace/custody; D alone owns native codecs. */
export class CodexManagementHost {
  private readonly profile: CodexManagementProfile;
  private readonly custody: CapturedProcessPort;
  private readonly roots = new Map<string, { dev: number; ino: number }>();
  private readonly abort = new AbortController();
  private client?: CodexAppServerClient;
  private sealed = false;
  private used = false;
  private closing?: Promise<boolean>;

  constructor(
    profile: CodexManagementProfile,
    private readonly isCurrent: () => boolean,
    createProcess = (
      selected: CodexManagementProfile,
      current: () => boolean
    ): CapturedProcessPort => new CapturedProcess(selected, current)
  ) {
    const parsed = codexManagementProfileSchema.safeParse(profile);
    if (!parsed.success) throw new ManagementCommandError('invalid');
    this.profile = structuredClone(parsed.data);
    for (const root of [
      this.profile.cwd,
      this.profile.environment.HOME!,
      this.profile.environment.CODEX_HOME!,
    ]) {
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

  async read(includeModels: boolean, includeRateLimits = false): Promise<CodexMetadataSnapshot> {
    return this.run(async (client, signal) => {
      const account = await client.readAccount(signal);
      let rateLimits: CodexMetadataSnapshot['rateLimits'] = {
        state: 'not-requested',
        snapshot: null,
      };
      if (includeRateLimits) {
        if (account.account?.type !== 'chatgpt')
          rateLimits = { state: 'not-authenticated', snapshot: null };
        else {
          try {
            rateLimits = {
              state: 'ready',
              snapshot: await client.readAccountRateLimits(signal),
            };
          } catch {
            // A failed optional read never becomes a stale quota or an auth/execution proof.
            rateLimits = { state: 'unavailable', snapshot: null };
          }
        }
      }
      const configuration = await client.readModelConfiguration(
        {
          cwd: this.profile.cwd,
        },
        signal
      );
      const models: CodexMetadataSnapshot['models'] = [];
      if (includeModels) {
        let cursor: string | null = null;
        const cursors = new Set<string>(),
          ids = new Set<string>();
        for (let page = 0; page < 5; page++) {
          const next = await client.listModels({ cursor, limit: 100, includeHidden: true }, signal);
          for (const model of next.data) {
            if (ids.has(model.id)) throw new ManagementCommandError('held');
            ids.add(model.id);
            models.push(model);
          }
          cursor = next.nextCursor;
          if (cursor === null) break;
          if (page === 4 || cursors.has(cursor)) throw new ManagementCommandError('held');
          cursors.add(cursor);
        }
      }
      if (!this.current()) throw new ManagementCommandError('held');
      const snapshot: CodexMetadataSnapshot = {
        profileId: this.profile.profileId,
        configRevision: this.profile.configRevision,
        ...account,
        rateLimits,
        configuration,
        models,
      };
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 512 * 1024)
        throw new ManagementCommandError('held');
      return snapshot;
    });
  }

  /** One durable credential command calls this once; process custody must settle before its receipt. */
  async mutate(kind: 'credential.forget' | 'credential.refresh'): Promise<boolean> {
    if (!['credential.forget', 'credential.refresh'].includes(kind))
      throw new ManagementCommandError('invalid');
    return this.run(async (client, signal) => {
      if (kind === 'credential.forget') await client.logoutAccount(signal);
      else await client.refreshAccount(signal);
      return true;
    });
  }

  /** D owns finite native preflight; the Host retains this original process' custody. */
  async probe(model: string, signal: AbortSignal, canSubmit: () => boolean): Promise<boolean> {
    if (this.used || !this.current() || !canSubmit()) throw new ManagementCommandError('held');
    this.used = true;
    let result: boolean | undefined;
    try {
      result = await probeCodexModel(
        {
          cwd: this.profile.cwd,
          executablePath: this.profile.executable.path,
          environment: { ...this.profile.environment },
          model,
          ...(this.profile.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: this.profile.reasoningEffort }),
          ...(this.profile.fastMode === undefined ? {} : { fastMode: this.profile.fastMode }),
          ...(this.profile.modelProvider === undefined
            ? {}
            : { modelProvider: this.profile.modelProvider }),
          timeoutMs: this.profile.modelProbeTimeoutMs ?? 90000,
          canSubmit: () => this.current() && canSubmit(),
          launch: (request) => {
            const child = this.custody.launch({
              command: request.command,
              args: [...request.args],
              cwd: request.cwd,
              signal: request.signal,
            });
            const bytes = codexByteTransport(child);
            return {
              transport: {
                read: bytes.read,
                write: (frame, requestSignal) => {
                  if (!this.current() || !canSubmit()) throw new ManagementCommandError('held');
                  return bytes.write(frame, requestSignal);
                },
              },
              dispose: () => this.close(),
            };
          },
        },
        AbortSignal.any([this.abort.signal, signal])
      );
    } catch {
      // Unknown native outcome never becomes model/auth success or a replacement intent.
    }
    const clean = await this.close().catch(() => false);
    if (!clean || !this.current(true) || !canSubmit() || result === undefined)
      throw new ManagementCommandError('held');
    return result;
  }

  private async run<T>(
    action: (client: CodexAppServerClient, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.used || !this.current()) throw new ManagementCommandError('held');
    this.used = true;
    const timer = setTimeout(() => {
      void this.close().catch(() => {});
    }, this.profile.timeoutMs);
    try {
      const child = this.custody.launch({
        command: this.profile.executable.path,
        args: ['app-server', '--listen', 'stdio://'],
        cwd: this.profile.cwd,
      });
      const bytes = codexByteTransport(child);
      const client = new CodexAppServerClient({
        transport: {
          read: bytes.read,
          write: (frame, signal) => {
            if (!this.current()) throw new ManagementCommandError('held');
            return bytes.write(frame, signal);
          },
        },
        limits: {
          requestTimeoutMs: this.profile.timeoutMs,
          maxFrameBytes: 512 * 1024,
        },
        onEvent: () => {},
        requestApproval: async () => ({
          kind: 'decision',
          decision: 'decline',
        }),
      });
      this.client = client;
      await client.initialize({
        clientInfo: { name: 'agent-teams-host-metadata', version: '1' },
        capabilities: { experimentalApi: false },
      });
      const identity = client.getRuntimeIdentity();
      if (identity.codexHome !== this.profile.environment.CODEX_HOME || !this.current())
        throw new ManagementCommandError('held');
      const result = await action(client, this.abort.signal);
      if (!this.current()) throw new ManagementCommandError('held');
      return result;
    } catch {
      throw new ManagementCommandError('held');
    } finally {
      clearTimeout(timer);
      if (!(await this.close()) || !this.current(true)) throw new ManagementCommandError('held');
    }
  }

  close(): Promise<boolean> {
    if (this.closing) return this.closing;
    this.sealed = true;
    this.abort.abort();
    this.client?.close();
    this.custody.seal();
    this.closing = this.custody.confirmStopped();
    return this.closing;
  }
}
