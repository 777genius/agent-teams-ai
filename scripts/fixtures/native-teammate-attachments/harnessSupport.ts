import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { MemberLogSummary, TeamAgentRuntimeSnapshot } from '../../../src/shared/types/team.ts';

// @ts-expect-error Existing JavaScript CDP client has no declaration file.
import { CdpClient } from '../../e2e/comment-notification/cdp.mjs';

type Cdp = HarnessCdp;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface HarnessCdp {
  evaluate<T>(expression: string): Promise<T>;
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  waitFor(expression: string, label: string, timeoutMs?: number): Promise<void>;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
  on(method: string, listener: (params: unknown) => void): void;
}

export interface StructuredInputObservation {
  sourcePath: string;
  line?: number;
  recordType?: string;
  blockType?: string;
  argumentShape?: string;
  encoding?: 'base64' | 'utf8';
  mediaType?: string;
  sha256?: string;
  filePath?: string;
  messageIdObserved: boolean;
}

export interface CleanupApiResult {
  ok: boolean;
  value?: Json;
  error?: string;
}

export interface OwnedRuntimeProcessProof {
  memberName: string;
  pid: number;
  aliveBefore: boolean;
  aliveAfter: boolean;
  terminal: boolean;
}

export interface AppTerminationProof {
  pid?: number;
  terminated: boolean;
  error?: string;
}

export interface CleanupEvidence {
  teamAttempted: boolean;
  stop?: CleanupApiResult;
  delete?: CleanupApiResult;
  runtimeSnapshotAvailableBefore: boolean;
  ownedRuntimeProcesses: OwnedRuntimeProcessProof[];
  ownedRuntimeTerminal: boolean;
  app: AppTerminationProof;
  project: 'kept' | 'removed' | 'remove-failed';
  errors: string[];
}

const RETURNED_PROVIDER_PATH_KEYS = new Set([
  'filePath',
  'logPath',
  'sessionPath',
  'threadPath',
  'turnPath',
  'transcriptPath',
]);

function literal(value: unknown): string {
  return JSON.stringify(value);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function terminateOwnedApp(child: ChildProcess): Promise<AppTerminationProof> {
  if (!child.pid) return { terminated: child.exitCode !== null };
  const pid = child.pid;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      return { pid, terminated: false, error: String(error) };
    }
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) return { pid, terminated: true };
    await delay(100);
  }
  return { pid, terminated: false, error: 'owned dev:mcp process remained alive after SIGTERM' };
}

export function collectReturnedProviderPaths(
  logs: readonly MemberLogSummary[],
  nativeState: unknown
): string[] {
  const result = new Set<string>();
  const walk = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, key);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, childKey);
      }
      return;
    }
    if (typeof value === 'string' && key && RETURNED_PROVIDER_PATH_KEYS.has(key)) {
      result.add(path.resolve(value));
    }
  };
  walk(logs);
  walk(nativeState);
  return [...result];
}

export async function collectStructuredInput(
  sourcePaths: readonly string[],
  expectedDigests: ReadonlySet<string>,
  expectedPaths: ReadonlySet<string>,
  messageId: string
): Promise<StructuredInputObservation[]> {
  const candidatePaths = new Set(sourcePaths.map((sourcePath) => path.resolve(sourcePath)));
  const observations: StructuredInputObservation[] = [];
  const localImageCandidates: Array<{
    sourcePath: string;
    line?: number;
    recordRaw: string;
    filePath: string;
  }> = [];
  for (const sourcePath of candidatePaths) {
    let raw: string;
    try {
      const info = await stat(sourcePath);
      if (!info.isFile() || info.size > 20 * 1024 * 1024) continue;
      raw = await readFile(sourcePath, 'utf8');
    } catch {
      continue;
    }
    const records: Array<{ raw: string; value: Json; line?: number }> = [];
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      try {
        records.push({ raw: lines[index], value: JSON.parse(lines[index]), line: index + 1 });
      } catch {
        /* Non-JSON log line. */
      }
    }
    if (records.length === 0) {
      try {
        records.push({ raw, value: JSON.parse(raw) });
      } catch {
        continue;
      }
    }
    const walk = (value: Json, recordRaw: string, line?: number, keyPath = ''): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, recordRaw, line, `${keyPath}[${index}]`));
        return;
      }
      if (!value || typeof value !== 'object') return;
      const object = value as Record<string, Json>;
      const source = object.source as Record<string, Json> | undefined;
      const blockType = typeof object.type === 'string' ? object.type : undefined;
      if (
        source &&
        typeof object.type === 'string' &&
        (object.type === 'image' || object.type === 'document') &&
        typeof source.data === 'string' &&
        (source.type === 'base64' || source.type === 'text')
      ) {
        const bytes =
          source.type === 'base64'
            ? Buffer.from(source.data, 'base64')
            : Buffer.from(source.data, 'utf8');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (expectedDigests.has(sha256)) {
          observations.push({
            sourcePath,
            line,
            recordType: source.type === 'text' ? 'claude_utf8_text' : 'claude_base64_content',
            blockType,
            encoding: source.type === 'text' ? 'utf8' : 'base64',
            mediaType: typeof source.media_type === 'string' ? source.media_type : undefined,
            sha256,
            messageIdObserved: recordRaw.includes(messageId),
          });
        }
      }
      if (
        object.type === 'text' &&
        typeof object.text === 'string' &&
        object.text.startsWith('Attached file: ') &&
        recordRaw.includes(messageId)
      ) {
        const separator = object.text.indexOf('\n\n');
        if (separator >= 0) {
          const sha256 = createHash('sha256')
            .update(object.text.slice(separator + 2), 'utf8')
            .digest('hex');
          if (expectedDigests.has(sha256))
            observations.push({
              sourcePath,
              line,
              recordType: 'codex_utf8_text',
              blockType: 'text',
              encoding: 'utf8',
              mediaType: 'text/plain',
              sha256,
              messageIdObserved: true,
            });
        }
      }
      if (object.type === 'localImage' && typeof object.path === 'string') {
        const filePath = path.resolve(object.path);
        if (expectedPaths.has(filePath)) {
          localImageCandidates.push({ sourcePath, line, recordRaw, filePath });
        }
      }
      for (const [key, child] of Object.entries(object)) {
        walk(child, recordRaw, line, keyPath ? `${keyPath}.${key}` : key);
      }
    };
    for (const record of records) walk(record.value, record.raw, record.line);
  }
  for (const candidate of localImageCandidates) {
    try {
      const info = await stat(candidate.filePath);
      if (!info.isFile() || info.size > 20 * 1024 * 1024) continue;
      const sha256 = createHash('sha256')
        .update(await readFile(candidate.filePath))
        .digest('hex');
      if (!expectedDigests.has(sha256)) continue;
      observations.push({
        sourcePath: candidate.sourcePath,
        line: candidate.line,
        recordType: 'codex_turn_start_localImage',
        blockType: 'localImage',
        argumentShape: '{type:localImage,path}',
        sha256,
        filePath: candidate.filePath,
        messageIdObserved: candidate.recordRaw.includes(messageId),
      });
    } catch {
      /* Missing or changed run-owned provider input remains unobserved and fails proof. */
    }
  }
  return observations;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function ownedRuntimeProcesses(
  snapshot: TeamAgentRuntimeSnapshot | null
): Array<{ memberName: string; pid: number }> {
  if (!snapshot) return [];
  return Object.entries(snapshot.members)
    .map(([memberName, member]) => ({
      memberName,
      pid: member.runtimePid ?? member.pid,
    }))
    .filter((item): item is { memberName: string; pid: number } => Boolean(item.pid));
}

export async function callTeamCleanup(
  cdp: HarnessCdp,
  method: 'stop' | 'deleteTeam',
  team: string
): Promise<CleanupApiResult> {
  try {
    const value = await cdp.evaluate<Json | undefined>(
      `window.electronAPI.teams.${method}(${literal(team)})`
    );
    return value === undefined ? { ok: true } : { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.stack : String(error) };
  }
}

export async function startOwnedDesktopApp(
  args: { runtimeSource: string },
  repoRoot: string,
  runRoot: string,
  tmpRoot: string,
  bounded: typeof import('./harnessProof.ts').bounded
): Promise<{
  child: ChildProcess;
  logs: string[];
  env: NodeJS.ProcessEnv;
  port: number;
  cdp: Cdp;
}> {
  const runtimeSource = await realpath(args.runtimeSource);
  const original = { ...process.env };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: path.join(runRoot, 'user-data'),
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: runtimeSource,
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    TMPDIR: tmpRoot,
    npm_config_cache: path.join(runRoot, 'npm-cache'),
    ELECTRON_CACHE: path.join(runRoot, 'electron-cache'),
  };
  await Promise.all(
    [
      env.AGENT_TEAMS_ELECTRON_USER_DATA_DIR!,
      env.TMPDIR!,
      env.npm_config_cache!,
      env.ELECTRON_CACHE!,
    ].map((dir) => mkdir(dir, { recursive: true }))
  );
  if (process.platform === 'darwin') {
    for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'AGENT_TEAMS_ELECTRON_CLAUDE_ROOT'] as const) {
      assert.equal(env[key], original[key], `macOS auth root ${key} must remain unchanged`);
    }
    assert(
      !Object.hasOwn(env, 'CLAUDE_CONFIG_DIR') ||
        env.CLAUDE_CONFIG_DIR === original.CLAUDE_CONFIG_DIR
    );
  }
  const child = spawn('pnpm', ['dev:mcp'], {
    cwd: repoRoot,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      logs.push(chunk.toString());
      if (logs.length > 400) logs.shift();
    });
  }
  let renderer: { port: number; cdp: Cdp } | null = null;
  try {
    renderer = await bounded<{ port: number; cdp: Cdp }>('owned dev:mcp CDP endpoint', async () => {
      if (child.exitCode !== null) throw new Error(`Owned dev:mcp exited ${child.exitCode}`);
      const match = logs
        .join('')
        .match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//);
      if (!match) return null;
      const targets = (await fetch(`http://127.0.0.1:${match[1]}/json/list`).then((response) =>
        response.json()
      )) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      for (const target of targets.filter((item) => item.type === 'page')) {
        const cdp = (await CdpClient.connect(target.webSocketDebuggerUrl)) as Cdp;
        try {
          if (
            await cdp.evaluate<boolean>(
              'Boolean(window.electronAPI?.teams && window.__agentTeamsDevStore)'
            )
          ) {
            return { port: Number(match[1]), cdp };
          }
        } finally {
          if (
            !(await cdp
              .evaluate<boolean>(
                'Boolean(window.electronAPI?.teams && window.__agentTeamsDevStore)'
              )
              .catch(() => false))
          ) {
            await cdp.close().catch(() => undefined);
          }
        }
      }
      return null;
    });
    assert(renderer, 'Owned renderer was not selected');
    await renderer.cdp.send('Runtime.enable');
    await renderer.cdp.send('Page.enable');
    await bounded(
      'desktop API',
      () =>
        renderer!.cdp.evaluate<boolean>(
          'Boolean(window.electronAPI?.teams && window.__agentTeamsDevStore)'
        ),
      60_000
    );
    await bounded(
      'desktop startup',
      () =>
        renderer!.cdp.evaluate<boolean>(
          '(async () => Boolean((await window.electronAPI.startup.getStatus()).ready))()'
        ),
      60_000
    );
    return { child, logs, env, port: renderer.port, cdp: renderer.cdp };
  } catch (error) {
    const cleanupErrors: Error[] = [];
    await renderer?.cdp.close().catch((cleanupError) => {
      cleanupErrors.push(new Error(`startup CDP cleanup failed: ${String(cleanupError)}`));
    });
    const appCleanup = await terminateOwnedApp(child);
    if (!appCleanup.terminated) {
      cleanupErrors.push(
        new Error(`startup app cleanup failed: ${appCleanup.error ?? 'unknown error'}`)
      );
    }
    await writeFile(path.join(runRoot, 'evidence', 'app.log'), logs.join('')).catch((logError) => {
      cleanupErrors.push(new Error(`startup app log write failed: ${String(logError)}`));
    });
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Owned desktop startup and cleanup both failed'
      );
    }
    throw error;
  }
}
