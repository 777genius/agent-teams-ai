import { realpathSync, statSync } from 'node:fs';

import { CodexAppServerClient } from '@agent-teams/provider-implementations/codex';

import { CapturedProcess } from './CapturedProcess.js';
import { codexByteTransport } from './codexByteTransport.js';
import { ManagementCommandError } from '../../management/commandRecords.js';
import { codexManagementProfileSchema } from '../../management/profile.js';

import type { OAuthNativeConversation } from '../../management/OAuthOperationOwner.js';
import type { CodexManagementProfile } from '../../management/profile.js';
import type {
  CodexAccountLoginCompleted,
  CodexAccountLoginType,
} from '@agent-teams/provider-implementations/codex';

type LoginProcess = Pick<CapturedProcess, 'launch' | 'confirmStopped' | 'seal'>;

/** One captured login. The shared OAuth owner retains admission, durable state and auth fencing. */
export class CodexLoginConversation implements OAuthNativeConversation {
  readonly timeoutMs = 10 * 60_000;
  readonly nativeCompletion: Promise<boolean>;
  private resolveCompletion!: (ok: boolean) => void;
  private readonly profile: CodexManagementProfile;
  private readonly custody: LoginProcess;
  private readonly roots = new Map<string, { dev: number; ino: number }>();
  private readonly abort = new AbortController();
  private readonly early = new Map<string, CodexAccountLoginCompleted>();
  private client?: CodexAppServerClient;
  private loginId?: string;
  private completed?: CodexAccountLoginCompleted;
  private started = false;
  private sealed = false;
  private closing?: Promise<boolean>;

  constructor(
    profile: CodexManagementProfile,
    private readonly type: CodexAccountLoginType,
    private readonly isCurrent: () => boolean,
    createProcess = (
      selected: CodexManagementProfile,
      current: () => boolean
    ): LoginProcess => new CapturedProcess(selected, current)
  ) {
    this.profile = structuredClone(codexManagementProfileSchema.parse(profile));
    for (const root of [
      this.profile.cwd,
      this.profile.environment.HOME!,
      this.profile.environment.CODEX_HOME!,
    ]) {
      if (realpathSync(root) !== root) throw new ManagementCommandError('held');
      const stat = statSync(root);
      if (!stat.isDirectory()) throw new ManagementCommandError('held');
      this.roots.set(root, { dev: stat.dev, ino: stat.ino });
    }
    this.custody = createProcess(this.profile, () => this.current());
    this.nativeCompletion = new Promise((done) => {
      this.resolveCompletion = done;
    });
  }

  private current(allowSealed = false): boolean {
    try {
      if ((!allowSealed && this.sealed) || !this.isCurrent()) return false;
      for (const [root, expected] of this.roots) {
        const stat = statSync(root);
        if (
          realpathSync(root) !== root ||
          !stat.isDirectory() ||
          stat.dev !== expected.dev ||
          stat.ino !== expected.ino
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private assertCurrent(): void {
    if (!this.current()) throw new ManagementCommandError('held');
  }

  private observe(completion: CodexAccountLoginCompleted): void {
    if (this.sealed || completion.loginId === null) return;
    if (this.loginId === undefined) {
      const previous = this.early.get(completion.loginId);
      if (
        (previous && previous.success !== completion.success) ||
        (!previous && this.early.size >= 8)
      ) {
        void this.close();
        return;
      }
      this.early.set(completion.loginId, completion);
      return;
    }
    if (completion.loginId !== this.loginId || this.completed) return;
    this.completed = completion;
    this.resolveCompletion(completion.success);
  }

  async authorize(fields: Record<string, string> | undefined, signal: AbortSignal) {
    if (this.started || (fields && Object.keys(fields).length))
      throw new ManagementCommandError('invalid');
    this.started = true;
    this.assertCurrent();
    signal.throwIfAborted();
    const combined = AbortSignal.any([signal, this.abort.signal]);
    const cancel = () => {
      void this.close();
    };
    combined.addEventListener('abort', cancel, { once: true });
    try {
      const child = this.custody.launch({
        command: this.profile.executable.path,
        args: ['app-server', '--listen', 'stdio://'],
        cwd: this.profile.cwd,
      });
      child.once('close', () => this.resolveCompletion(false));
      child.once('error', () => this.resolveCompletion(false));
      const bytes = codexByteTransport(child);
      const client = new CodexAppServerClient({
        transport: {
          read: bytes.read,
          write: (frame, requestSignal) => {
            // Functional requests carry the abort above; only exact cancellation may outlive sealing.
            if (!this.current(true)) throw new ManagementCommandError('held');
            return bytes.write(frame, requestSignal);
          },
        },
        limits: { requestTimeoutMs: this.profile.timeoutMs, maxFrameBytes: 512 * 1024 },
        onAccountLoginCompleted: (completion) => this.observe(completion),
        onEvent: () => {},
        requestApproval: async () => ({ kind: 'decision', decision: 'decline' }),
      });
      this.client = client;
      await client.initialize({
        clientInfo: { name: 'agent-teams-host-login', version: '1' },
        capabilities: { experimentalApi: false },
      });
      this.assertCurrent();
      if (client.getRuntimeIdentity().codexHome !== this.profile.environment.CODEX_HOME)
        throw new ManagementCommandError('held');
      const started = await client.startAccountLogin(this.type, combined);
      this.assertCurrent();
      this.loginId = started.loginId;
      const early = this.early.get(started.loginId);
      this.early.clear();
      if (early) this.observe(early);
      return {
        authorizationUrl: started.type === 'chatgpt' ? started.authUrl : started.verificationUrl,
        instructions: 'Complete sign-in on the account page.',
        completionMethod: 'auto' as const,
        ...(started.type === 'chatgptDeviceCode' ? { userCode: started.userCode } : {}),
      };
    } catch {
      await this.close();
      throw new ManagementCommandError('held');
    } finally {
      combined.removeEventListener('abort', cancel);
    }
  }

  async complete(code: string | undefined, signal: AbortSignal): Promise<boolean> {
    if (code !== undefined) throw new ManagementCommandError('invalid');
    this.assertCurrent();
    signal.throwIfAborted();
    if (!(await this.nativeCompletion)) return false;
    this.assertCurrent();
    const account = await this.client!.readAccount(AbortSignal.any([signal, this.abort.signal]));
    this.assertCurrent();
    if (account.account?.type !== 'chatgpt') return false;
    // OAuthOperationOwner publishes completed only after this original child is physically stopped.
    return this.close();
  }

  close(): Promise<boolean> {
    if (this.closing) return this.closing;
    this.sealed = true;
    this.closing = Promise.resolve().then(async () => {
      try {
        if (this.loginId && !this.completed && this.client?.isOpen())
          await this.client.cancelAccountLogin(
            this.loginId,
            AbortSignal.timeout(Math.min(this.profile.timeoutMs, 5000))
          );
      } catch {
        // Uncertain cancel is not logout. Cleanup still belongs to the original process only.
      } finally {
        this.client?.close();
      }
      return this.custody.confirmStopped();
    });
    // Publish the one cleanup promise before abort listeners can re-enter close().
    this.abort.abort();
    this.custody.seal();
    this.early.clear();
    this.resolveCompletion(false);
    return this.closing;
  }
}
