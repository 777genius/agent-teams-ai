import { createHash, randomBytes } from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapturedProcess } from './CapturedProcess.js';
import { createWindowsJobCustody } from './WindowsJobCustody.js';
import {
  verifyOpenCodeV2EmbeddedGraph,
  verifyOpenCodeV2EmbeddedManifest,
} from './OpenCodeV2EmbeddedGraph.js';

import type { ObservableNativeProcess } from '../../owned-process/processFacade.js';
import type { CapturedProcessProfile, CapturedProcessTreeSource } from './CapturedProcess.js';
import type { OpenCodeV2EmbeddedSelection } from './OpenCodeV2EmbeddedGraph.js';
import type {
  RegistrarBinding,
  RegisteredProcessRootSource,
} from '../../process/registeredProcessContracts.js';

const fail = (): never => {
  throw new Error('OpenCode V2 embedded server unavailable');
};
const environmentKeys = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'WINDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'NO_COLOR',
  'CI',
]);

export interface OpenCodeV2EmbeddedServerOptions {
  profile: CapturedProcessProfile;
  embedded: OpenCodeV2EmbeddedSelection;
  databasePath: string;
  configDirectory: string;
  config: Readonly<Record<string, unknown>>;
  canAllocate(): boolean;
  canCaptureRegisteredProcess?(): boolean;
  processCustody?: RegisteredProcessRootSource;
  startupTimeoutMs?: number;
  endpoint?: string;
}
export interface OpenCodeV2EmbeddedReady {
  endpoint: string;
  pid: number;
  startIdentity: string;
}
interface NativeCustody {
  executablePath: string;
  executableSha256: string;
  pid: number;
  startIdentity: string;
  version: '2.1.4';
}

async function linuxBirth(pid: number): Promise<string> {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
  const end = raw.lastIndexOf(') ');
  if (end < 0) return fail();
  const fields = raw
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (
    fields[0] === 'Z' ||
    !/^\d+$/.test(fields[19] ?? '') ||
    Number(fields[2]) !== pid ||
    Number(fields[3]) !== pid
  )
    return fail();
  return `${pid}:${fields[19]}`;
}

/**
 * Keep this handle before awaiting start. Startup failure or uncertain cleanup
 * retains the same original CapturedProcess; there is no process/PID adoption.
 */
export function createOpenCodeV2EmbeddedServer(options: OpenCodeV2EmbeddedServerOptions) {
  // Darwin additionally requires the selected packaged native custody artifact;
  // absence cannot fall back to a path/PID-only executable observation.
  const readDarwinExecutable = options.processCustody?.readRootExecutable?.bind(
    options.processCustody
  );
  if (
    options.profile.provider !== 'opencode' ||
    (process.platform !== 'linux' &&
      process.platform !== 'win32' &&
      (process.platform !== 'darwin' || !readDarwinExecutable))
  )
    return fail();
  const profile = structuredClone(options.profile);
  const embedded = structuredClone(options.embedded);
  const config = structuredClone(options.config);
  const configDirectory = options.configDirectory;
  const databasePath = options.databasePath;
  const startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
  const requestedEndpoint = options.endpoint;
  if (
    requestedEndpoint !== undefined &&
    (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(requestedEndpoint) ||
      Number(new URL(requestedEndpoint).port) > 65535)
  )
    return fail();
  const port = requestedEndpoint === undefined ? 0 : Number(new URL(requestedEndpoint).port);
  if (config.plugin !== undefined) return fail();
  profile.environment = Object.fromEntries(
    Object.entries(profile.environment).filter(([key]) => environmentKeys.has(key))
  );
  // Native 2.1.4 migrates every Global.data/auth.json entry when creating a DB.
  // Keep that source inside this owned DB namespace. Host imports only its
  // captured selected key through the finite native credential mechanism.
  profile.environment.XDG_DATA_HOME = path.dirname(databasePath);
  profile.environment.XDG_CONFIG_HOME = configDirectory;
  if (!profile.environment.HOME) return fail();
  let windowsCustody: CapturedProcessTreeSource | undefined;
  const custody = new CapturedProcess(
    profile,
    options.canAllocate,
    options.processCustody,
    options.canCaptureRegisteredProcess ?? options.canAllocate,
    process.platform === 'win32'
      ? {
          capture(child, executable) {
            if (!windowsCustody) return fail();
            return windowsCustody.capture(child, executable);
          },
        }
      : undefined
  );
  const password = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('hex');
  const lifecycle = new AbortController();
  let child: ObservableNativeProcess | undefined;
  let ready: OpenCodeV2EmbeddedReady | undefined;
  let readyChild: ObservableNativeProcess | undefined;
  let starting: Promise<OpenCodeV2EmbeddedReady> | undefined;
  let stopping: Promise<boolean> | undefined;
  const alive = () =>
    child?.pid !== undefined && child.exitCode === null && child.signalCode === null;

  async function measure(signal: AbortSignal): Promise<NativeCustody> {
    signal.throwIfAborted();
    if (!child?.pid || !alive()) return fail();
    const pid = child.pid;
    if (process.platform === 'darwin' || process.platform === 'win32') {
      await verifyOpenCodeV2EmbeddedManifest(embedded);
      // Darwin custody consumes the real original Node child, never a broker IO facade.
      if (process.platform === 'darwin' && !(child instanceof ChildProcess)) return fail();
      const actual =
        process.platform === 'darwin' && child instanceof ChildProcess
          ? readDarwinExecutable!(child, profile.executable)
          : custody.readNativeExecutable(child);
      if (
        actual.pid !== pid ||
        actual.executablePath !== profile.executable.path ||
        actual.executableSha256 !== profile.executable.sha256 ||
        !alive() ||
        (ready && (ready.pid !== pid || ready.startIdentity !== actual.startIdentity))
      )
        return fail();
      signal.throwIfAborted();
      return { ...actual, version: '2.1.4' };
    }
    const birth = await linuxBirth(pid);
    const selected = await lstat(profile.executable.path);
    const actual = await stat(`/proc/${pid}/exe`);
    if (
      !selected.isFile() ||
      selected.isSymbolicLink() ||
      selected.nlink !== 1 ||
      actual.dev !== selected.dev ||
      actual.ino !== selected.ino ||
      (await realpath(`/proc/${pid}/exe`)) !== profile.executable.path
    )
      return fail();
    const digest = createHash('sha256')
      .update(await readFile(`/proc/${pid}/exe`))
      .digest('hex');
    await verifyOpenCodeV2EmbeddedManifest(embedded);
    const after = await lstat(profile.executable.path);
    if (
      digest !== profile.executable.sha256 ||
      selected.dev !== after.dev ||
      selected.ino !== after.ino ||
      selected.size !== after.size ||
      selected.mtimeMs !== after.mtimeMs ||
      selected.ctimeMs !== after.ctimeMs ||
      (await linuxBirth(pid)) !== birth ||
      !alive() ||
      (ready && (ready.pid !== pid || ready.startIdentity !== birth))
    )
      return fail();
    signal.throwIfAborted();
    return {
      executablePath: profile.executable.path,
      executableSha256: digest,
      pid,
      startIdentity: birth,
      version: '2.1.4',
    };
  }

  const stopOwned = (): Promise<boolean> =>
    (stopping ??= (async () => {
      lifecycle.abort();
      custody.seal();
      // stdin EOF asks the child to close its Effect scope before process custody
      // performs bounded TERM/KILL confirmation for that original process group.
      if (child && !child.stdin.destroyed) child.stdin.end();
      return custody.confirmStopped();
    })());

  async function start(signal?: AbortSignal): Promise<OpenCodeV2EmbeddedReady> {
    if (starting) return starting;
    starting = (async () => {
      const startupController = new AbortController();
      const timeoutMs = startupTimeoutMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180_000)
        return fail();
      const timer = setTimeout(() => startupController.abort(), timeoutMs);
      const combined = AbortSignal.any([
        lifecycle.signal,
        startupController.signal,
        ...(signal ? [signal] : []),
      ]);
      try {
        combined.throwIfAborted();
        if (process.platform === 'win32') {
          // The source verifies the selected graph before loading its exact
          // target N-API binary. Capture remains synchronous before private stdin.
          windowsCustody = await createWindowsJobCustody(embedded, combined);
        } else await verifyOpenCodeV2EmbeddedGraph(embedded, combined);
        for (const directory of [configDirectory, path.dirname(databasePath)]) {
          if (
            !path.isAbsolute(directory) ||
            (await realpath(directory)) !== directory ||
            !(await lstat(directory)).isDirectory()
          )
            return fail();
        }
        const database = await lstat(databasePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (database && (!database.isFile() || database.isSymbolicLink() || database.nlink !== 1))
          return fail();
        const entry = fileURLToPath(
          new URL(
            `./OpenCodeV2EmbeddedChild.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
            import.meta.url
          )
        );
        if ((await realpath(entry)) !== entry || !(await lstat(entry)).isFile()) return fail();
        const input = JSON.stringify({
          nonce,
          password,
          port,
          executable: profile.executable,
          embedded,
          cwd: profile.cwd,
          configDirectory,
          databasePath,
          config,
        });
        if (Buffer.byteLength(input) + 1 > 256 * 1024) return fail();
        combined.throwIfAborted();
        child = custody.launch({
          command: profile.executable.path,
          args: [
            '--no-env-file',
            process.platform === 'win32' ? '--config=NUL' : '--config=/dev/null',
            '--no-install',
            entry,
          ],
          cwd: profile.cwd,
        });
        child.stdin.on('error', () => {});
        const launched = child;
        const endpoint = await new Promise<string>((resolve, reject) => {
          let output = Buffer.alloc(0);
          let outputBytes = 0;
          const rejectReady = (value?: unknown) => {
            const stage =
              typeof value === 'string' &&
              [
                'input',
                'executable',
                'profile',
                'graph',
                'effect',
                'runtime',
                'scope',
                'server',
                'address',
              ].includes(value)
                ? ` (${value})`
                : '';
            dispose();
            reject(new Error(`OpenCode V2 embedded startup failed${stage}`));
          };
          const onOutput = (chunk: Buffer) => {
            outputBytes += chunk.length;
            output = Buffer.concat([output, chunk]);
            if (outputBytes > 256 * 1024 || output.length > 64 * 1024) {
              rejectReady();
              return;
            }
            for (let newline = output.indexOf(10); newline >= 0; newline = output.indexOf(10)) {
              const line = output.subarray(0, newline).toString('utf8');
              output = output.subarray(newline + 1);
              let value: Record<string, unknown>;
              try {
                value = JSON.parse(line) as Record<string, unknown>;
              } catch {
                continue;
              } // Bounded native diagnostics are discarded, never logged.
              if (!value || typeof value !== 'object' || value.nonce !== nonce) continue;
              if (value.type === 'failed') return rejectReady(value.stage);
              if (
                value.type !== 'ready' ||
                value.pid !== launched.pid ||
                value.version !== '2.1.4' ||
                typeof value.endpoint !== 'string' ||
                !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value.endpoint) ||
                Number(new URL(value.endpoint).port) > 65535 ||
                (requestedEndpoint !== undefined && value.endpoint !== requestedEndpoint)
              )
                return rejectReady();
              dispose();
              resolve(value.endpoint);
              return;
            }
          };
          const dispose = () => {
            launched.stdout.off('data', onOutput);
            launched.off('error', rejectReady);
            launched.off('exit', rejectReady);
            combined.removeEventListener('abort', rejectReady);
          };
          launched.stdout.on('data', onOutput);
          launched.once('error', rejectReady);
          launched.once('exit', rejectReady);
          combined.addEventListener('abort', rejectReady, { once: true });
          if (combined.aborted) {
            rejectReady();
            return;
          }
          launched.stdin.write(`${input}\n`, (error) => {
            if (error) rejectReady();
          });
        });
        launched.stdout.resume();
        const observed = await measure(combined);
        readyChild = launched;
        ready = Object.freeze({
          endpoint,
          pid: observed.pid,
          startIdentity: observed.startIdentity,
        });
        return ready;
      } catch (error) {
        const stopped = await stopOwned();
        if (!stopped) throw new Error('OpenCode V2 embedded cleanup unknown', { cause: error });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    return starting;
  }

  return {
    start,
    // This is lifetime evidence for a nonce-checked original ready object, not
    // an executable digest or a new PID capture. Read snapshots still bracket
    // their requests with the full native/image measure below.
    isOriginalLive: (capture: Readonly<OpenCodeV2EmbeddedReady>): boolean =>
      ready !== undefined && capture === ready && readyChild !== undefined &&
      child === readyChild && !stopping && !lifecycle.signal.aborted && alive(),
    readPassword: () => password,
    readNativeCustody: async (signal: AbortSignal): Promise<NativeCustody | undefined> => {
      if (!ready || stopping) return undefined;
      try {
        return await measure(AbortSignal.any([lifecycle.signal, signal]));
      } catch {
        return undefined;
      }
    },
    stopOwned,
    confirmStopped: async () => {
      if (!stopping) return false;
      await stopping.catch(() => false);
      // An earlier unknown stop may become provable once its original tree
      // exits. Refresh custody without resending signals or adopting any PID.
      return custody.observeStopped();
    },
    captureRegisteredProcess: (pid: number, registrar: RegistrarBinding) =>
      custody.captureRegisteredProcess(pid, registrar),
  };
}
