import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { electronTeamPort } from './opencode-native-team-port';
import { Cdp, waitFor } from './release-updater/cdp.mts';
import { serializedFunction } from './release-updater/serialized-function.mts';

const execute = promisify(execFile);
type Port = ReturnType<typeof electronTeamPort>;
type Operation = Exclude<keyof Port, 'progress' | 'dispose'>;
type Arguments<K extends Operation> = Parameters<Port[K]>;
type Result<K extends Operation> = Awaited<ReturnType<Port[K]>>;
interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}
interface RendererState {
  port: Port;
  calls: Record<string, { state: 'pending' | 'done' | 'failed'; result?: unknown }>;
}

/** Prepare before seeding explicit local TEST auth. No ambient credentials or
 * real projects are inherited. This host qualifies Electron integration only;
 * the scenario must independently assert files, tool effects and native stop.
 */
export async function prepareNativeDesktop() {
  // Match the live proof wrapper's short Darwin root policy for nested sockets.
  const parent = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
  const root = await realpath(await mkdtemp(path.join(parent, 'TEST-oc-')));
  const projectPath = path.join(root, 'TEST-project');
  const teamName = `test-opencode-${randomUUID()}`;
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'DISPLAY',
    'LANG',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const directories = {
    HOME: 'home',
    USERPROFILE: 'home',
    APPDATA: 'app-data',
    LOCALAPPDATA: 'local-data',
    XDG_CONFIG_HOME: 'config',
    XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache',
    XDG_STATE_HOME: 'state',
    XDG_RUNTIME_DIR: 'run',
    TMPDIR: 'tmp',
    TMP: 'tmp',
    TEMP: 'tmp',
    CLAUDE_CONFIG_DIR: 'claude-config',
    CLAUDE_MULTIMODEL_DATA_HOME: 'runtime-data',
    CLAUDE_MULTIMODEL_CACHE_HOME: 'runtime-cache',
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: 'user-data',
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: 'claude',
  };
  for (const [key, relative] of Object.entries(directories)) env[key] = path.join(root, relative);
  await Promise.all(
    [...new Set(Object.values(env).filter((value) => value?.startsWith(root)))].map((directory) =>
      mkdir(directory!, { recursive: true, mode: 0o700 })
    )
  );
  await mkdir(projectPath, { mode: 0o700 });
  await writeFile(path.join(projectPath, '.opencode-e2e-test-project'), teamName + '\n', {
    mode: 0o600,
  });
  env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  let launched = false;
  return {
    root,
    projectPath,
    teamName,
    env,
    async launch(executable: string) {
      assert(!launched, 'Do not repeat an uncertain Electron launch');
      assert(path.isAbsolute(executable), 'Packaged executable must be absolute');
      const selected = await realpath(executable);
      const resources =
        process.platform === 'darwin'
          ? path.resolve(path.dirname(selected), '..', 'Resources')
          : path.join(path.dirname(selected), 'resources');
      const rendererUrl = pathToFileURL(
        path.join(resources, 'app.asar', 'out', 'renderer', 'index.html')
      ).href;
      const reservation = createServer();
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const address = reservation.address();
      assert(address && typeof address !== 'string');
      const port = address.port;
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve()))
      );
      launched = true;
      const child = spawn(
        selected,
        [
          `--remote-debugging-port=${port}`,
          '--remote-debugging-address=127.0.0.1',
          `--user-data-dir=${env.AGENT_TEAMS_ELECTRON_USER_DATA_DIR}`,
        ],
        { env, cwd: root, stdio: 'ignore' }
      );
      let spawnFailure: Error | undefined;
      child.once('error', (error) => {
        spawnFailure = error;
      });
      let cdp: Cdp | undefined;
      try {
        const renderer = await waitFor(async () => {
          if (spawnFailure) throw new Error('Owned Electron spawn failed');
          assert(child.exitCode === null && child.signalCode === null, 'Owned Electron exited');
          assert(child.pid, 'Owned Electron PID required');
          if (!(await ownsListener(child.pid, port))) return null;
          let targets: Target[];
          try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
              signal: AbortSignal.timeout(2000),
              redirect: 'error',
            });
            if (!response.ok) return null;
            targets = (await response.json()) as Target[];
          } catch (error) {
            if (
              error instanceof TypeError ||
              (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
            )
              return null;
            throw error;
          }
          const matches = targets.filter(
            (target) =>
              target.type === 'page' && target.url === rendererUrl && target.webSocketDebuggerUrl
          );
          assert(matches.length <= 1, 'Ambiguous packaged renderer');
          return matches[0] ?? null;
        }, 'owned packaged Electron renderer');
        const inspector = new URL(renderer.webSocketDebuggerUrl!);
        assert.equal(inspector.hostname, '127.0.0.1');
        assert.equal(Number(inspector.port), port);
        cdp = await Cdp.connect(inspector.href);
        await waitFor(
          async () =>
            (await cdp!.evaluate<boolean>(
              'Boolean(window.electronAPI?.teams && window.electronAPI?.config)'
            )) || null,
          'normal preload API'
        );
        // This variable belongs only to this fresh renderer. No production hook.
        await cdp.evaluate(`window.__opencodeNativeProof = { port: ${serializedFunction(electronTeamPort)}(
          window.electronAPI, ${JSON.stringify(teamName)}, ${JSON.stringify(projectPath)}), calls: {} }; true`);
        return {
          pid: child.pid!,
          async call<K extends Operation>(operation: K, ...args: Arguments<K>): Promise<Result<K>> {
            const id = randomUUID();
            const start = (id: string, operation: Operation, args: unknown[]) => {
              const state = (window as unknown as { __opencodeNativeProof: RendererState })
                .__opencodeNativeProof;
              if (state.calls[id]) throw new Error('single IPC submission required');
              state.calls[id] = { state: 'pending' };
              Promise.resolve()
                .then(() => Reflect.apply(state.port[operation], state.port, args))
                .then((result) => {
                  state.calls[id] = { state: 'done', result };
                })
                // Do not copy provider error text across the boundary.
                .catch(() => {
                  state.calls[id] = { state: 'failed' };
                });
              return true;
            };
            await cdp!.evaluate(
              `${serializedFunction(start)}(${JSON.stringify(id)}, ${JSON.stringify(operation)}, ${JSON.stringify(args)})`
            );
            const completed = await waitFor(
              async () => {
                const entry = await cdp!.evaluate<{ state: string; result?: Result<K> }>(
                  `window.__opencodeNativeProof.calls[${JSON.stringify(id)}]`
                );
                assert(
                  entry.state !== 'failed',
                  `Owned ${operation} IPC failed; preserve TEST state`
                );
                return entry.state === 'done' ? { value: entry.result } : null;
              },
              `single ${operation} IPC result`,
              180_000
            );
            return completed.value as Result<K>;
          },
          async progress() {
            return cdp!.evaluate<Port['progress']>('window.__opencodeNativeProof.port.progress');
          },
          async close() {
            // The scenario must confirm native team cleanup before closing its app.
            const failures: unknown[] = [];
            try {
              await cdp!.evaluate('window.__opencodeNativeProof.port.dispose(); true');
            } catch (error) {
              failures.push(error);
            } finally {
              cdp!.close();
              try {
                await stopApp(child);
              } catch (error) {
                failures.push(error);
              }
            }
            if (failures.length) throw new AggregateError(failures, 'Owned app close failed');
          },
        };
      } catch (error) {
        cdp?.close();
        await stopApp(child);
        throw error;
      }
    },
  };
}

async function ownsListener(pid: number, port: number): Promise<boolean> {
  if (process.platform === 'win32') {
    const { stdout } = await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `@(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess | ConvertTo-Json -Compress`,
      ],
      { timeout: 5000, maxBuffer: 4096 }
    );
    if (!stdout.trim()) return false;
    const owners: number | number[] = JSON.parse(stdout);
    const rows = Array.isArray(owners) ? owners : [owners];
    assert(
      rows.every((owner) => owner === pid),
      'Foreign inspector listener'
    );
    return rows.length > 0;
  }
  assert.equal(
    process.platform,
    'darwin',
    'This host requires a native listener identity implementation'
  );
  try {
    const { stdout } = await execute(
      '/usr/sbin/lsof',
      ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp'],
      {
        timeout: 5000,
        maxBuffer: 4096,
      }
    );
    const owners = stdout
      .split('\n')
      .filter((line) => line.startsWith('p'))
      .map((line) => Number(line.slice(1)));
    assert(
      owners.every((owner) => owner === pid),
      'Foreign inspector listener'
    );
    return owners.length > 0;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1) return false;
    throw error;
  }
}

async function stopApp(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned app did not exit; preserve TEST state')),
          10_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
