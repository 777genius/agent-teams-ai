import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildEnrichedEnv } from '@main/utils/cliEnv';

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
  socketName?: string;
}

export interface RuntimeProcessTableRow {
  pid: number;
  ppid: number;
  command: string;
  cpuPercent?: number;
  rssBytes?: number;
}

/**
 * Short-lived cache window for the global process table.
 *
 * `listRuntimeProcesses` spawns a full `ps -ax`, which is expensive when forked
 * from the large Electron main process. Runtime liveness/telemetry callers fire
 * very frequently (every team file change invalidates their per-team snapshot
 * caches), so without throttling here the main process spawns `ps` dozens of
 * times per second while a team runs. Those callers already tolerate ~2s
 * staleness via their own snapshot caches, and the OS process table changes
 * negligibly within a second, so a 1s window collapses the spawn storm without
 * affecting liveness correctness.
 */
const RUNTIME_PROCESS_TABLE_CACHE_TTL_MS = 1_000;

interface RuntimeProcessTableCacheEntry {
  rows: RuntimeProcessTableRow[];
  expiresAtMs: number;
}

export function parseRuntimeProcessTable(output: string): RuntimeProcessTableRow[] {
  const rows: RuntimeProcessTableRow[] = [];
  for (const line of output.split('\n')) {
    const enrichedMatch = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (enrichedMatch) {
      const pid = Number.parseInt(enrichedMatch[1], 10);
      const ppid = Number.parseInt(enrichedMatch[2], 10);
      // `ps` formats the %cpu column with the locale decimal separator (e.g. "12,5" on
      // de_DE/fr_FR locales, which the runtime inherits via process.env). Normalize the
      // comma to a dot so Number() does not return NaN — otherwise the enriched parse would
      // fail its isFinite guard and fall back to the basic parser, leaking the pcpu/rss
      // columns into `command`.
      const cpuPercent = Number(enrichedMatch[3]?.replace(',', '.'));
      const rssKb = Number(enrichedMatch[4]?.replace(',', '.'));
      const command = enrichedMatch[5]?.trim() ?? '';
      if (
        Number.isFinite(pid) &&
        pid > 0 &&
        Number.isFinite(ppid) &&
        ppid >= 0 &&
        Number.isFinite(cpuPercent) &&
        cpuPercent >= 0 &&
        Number.isFinite(rssKb) &&
        rssKb >= 0 &&
        command.length > 0
      ) {
        rows.push({ pid, ppid, command, cpuPercent, rssBytes: Math.round(rssKb * 1024) });
        continue;
      }
    }

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
  #runtimeProcessTableCache: RuntimeProcessTableCacheEntry | null = null;
  #runtimeProcessTableInFlight: Promise<RuntimeProcessTableRow[]> | null = null;

  constructor(
    wslService = new TmuxWslService(),
    packageManagerResolver = new TmuxPackageManagerResolver()
  ) {
    this.#wslService = wslService;
    this.#packageManagerResolver = packageManagerResolver;
  }

  async execTmux(args: string[], timeout = 5_000, socketName?: string): Promise<ExecResult> {
    const effectiveArgs = socketName ? ['-L', socketName, ...args] : args;
    if (process.platform === 'win32') {
      return this.#wslService.execTmux(effectiveArgs, null, timeout);
    }

    const env = buildEnrichedEnv();
    const executable = await this.#resolveNativeTmuxExecutable(env);
    return new Promise((resolve) => {
      execFile(executable, effectiveArgs, { env, timeout }, (error, stdout, stderr) => {
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
    const candidates = await this.#getTmuxSocketCandidates();
    let lastError = '';
    for (const socketName of candidates) {
      const result = await this.execTmux(['kill-pane', '-t', paneId], 3_000, socketName);
      if (result.exitCode === 0) {
        return;
      }
      lastError = result.stderr || `Failed to kill tmux pane ${paneId}`;
    }
    throw new Error(lastError || `Failed to kill tmux pane ${paneId}`);
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

    const wanted = new Set(normalizedPaneIds);
    const paneInfoById = new Map<string, TmuxPaneRuntimeInfo>();
    const candidates = await this.#getTmuxSocketCandidates();
    let sawSuccessfulList = false;
    let lastError = '';

    for (const socketName of candidates) {
      const result = await this.execTmux(['list-panes', '-a', '-F', format], 3_000, socketName);
      if (result.exitCode !== 0) {
        lastError = result.stderr || 'Failed to list tmux panes';
        continue;
      }
      sawSuccessfulList = true;
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
        if (!wanted.has(normalizedPaneId) || paneInfoById.has(normalizedPaneId)) continue;
        const pid = Number.parseInt(rawPid.trim(), 10);
        if (Number.isFinite(pid) && pid > 0) {
          paneInfoById.set(normalizedPaneId, {
            paneId: normalizedPaneId,
            panePid: pid,
            currentCommand: currentCommand.trim() || undefined,
            currentPath: currentPath.trim() || undefined,
            sessionName: sessionName.trim() || undefined,
            windowName: windowName.trim() || undefined,
            ...(socketName ? { socketName } : {}),
          });
        }
      }
    }
    if (!sawSuccessfulList) {
      throw new Error(lastError || 'Failed to list tmux panes');
    }
    return paneInfoById;
  }

  async listPanePids(paneIds: readonly string[]): Promise<Map<string, number>> {
    const info = await this.listPaneRuntimeInfo(paneIds);
    return new Map([...info.entries()].map(([paneId, pane]) => [paneId, pane.panePid]));
  }

  async listRuntimeProcesses(): Promise<RuntimeProcessTableRow[]> {
    const cached = this.#runtimeProcessTableCache;
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.rows;
    }
    if (this.#runtimeProcessTableInFlight) {
      return this.#runtimeProcessTableInFlight;
    }
    const request = this.#readRuntimeProcessesUncached()
      .then((rows) => {
        this.#runtimeProcessTableCache = {
          rows,
          expiresAtMs: Date.now() + RUNTIME_PROCESS_TABLE_CACHE_TTL_MS,
        };
        return rows;
      })
      .finally(() => {
        if (this.#runtimeProcessTableInFlight === request) {
          this.#runtimeProcessTableInFlight = null;
        }
      });
    this.#runtimeProcessTableInFlight = request;
    return request;
  }

  async #readRuntimeProcessesUncached(): Promise<RuntimeProcessTableRow[]> {
    const result =
      process.platform === 'win32'
        ? await this.#wslService.execInPreferredDistro([
            'ps',
            '-ax',
            '-o',
            'pid=,ppid=,pcpu=,rss=,command=',
          ])
        : await this.#execNativePs();
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'Failed to list runtime processes');
    }
    return parseRuntimeProcessTable(result.stdout);
  }

  async sendKeysToPane(paneId: string, command: string): Promise<void> {
    const paneInfo = await this.listPaneRuntimeInfo([paneId]);
    const socketName = paneInfo.get(paneId)?.socketName;
    const result = await this.execTmux(
      ['send-keys', '-t', paneId, command, 'Enter'],
      3_000,
      socketName
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to send command to tmux pane ${paneId}`);
    }
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

    const candidates = this.#getTmuxSocketCandidatesSync();
    let lastError: Error | null = null;
    for (const socketName of candidates) {
      try {
        execFileSync(
          // eslint-disable-next-line sonarjs/no-os-command-from-path -- tmux is resolved during runtime readiness checks before this sync cleanup path is used
          'tmux',
          [...(socketName ? ['-L', socketName] : []), 'kill-pane', '-t', paneId],
          {
            stdio: 'ignore',
          }
        );
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error(`Failed to kill tmux pane ${paneId}`);
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
    return new Promise((resolve) => {
      execFile(
        'ps',
        ['-ax', '-o', 'pid=,ppid=,pcpu=,rss=,command='],
        { env: process.env, timeout: 3_000, maxBuffer: 2 * 1024 * 1024 },
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

  async #getTmuxSocketCandidates(): Promise<(string | undefined)[]> {
    if (process.platform === 'win32') {
      return [undefined];
    }
    return [...(await this.#listNativeSwarmSocketNames()), undefined];
  }

  #getTmuxSocketCandidatesSync(): (string | undefined)[] {
    if (process.platform === 'win32') {
      return [undefined];
    }
    return [...this.#listNativeSwarmSocketNamesSync(), undefined];
  }

  async #listNativeSwarmSocketNames(): Promise<string[]> {
    const dirs = this.#getNativeTmuxSocketDirs();
    const names = new Set<string>();
    await Promise.all(
      dirs.map(async (dir) => {
        let entries: string[];
        try {
          entries = await fs.promises.readdir(dir);
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.startsWith('claude-swarm-')) {
            names.add(entry);
          }
        }
      })
    );
    return [...names].sort((left, right) => left.localeCompare(right));
  }

  #listNativeSwarmSocketNamesSync(): string[] {
    const names = new Set<string>();
    for (const dir of this.#getNativeTmuxSocketDirs()) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.startsWith('claude-swarm-')) {
          names.add(entry);
        }
      }
    }
    return [...names].sort((left, right) => left.localeCompare(right));
  }

  #getNativeTmuxSocketDirs(): string[] {
    const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
    const candidates = [
      path.join('/tmp', `tmux-${uid}`),
      path.join('/private/tmp', `tmux-${uid}`),
      path.join(os.tmpdir(), `tmux-${uid}`),
    ];
    return [...new Set(candidates)];
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
