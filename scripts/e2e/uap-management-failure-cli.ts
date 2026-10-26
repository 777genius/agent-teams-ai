// Independent failure diagnostic; never a retry of the failed Management operation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { boundedDiagnosticString } from '../../src/shared/utils/diagnosticsRedaction';

const timeoutMs = 90_000;
const maxOutputBytes = 128 * 1024;
const syntheticKey = 'synthetic-owned-key';
const retain = (value: string) =>
  boundedDiagnosticString(
    value
      .replaceAll(syntheticKey, '[SYNTHETIC_KEY]')
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s"'<>]*@/gi, '$1[REDACTED]@'),
    32_768
  );

interface Fixture {
  root: string;
  source: string;
  engineExecutable: string;
  claude: string;
  env: NodeJS.ProcessEnv;
  publisherRevision: number;
}

function runOwned(executable: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<Record<string, unknown>>((resolve) => {
    // The scanner inherits this group. Native children retain UAP's ordinary
    // parent-liveness supervisor; Node's close event alone is not a quiescence proof.
    const child = spawn(executable, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const buffers = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let bytes = 0;
    let finished = false;
    let timedOut = false;
    let outputLimited = false;
    let terminationStarted = false;
    let leaderExited = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const signals: string[] = [];
    const finish = (result: Record<string, unknown>) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (forceTimer) clearTimeout(forceTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve({
        ...result,
        pid: child.pid,
        timedOut,
        outputLimited,
        terminationSignals: signals,
        stdout: retain(Buffer.concat(buffers.stdout).toString('utf8')),
        stderr: retain(Buffer.concat(buffers.stderr).toString('utf8')),
      });
    };
    const signalOwnedGroup = (signal: NodeJS.Signals) => {
      if (!child.pid || finished || leaderExited || child.exitCode !== null || child.signalCode)
        return;
      try {
        process.kill(-child.pid, signal);
        signals.push(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') signals.push(`${signal}_FAILED`);
      }
    };
    const terminate = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      signalOwnedGroup('SIGTERM');
      forceTimer = setTimeout(() => signalOwnedGroup('SIGKILL'), 2000);
      cleanupTimer = setTimeout(
        () => finish({ status: 'unavailable', code: 'OWNED_CLI_CLEANUP_TIMEOUT' }),
        5000
      );
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer) => {
        const remaining = Math.max(0, maxOutputBytes - bytes);
        if (remaining) buffers[stream].push(chunk.subarray(0, remaining));
        bytes += chunk.length;
        if (bytes > maxOutputBytes) {
          outputLimited = true;
          terminate();
        }
      });
    }
    child.once('exit', () => {
      leaderExited = true;
    });
    child.once('error', () => finish({ status: 'unavailable', code: 'OWNED_CLI_SPAWN_FAILED' }));
    child.once('close', (exitCode, signal) => finish({ status: 'observed', exitCode, signal }));
  });
}

export async function captureFreshProfileCliControl(f: Fixture): Promise<Record<string, unknown>> {
  if (process.platform !== 'linux') return { status: 'unavailable', code: 'UNSUPPORTED_PLATFORM' };
  const ownedRoot = await realpath(f.root);
  assert.equal(ownedRoot, f.root);
  const source = new URL(f.source);
  assert.equal(source.protocol, 'https:');
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.pathname, '/publisher');
  assert.equal(source.username + source.password + source.search + source.hash, '');
  const model = new URL(f.env.ANTHROPIC_BASE_URL!);
  assert.equal(model.protocol, 'http:');
  assert.equal(model.hostname, '127.0.0.1');
  assert.equal(model.username + model.password, '');
  assert.equal(f.env.ANTHROPIC_API_KEY, syntheticKey);
  assert.equal(await realpath(f.env.SSL_CERT_FILE!), path.join(ownedRoot, 'publisher.pem'));
  assert.equal(
    await realpath(path.join(path.dirname(f.claude), 'claude')),
    f.claude,
    'The first Claude search path must resolve to the verified supplied artifact'
  );
  const root = await realpath(await mkdtemp(path.join(ownedRoot, 'fresh-cli-control-')));
  assert(root.startsWith(ownedRoot + path.sep));
  const home = path.join(root, 'home');
  const env: NodeJS.ProcessEnv = {
    PATH: [path.dirname(f.claude), f.env.PATH ?? ''].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    AGENTPLUGINS_HOME: path.join(root, 'uap-state'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_RUNTIME_DIR: path.join(root, 'runtime'),
    TMPDIR: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
    LANG: f.env.LANG,
    LC_ALL: f.env.LC_ALL,
    SSL_CERT_FILE: f.env.SSL_CERT_FILE,
    NO_PROXY: f.env.NO_PROXY,
    HTTP_PROXY: f.env.HTTP_PROXY,
    HTTPS_PROXY: f.env.HTTPS_PROXY,
    ALL_PROXY: f.env.ALL_PROXY,
  };
  await Promise.all(
    Object.entries(env)
      .filter(([key]) => /^(HOME|USERPROFILE|TMP|TEMP|TMPDIR)$|_(HOME|DIR)$/.test(key))
      .map(([, directory]) => mkdir(directory!, { recursive: true }))
  );
  await writeFile(
    path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'),
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: f.env.ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY: syntheticKey },
    })
  );
  const args = [
    'skills',
    'add',
    f.source,
    '--skill',
    'uap-ui-demo',
    '--target',
    'claude',
    '--scope',
    'user',
    '--no-ui',
    '--yes',
    '--format',
    'json',
  ];
  return {
    identity: 'SEPARATE_FRESH_PROFILE_PUBLIC_CLI_CONTROL',
    root,
    home,
    stateRoot: env.AGENTPLUGINS_HOME,
    executable: f.engineExecutable,
    claudeSearchDirectory: path.dirname(f.claude),
    args,
    publisherRevision: f.publisherRevision,
    syntheticSettingsFields: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'],
    timeoutMs,
    maxOutputBytes,
    result: await runOwned(f.engineExecutable, args, env, home),
  };
}
