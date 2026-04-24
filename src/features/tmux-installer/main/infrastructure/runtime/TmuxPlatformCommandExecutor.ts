import { execFile, execFileSync } from 'node:child_process';

import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';

import { TmuxPackageManagerResolver } from '../platform/TmuxPackageManagerResolver';
import { TmuxWslService } from '../wsl/TmuxWslService';

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TmuxPaneRuntimeInfo {
  paneId: string;
  panePid: number;
  currentCommand?: string;
  currentPath?: string;
  sessionName?: string;
  windowName?: string;
}

export interface RuntimeProcessTableRow {
  pid: number;
  ppid: number;
  command: string;
}

export function parseRuntimeProcessTable(output: string): RuntimeProcessTableRow[] {
  const rows: RuntimeProcessTableRow[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;

    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const command = match[3]?.trim() ?? '';
    if (
      Number.isFinite(pid) &&
      pid > 0 &&
      Number.isFinite(ppid) &&
      ppid >= 0 &&
      command.length > 0
    ) {
      rows.push({ pid, ppid, command });
    }
  }
  return rows;
}

export class TmuxPlatformCommandExecutor {
  readonly #wslService: TmuxWslService;
  readonly #packageManagerResolver: TmuxPackageManagerResolver;

  constructor(
    wslService = new TmuxWslService(),
    packageManagerResolver = new TmuxPackageManagerResolver()
  ) {
    this.#wslService = wslService;
    this.#packageManagerResolver = packageManagerResolver;
  }

  async execTmux(args: string[], timeout = 5_000): Promise<ExecResult> {
    if (process.platform === 'win32') {
      return this.#wslService.execTmux(args, null, timeout);
    }

    await resolveInteractiveShellEnv();
    const env = buildEnrichedEnv();
    const executable = await this.#resolveNativeTmuxExecutable(env);
    return new Promise((resolve) => {
      execFile(executable, args, { env, timeout }, (error, stdout, stderr) => {
        const errorCode =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as NodeJS.ErrnoException).code
            : undefined;
        resolve({
          exitCode: typeof errorCode === 'number' ? errorCode : error ? 1 : 0,
          stdout: String(stdout),
          stderr: String(stderr) || (error instanceof Error ? error.message : ''),
        });
      });
    });
  }

  async killPane(paneId: string): Promise<void> {
    const result = await this.execTmux(['kill-pane', '-t', paneId], 3_000);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to kill tmux pane ${paneId}`);
    }
  }

  async listPaneRuntimeInfo(paneIds: readonly string[]): Promise<Map<string, TmuxPaneRuntimeInfo>> {
    const normalizedPaneIds = [...new Set(paneIds.map((paneId) => paneId.trim()).filter(Boolean))];
    if (normalizedPaneIds.length === 0) {
      return new Map();
    }

    const format = [
      '#{pane_id}',
      '#{pane_pid}',
      '#{pane_current_command}',
      '#{pane_current_path}',
      '#{session_name}',
      '#{window_name}',
    ].join('\t');

    const result = await this.execTmux(['list-panes', '-a', '-F', format], 3_000);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'Failed to list tmux panes');
    }

    const wanted = new Set(normalizedPaneIds);
    const paneInfoById = new Map<string, TmuxPaneRuntimeInfo>();
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [
        paneId = '',
        rawPid = '',
        currentCommand = '',
        currentPath = '',
        sessionName = '',
        windowName = '',
      ] = trimmed.split('\t');
      const normalizedPaneId = paneId.trim();
      if (!wanted.has(normalizedPaneId)) continue;
      const pid = Number.parseInt(rawPid.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        paneInfoById.set(normalizedPaneId, {
          paneId: normalizedPaneId,
          panePid: pid,
          currentCommand: currentCommand.trim() || undefined,
          currentPath: currentPath.trim() || undefined,
          sessionName: sessionName.trim() || undefined,
          windowName: windowName.trim() || undefined,
        });
      }
    }
    return paneInfoById;
  }

  async listPanePids(paneIds: readonly string[]): Promise<Map<string, number>> {
    const info = await this.listPaneRuntimeInfo(paneIds);
    return new Map([...info.entries()].map(([paneId, pane]) => [paneId, pane.panePid]));
  }

  async listRuntimeProcesses(): Promise<RuntimeProcessTableRow[]> {
    const result =
      process.platform === 'win32'
        ? await this.#wslService.execInPreferredDistro(['ps', '-ax', '-o', 'pid=,ppid=,command='])
        : await this.#execNativePs();
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'Failed to list runtime processes');
    }
    return parseRuntimeProcessTable(result.stdout);
  }

  killPaneSync(paneId: string): void {
    if (process.platform === 'win32') {
      const preferredDistro = this.#wslService.getPersistedPreferredDistroSync();
      const candidates = this.#getWslExecutableCandidates();
      let lastError: Error | null = null;
      const distroAttempts = preferredDistro ? [preferredDistro, null] : [null];
      for (const distroName of distroAttempts) {
        for (const executable of candidates) {
          try {
            execFileSync(
              executable,
              [...(distroName ? ['-d', distroName] : []), '-e', 'tmux', 'kill-pane', '-t', paneId],
              {
                stdio: 'ignore',
                windowsHide: true,
              }
            );
            return;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
          }
        }
      }
      throw lastError ?? new Error(`Failed to kill tmux pane ${paneId}`);
    }

    // eslint-disable-next-line sonarjs/no-os-command-from-path -- tmux is resolved during runtime readiness checks before this sync cleanup path is used
    execFileSync('tmux', ['kill-pane', '-t', paneId], { stdio: 'ignore' });
  }

  #getWslExecutableCandidates(): string[] {
    const candidates = new Set<string>();
    const windir = process.env.WINDIR;
    if (windir) {
      candidates.add(`${windir}\\System32\\wsl.exe`);
      candidates.add(`${windir}\\Sysnative\\wsl.exe`);
    }
    candidates.add('wsl.exe');
    return [...candidates];
  }

  async #execNativePs(): Promise<ExecResult> {
    await resolveInteractiveShellEnv();
    const env = buildEnrichedEnv();
    return new Promise((resolve) => {
      execFile(
        'ps',
        ['-ax', '-o', 'pid=,ppid=,command='],
        { env, timeout: 3_000, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const errorCode =
            typeof error === 'object' && error !== null && 'code' in error
              ? (error as NodeJS.ErrnoException).code
              : undefined;
          resolve({
            exitCode: typeof errorCode === 'number' ? errorCode : error ? 1 : 0,
            stdout: String(stdout),
            stderr: String(stderr) || (error instanceof Error ? error.message : ''),
          });
        }
      );
    });
  }

  async #resolveNativeTmuxExecutable(env: NodeJS.ProcessEnv): Promise<string> {
    const platform =
      process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
        ? process.platform
        : 'unknown';
    const executable = await this.#packageManagerResolver.resolveTmuxBinary(env, platform);
    if (!executable) {
      throw new Error('tmux executable could not be resolved for the current platform.');
    }
    return executable;
  }
}
