import { performance } from 'node:perf_hooks';
import { CapturedProcess } from './CapturedProcess.js';
import { RuntimeSourceAdmissionError } from '../../composition/runtimeSourceQualification.js';
import type { CapturedProcessPort, CapturedProcessProfile } from './CapturedProcess.js';
import type { RuntimeSourceCandidate } from '../../composition/runtimeSourceContracts.js';
import type { ProviderManagementProfile } from '../../management/profile.js';
import type {
  RuntimeSourceNativeCheck,
  RuntimeSourceNativeIdentity,
} from '../../management/runtimeSourceVerification.js';
import type { RegisteredProcessRootSource } from '../../process/registeredProcessContracts.js';

const environmentNames = new Set([
  'HOME',
  'PATH',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SYSTEMROOT',
  'WINDIR',
  'LOCALAPPDATA',
  'APPDATA',
  'LANG',
  'LC_ALL',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
]);

/** Version reads receive no credentials, provider config, loader flags or ambient process.env. */
function versionEnvironment(seed: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(seed).filter(([key]) => environmentNames.has(key.toUpperCase()))
  );
}

export function parseRuntimeSourceNativeVersion(
  provider: ProviderManagementProfile['provider'],
  raw: string
): string {
  let value = raw.trim();
  if (provider === 'codex') {
    if (!value.startsWith('codex-cli '))
      throw new RuntimeSourceAdmissionError('native-version-mismatch');
    value = value.slice('codex-cli '.length);
  } else if (provider === 'claude')
    value = value.replace(/ \(Claude Code\)$/, '').replace(/^v/, '');
  else value = value.replace(/^opencode v(?=2\.)/, '').replace(/^v/, '');
  if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value))
    throw new RuntimeSourceAdmissionError('native-version-mismatch');
  return value;
}

/** At most two owned, noninteractive --version children under one existing source receipt. */
export class RuntimeSourceNativeVersion implements RuntimeSourceNativeCheck {
  private readonly processes = new Set<CapturedProcessPort>();
  private readonly abort = new AbortController();
  private used = false;
  private deadline = 0;
  private closing: Promise<boolean> | undefined;

  constructor(
    private readonly seed: ProviderManagementProfile,
    private readonly candidate: RuntimeSourceCandidate,
    private readonly isCurrent: () => boolean,
    private readonly processCustody?: RegisteredProcessRootSource,
    private readonly createProcess = (
      profile: CapturedProcessProfile,
      current: () => boolean,
      custody?: RegisteredProcessRootSource
    ): CapturedProcessPort => new CapturedProcess(profile, current, custody)
  ) {}

  async run(): Promise<RuntimeSourceNativeIdentity> {
    const cli = this.candidate.nativeCli;
    if (this.used || this.abort.signal.aborted || !cli || !this.isCurrent())
      throw new RuntimeSourceAdmissionError('native-outcome-unknown');
    this.used = true;
    // Match the existing installer native acquisition budget; both Claude reads share this deadline.
    this.deadline = performance.now() + (process.platform === 'darwin' ? 60_000 : 30_000);
    const identity: RuntimeSourceNativeIdentity = { nativeVersion: cli.version };
    if (this.seed.provider === 'claude' && cli.executable.sha256 !== this.seed.executable.sha256) {
      identity.seedNativeVersion = await this.read(this.seed.executable);
      if (identity.seedNativeVersion !== cli.version)
        throw new RuntimeSourceAdmissionError('unqualified-version');
    }
    if ((await this.read(cli.executable)) !== cli.version)
      throw new RuntimeSourceAdmissionError('native-version-mismatch');
    return identity;
  }

  private async read(executable: { path: string; sha256: string }): Promise<string> {
    if (this.abort.signal.aborted || !this.isCurrent())
      throw new RuntimeSourceAdmissionError('native-outcome-unknown');
    const remaining = this.deadline - performance.now();
    if (remaining <= 0) throw new RuntimeSourceAdmissionError('native-outcome-unknown');
    const process = this.createProcess(
      {
        provider: this.seed.provider,
        cwd: this.seed.cwd,
        executable,
        environment: versionEnvironment(this.seed.environment),
        ...(this.seed.windowsBroker ? { windowsBroker: { ...this.seed.windowsBroker } } : {}),
      },
      () => !this.abort.signal.aborted && this.isCurrent(),
      this.processCustody
    );
    this.processes.add(process);
    const timer = setTimeout(() => this.abort.abort(), remaining);
    try {
      const child = process.launch({
        command: executable.path,
        args: ['--version'],
        cwd: this.seed.cwd,
        signal: this.abort.signal,
      });
      const raw = await new Promise<string>((resolve, reject) => {
        let output = '',
          bytes = 0,
          settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          this.abort.signal.removeEventListener('abort', aborted);
          if (error) reject(error);
          else resolve(output);
        };
        const aborted = () => finish(new RuntimeSourceAdmissionError('native-outcome-unknown'));
        this.abort.signal.addEventListener('abort', aborted, { once: true });
        const chunk = (value: Buffer | string, stdout: boolean) => {
          if (settled) return;
          bytes += Buffer.byteLength(value);
          if (bytes > 4096) {
            this.abort.abort();
            return;
          }
          if (stdout) output += value.toString();
        };
        child.stdout.on('data', (value: Buffer | string) => chunk(value, true));
        child.stderr.on('data', (value: Buffer | string) => chunk(value, false));
        child.once('error', () =>
          finish(new RuntimeSourceAdmissionError('native-outcome-unknown'))
        );
        child.once('close', (code: number | null) =>
          finish(code === 0 ? undefined : new RuntimeSourceAdmissionError('native-outcome-unknown'))
        );
        child.stdin.once('error', () =>
          finish(new RuntimeSourceAdmissionError('native-outcome-unknown'))
        );
        child.stdin.end();
        if (this.abort.signal.aborted) aborted();
      });
      if (!this.isCurrent()) throw new RuntimeSourceAdmissionError('native-outcome-unknown');
      return parseRuntimeSourceNativeVersion(this.seed.provider, raw);
    } finally {
      clearTimeout(timer);
    }
  }

  close(): Promise<boolean> {
    if (!this.closing) {
      this.abort.abort();
      const closing = Promise.all(
        [...this.processes].map(async (process) => {
          process.seal();
          try {
            return await process.confirmStopped();
          } catch {
            return false;
          }
        })
      ).then((values) => values.every(Boolean));
      this.closing = closing;
      void closing.then((clean) => {
        if (!clean && this.closing === closing) this.closing = undefined;
      });
    }
    return this.closing;
  }
}
