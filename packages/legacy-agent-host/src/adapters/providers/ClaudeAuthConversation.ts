import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

import { createClaudeManagementDiagnostic } from './createClaudeCloseDiagnostic.js';
import { CapturedProcess } from './CapturedProcess.js';
import { parseClaudeAuthStatus, readClaudeAuthorizationUrl } from './claudeAuthStatus.js';
import { ManagementCommandError } from '../../management/commandRecords.js';
import { claudeManagementProfileSchema } from '../../management/profile.js';

import type { CapturedProcessPort } from './CapturedProcess.js';
import type { OAuthNativeConversation } from '../../management/OAuthOperationOwner.js';
import type { ClaudeManagementProfile } from '../../management/profile.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Official CLI conversation. Construction captures custody but performs no auth or allocation. */
export class ClaudeAuthConversation implements OAuthNativeConversation {
  readonly timeoutMs = 17 * 60_000;
  private readonly done = deferred<boolean>();
  readonly nativeCompletion = this.done.promise;
  private readonly profile: ClaudeManagementProfile;
  private readonly custody: CapturedProcessPort;
  private readonly diagnostic: ReturnType<typeof createClaudeManagementDiagnostic>;
  private readonly roots = new Map<string, { dev: number; ino: number }>();
  private readonly configDirectory: string;
  private readonly anthropicDirectory: string;
  private readonly abort = new AbortController();
  private login?: ChildProcessWithoutNullStreams;
  private started = false;
  private codeSent = false;
  private sealed = false;
  private closing?: Promise<boolean>;

  constructor(
    profile: ClaudeManagementProfile,
    private readonly isCurrent: () => boolean,
    createProcess = (
      selected: ClaudeManagementProfile,
      current: () => boolean
    ): CapturedProcessPort => new CapturedProcess(selected, current)
  ) {
    this.profile = structuredClone(claudeManagementProfileSchema.parse(profile));
    this.diagnostic = createClaudeManagementDiagnostic(this.profile);
    this.configDirectory =
      this.profile.configNamespace === 'native-default'
        ? join(this.profile.environment.HOME!, '.claude')
        : this.profile.environment.CLAUDE_CONFIG_DIR!;
    // The official CLI also owns Console profile credentials outside CLAUDE_CONFIG_DIR.
    // Resolve that namespace from the same captured environment, never process.env.
    this.anthropicDirectory =
      this.profile.environment.ANTHROPIC_CONFIG_DIR?.trim() ||
      join(
        this.profile.environment.XDG_CONFIG_HOME?.trim() ||
          join(this.profile.environment.HOME!, '.config'),
        'anthropic'
      );
    for (const root of [this.profile.cwd, this.profile.environment.HOME!, this.configDirectory]) {
      if (realpathSync(root) !== root) throw new ManagementCommandError('held');
      const stat = statSync(root);
      if (!stat.isDirectory()) throw new ManagementCommandError('held');
      this.roots.set(root, { dev: stat.dev, ino: stat.ino });
    }
    this.checkAnthropicDirectory(true);
    this.custody = createProcess(this.profile, () => this.current());
  }

  private checkAnthropicDirectory(capture = false): void {
    const path = this.anthropicDirectory;
    if (!isAbsolute(path) || resolve(path) !== path) throw new ManagementCommandError('invalid');
    let cursor = parse(path).root;
    for (const segment of path.slice(cursor.length).split(sep).filter(Boolean)) {
      cursor = join(cursor, segment);
      try {
        const stat = lstatSync(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ManagementCommandError('held');
        if (capture) this.roots.set(cursor, { dev: stat.dev, ino: stat.ino });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        break;
      }
    }
  }

  private current(): boolean {
    try {
      if (this.sealed || !this.isCurrent()) return false;
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
      this.checkAnthropicDirectory();
      return true;
    } catch {
      return false;
    }
  }

  private assertCurrent(): void {
    if (!this.current()) throw new ManagementCommandError('held');
  }

  async authorize(fields: Record<string, string> | undefined, signal: AbortSignal) {
    if (this.started || (fields && Object.keys(fields).length))
      throw new ManagementCommandError('invalid');
    this.started = true;
    // Environment-managed credentials cannot be changed by a native subscription sign-in.
    this.assertNativeSubscription();
    const initial = await this.status(signal);
    this.assertCurrent();
    if (initial.forcedLoginMethod && initial.forcedLoginMethod !== 'claudeai')
      throw new ManagementCommandError('invalid');
    if (initial.loggedIn && initial.authMethod !== 'claude.ai')
      throw new ManagementCommandError('invalid');
    const child = this.launch(['auth', 'login', '--claudeai'], signal);
    this.login = child;
    const authorization = deferred<string | undefined>();
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (!this.current()) return;
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 64 * 1024) {
        this.done.resolve(false);
        void this.close();
        return;
      }
      try {
        const url = readClaudeAuthorizationUrl(output);
        if (url) authorization.resolve(url);
      } catch {
        this.done.resolve(false);
        void this.close();
      }
    });
    void this.exit(child)
      .then(async (code) => {
        authorization.resolve(undefined);
        if (code !== 0 || !this.current()) return false;
        const status = await this.status(signal);
        this.assertCurrent();
        return status.loggedIn && status.authMethod === 'claude.ai';
      })
      .then(
        (ok) => this.done.resolve(ok),
        () => this.done.resolve(false)
      );
    const authorizationUrl = await authorization.promise;
    this.assertCurrent();
    if (!authorizationUrl) throw new ManagementCommandError('held');
    return {
      authorizationUrl,
      instructions: 'Complete sign-in in the browser, or paste the returned code.',
      completionMethod: 'code' as const,
      browserOwner: 'native' as const,
    };
  }

  private assertNativeSubscription(): void {
    if (
      Object.keys(this.profile.environment).some((key) =>
        /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|PROFILE)|CLAUDE_CODE_(?:OAUTH|USE_))/u.test(
          key
        )
      )
    )
      throw new ManagementCommandError('invalid');
  }

  async read(signal: AbortSignal) {
    if (this.started) throw new ManagementCommandError('invalid');
    this.started = true;
    return this.withClosedCustody(() => this.status(signal));
  }

  async forget(signal: AbortSignal): Promise<boolean> {
    if (this.started) throw new ManagementCommandError('invalid');
    this.started = true;
    this.assertNativeSubscription();
    return this.withClosedCustody(async () => {
      const before = await this.status(signal);
      if (before.authMethod !== 'none' && before.authMethod !== 'claude.ai')
        throw new ManagementCommandError('invalid');
      const code = await this.exit(this.launch(['auth', 'logout'], signal));
      this.assertCurrent();
      const after = await this.status(signal);
      return code === 0 && !after.loggedIn;
    });
  }

  private async withClosedCustody<T>(work: () => Promise<T>): Promise<T> {
    const result = await work().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    let closed;
    try { closed = await this.close(); }
    catch (error) { this.diagnostic('auth-cleanup', error); throw error; }
    if (!closed) {
      this.diagnostic('auth-cleanup', new Error('cleanup-unconfirmed'));
      throw new ManagementCommandError('held');
    }
    if (!result.ok) throw result.error;
    return result.value;
  }

  async complete(code: string | undefined, signal: AbortSignal): Promise<boolean> {
    this.assertCurrent();
    signal.throwIfAborted();
    if (code !== undefined) {
      if (this.codeSent || !this.login || !/^[^\s#]+#[^\s#]+$/u.test(code) || code.length > 16384)
        throw new ManagementCommandError('invalid');
      this.codeSent = true;
      this.login.stdin.write(`${code}\n`);
    }
    const ok = await this.nativeCompletion;
    this.assertCurrent();
    signal.throwIfAborted();
    return ok && (await this.close());
  }

  private launch(args: string[], signal: AbortSignal): ChildProcessWithoutNullStreams {
    this.assertCurrent();
    signal.throwIfAborted();
    return this.custody.launch({
      command: this.profile.executable.path,
      args,
      cwd: this.profile.cwd,
      signal: AbortSignal.any([signal, this.abort.signal]),
    });
  }

  private exit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
  }

  private async status(signal: AbortSignal) {
    const child = this.launch(['auth', 'status', '--json'], signal);
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > 64 * 1024) {
        this.done.resolve(false);
        void this.close();
      }
    });
    const exitCode = await this.exit(child);
    this.assertCurrent();
    return parseClaudeAuthStatus(stdout, exitCode, this.configDirectory);
  }

  close(): Promise<boolean> {
    if (this.closing) return this.closing;
    this.sealed = true;
    this.abort.abort();
    this.custody.seal();
    this.done.resolve(false);
    this.closing = this.custody.confirmStopped();
    return this.closing;
  }
}
