import { StringDecoder } from 'node:string_decoder';
import {
  CapturedProcess,
  type CapturedProcessPort,
} from '../adapters/providers/CapturedProcess.js';
import type { ExtensionRootSelection } from '../management/captureExtensionRoots.js';
import { captureNativeExtensionTarget } from './captureNativeExtensionTarget.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import {
  claudeManagementProfileSchema,
  type ClaudeManagementProfile,
} from '../management/profile.js';

import { compileNativeExtensionCommand } from './nativeCommands.js';

/** One admitted extension mutation, pinned to the original profile/root and owned process handles. */
export class NativeExtensionProcess {
  private readonly profile: ClaudeManagementProfile;
  private readonly selection: ExtensionRootSelection;
  private readonly roots: ReturnType<typeof captureNativeExtensionTarget>;
  private readonly process: CapturedProcessPort;
  private readonly abort = new AbortController();
  private started = false;
  private sealed = false;
  private closing?: Promise<boolean>;

  constructor(
    profile: ClaudeManagementProfile,
    selection: ExtensionRootSelection,
    private readonly assertOwner: () => void,
    createProcess = (
      selected: ClaudeManagementProfile,
      current: () => boolean
    ): CapturedProcessPort => new CapturedProcess(selected, current)
  ) {
    this.profile = structuredClone(claudeManagementProfileSchema.parse(profile));
    this.selection = structuredClone(selection);
    this.roots = captureNativeExtensionTarget(this.profile, this.selection, this.assertOwner);
    if (this.selection.panel === 'skills') throw new ManagementCommandError('invalid');
    this.process = createProcess(this.profile, () => this.current());
  }

  get targetId(): string {
    return this.roots.targetId;
  }

  private current(): boolean {
    try {
      if (this.sealed) return false;
      this.roots.assertCurrent();
      return true;
    } catch {
      return false;
    }
  }

  async run(
    targetId: string,
    raw: unknown
  ): Promise<{ ok: boolean; settled: boolean; completed?: boolean }> {
    const command = compileNativeExtensionCommand(raw);
    if (
      this.started ||
      !this.current() ||
      targetId !== this.targetId ||
      command.panel !== this.selection.panel ||
      command.requestedScope !== this.selection.scope
    )
      throw new ManagementCommandError('conflict');
    return this.execute(command.args, command.timeoutMs, false);
  }

  async diagnose(
    targetId: string
  ): Promise<{ ok: boolean; settled: boolean; output?: string; completed?: boolean }> {
    if (
      this.started ||
      !this.current() ||
      targetId !== this.targetId ||
      this.selection.panel !== 'mcp'
    )
      throw new ManagementCommandError('conflict');
    return this.execute(['mcp', 'list'], 60_000, true);
  }

  private async execute(
    args: readonly string[],
    timeoutMs: number,
    captureOutput: boolean
  ): Promise<{ ok: boolean; settled: boolean; output?: string; completed?: boolean }> {
    this.started = true;
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]);
    let ok = false,
      knownFailure = false,
      output = '',
      byteCount = 0;
    const decoder = new StringDecoder('utf8');
    try {
      if (!this.current()) throw new ManagementCommandError('held');
      const child = this.process.launch({
        command: this.profile.executable.path,
        args: [...args],
        cwd: this.profile.cwd,
        signal,
      });
      // Raw native output remains private; mutation output is discarded entirely.
      if (captureOutput)
        child.stdout.on('data', (chunk: Buffer | string) => {
          byteCount += Buffer.byteLength(chunk);
          if (byteCount > 1024 * 1024) {
            this.abort.abort();
            return;
          }
          output += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        });
      else child.stdout.resume();
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      output += decoder.end();
      const observed = code !== null && this.current() && !signal.aborted;
      ok = code === 0 && observed;
      knownFailure = code !== 0 && observed;
    } catch {
      /* The caller retains its original target and command; no fallback process. */
    }
    const settled = await this.close().catch(() => false);
    return {
      ok: ok && settled,
      settled,
      ...(knownFailure && settled ? { completed: true } : {}),
      ...(captureOutput && ok && settled ? { output } : {}),
    };
  }

  close(): Promise<boolean> {
    if (this.closing) return this.closing;
    this.sealed = true;
    this.abort.abort();
    this.process.seal();
    this.closing = this.process.confirmStopped();
    return this.closing;
  }
}
