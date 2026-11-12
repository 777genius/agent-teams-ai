import assert from 'node:assert/strict';
import { createWriteStream, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileHash } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { Cdp, waitFor } from '../e2e/release-updater/cdp.mts';
import { desktopJsLiteral } from './desktop-ui-controls.ts';

export function linuxProcessIdentity(pid: number) {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  assert.match(fields[19]!, /^[0-9]+$/);
  return { pid, ppid: Number(fields[1]), group: Number(fields[2]), birth: fields[19]!, state: fields[0]! };
}
export function originalLinuxProcessPresent(original: ReturnType<typeof linuxProcessIdentity>) {
  try { const now = linuxProcessIdentity(original.pid); return now.birth === original.birth && now.state !== 'Z'; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function selectedLinuxProcesses(executable: string) {
  const values: ReturnType<typeof linuxProcessIdentity>[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      if ((await lstat(`/proc/${name}`)).uid !== process.getuid!()) continue;
      const identity = linuxProcessIdentity(Number(name));
      if (identity.state !== 'Z' && await readlink(`/proc/${name}/exe`) === executable &&
        linuxProcessIdentity(Number(name)).birth === identity.birth) values.push(identity);
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return values;
}

/** Absence evidence only. A namespace match never authorizes signaling a process. */
export async function testNamespaceLinuxProcesses(namespace: string) {
  const values: ReturnType<typeof linuxProcessIdentity>[] = [];
  assert.equal(await realpath(namespace), namespace);
  for (const name of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      if ((await lstat(`/proc/${name}`)).uid !== process.getuid!()) continue;
      const identity = linuxProcessIdentity(Number(name));
      if (identity.state === 'Z') continue;
      const executable = await readlink(`/proc/${name}/exe`);
      const environment = await readFile(`/proc/${name}/environ`, 'utf8');
      if ((executable.startsWith(namespace + '/') || environment.includes(namespace)) &&
        linuxProcessIdentity(Number(name)).birth === identity.birth) values.push(identity);
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return values;
}

/** Original dev entry, real preload and renderer. The captured process owns all cleanup. */
export async function startRetainedOpenCodeApp(input: {
  repo: string; root: string; node: string; env: Record<string, string>; port: number; epoch: number;
}) {
  assert.equal(process.platform, 'linux');
  // The caller has freshly built the exact source before importing compiled custody.
  const { CapturedProcess } = await import('../../packages/legacy-agent-host/dist/adapters/providers/CapturedProcess.js');
  const executable = await realpath(join(input.repo, 'node_modules/electron/dist/electron'));
  const capture = new CapturedProcess({ provider: 'opencode', cwd: input.repo,
    executable: { path: input.node, sha256: await fileHash(input.node) },
    environment: { ...input.env, AGENT_TEAMS_DISABLE_SOURCEMAPS: '1' },
  });
  const child = capture.launch({ command: input.node, cwd: input.repo,
    args: ['--max-old-space-size=1536', join(input.repo, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev',
      // electron-vite rewrites ELECTRON_CLI_ARGS from its parsed passthrough.
      '--remoteDebuggingPort', String(input.port), '--', '--ozone-platform=headless',
      '--headless', '--disable-gpu', '--no-sandbox', '--remote-debugging-address=127.0.0.1'] });
  assert.ok(child.pid);
  // Birth/group captured synchronously before any yield or cleanup signal.
  const original = linuxProcessIdentity(child.pid);
  assert.equal(original.group, child.pid);
  const descendants = new Map<string, ReturnType<typeof linuxProcessIdentity>>();
  const key = (value: ReturnType<typeof linuxProcessIdentity>) => `${value.pid}:${value.birth}`;
  descendants.set(key(original), original);
  const observeDescendants = () => {
    const live = new Map<number, ReturnType<typeof linuxProcessIdentity>>();
    for (const name of readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(name)) continue;
      try { const value = linuxProcessIdentity(Number(name)); live.set(value.pid, value); }
      catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    for (let depth = 0; depth < 16; depth++) {
      let added = false;
      for (const value of live.values()) {
        const parent = live.get(value.ppid);
        if (parent && descendants.has(key(parent)) && !descendants.has(key(value))) {
          descendants.set(key(value), value); added = true;
        }
      }
      if (!added) break;
    }
  };
  observeDescendants();
  let ancestryFailure: unknown;
  const ancestryTimer = setInterval(() => { try { observeDescendants(); } catch (error) { ancestryFailure ??= error; } }, 25);
  const log = createWriteStream(join(input.root, `coexistence-app-${input.epoch}.log`), { mode: 0o600 });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let cdp: Cdp | undefined;
  let electron: ReturnType<typeof linuxProcessIdentity> | undefined;
  let failure: unknown;
  let phase = 'inspector';
  const assertCurrent = () => {
    if (ancestryFailure) throw ancestryFailure;
    assert.equal(originalLinuxProcessPresent(original), true,
      `original dev launcher remains current (exit=${child.exitCode}, signal=${child.signalCode})`);
    if (electron) assert.equal(originalLinuxProcessPresent(electron), true, 'original Electron remains current');
  };
  try {
    const target = await waitFor(async () => {
      assertCurrent();
      const candidates = (await selectedLinuxProcesses(executable)).filter(row => row.group === original.group);
      let listener: ReturnType<typeof linuxProcessIdentity> | undefined;
      for (const candidate of candidates) {
        const sockets = new Set<string>();
        for (const fd of await readdir(`/proc/${candidate.pid}/fd`)) {
          try { const match = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${candidate.pid}/fd/${fd}`)); if (match) sockets.add(match[1]!); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const rows = (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1);
        if (rows.some(row => { const fields = row.trim().split(/\s+/); return fields[3] === '0A' &&
          fields[1] === `0100007F:${input.port.toString(16).toUpperCase().padStart(4, '0')}` && sockets.has(fields[9]!); })) {
          assert.equal(listener, undefined, 'single captured Electron inspector'); listener = candidate;
        }
      }
      if (!listener) return null;
      electron = listener; assertCurrent();
      const response = await fetch(`http://127.0.0.1:${input.port}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
      const targets = await response.json() as { type: string; url: string; webSocketDebuggerUrl?: string }[];
      const matches = targets.filter(row => row.type === 'page' && /^http:\/\/localhost:\d+\//.test(row.url));
      assert.ok(matches.length <= 1); return matches[0]?.webSocketDebuggerUrl ? matches[0] : null;
    }, 'original Electron inspector and renderer', 180_000);
    phase = 'CDP connect';
    cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    phase = 'original preload';
    await waitFor(async () => await cdp!.evaluate<boolean>(
      `location.origin===${desktopJsLiteral(new URL(target.url).origin)}&&document.readyState==='complete'&&
       Boolean(window.electronAPI?.teams && window.electronAPI?.agentBackend)&&
       document.getElementById('root')?.childElementCount>0&&!document.getElementById('splash')`) || null,
    'original preload and startup', 120_000);
    let sequence = 0;
    const call = async <T = Record<string, unknown>>(expression: string, timeout = 120_000): Promise<T> => {
      assertCurrent(); const id = `TEST-call-${input.epoch}-${++sequence}`;
      const callPhase = phase;
      phase = `${callPhase}: dispatch ${id}`;
      try {
        await cdp!.evaluate(`(() => { const calls=window.__TEST_retainedCalls??={}; if(calls[${desktopJsLiteral(id)}])throw Error('duplicate');
          calls[${desktopJsLiteral(id)}]={state:'pending'}; Promise.resolve().then(async()=>(${expression})).then(
            value=>{calls[${desktopJsLiteral(id)}]={state:'done',value}},error=>{calls[${desktopJsLiteral(id)}]={state:'failed',message:String(error?.message??error)}});return true})()`);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'CDP timeout: Runtime.evaluate') throw error;
        // An uncertain inspector acknowledgement never authorizes resubmission.
        // Only the already submitted call's immutable TEST slot is observed next.
      }
      phase = `${callPhase}: observe ${id}`;
      const result = await waitFor(async () => {
        assertCurrent();
        try {
          const value = await cdp!.evaluate<{ state: string; value?: T; message?: string } | undefined>(
            `window.__TEST_retainedCalls?.[${desktopJsLiteral(id)}]`);
          return value && value.state !== 'pending' ? value : null;
        } catch (error) {
          if (error instanceof Error && error.message === 'CDP timeout: Runtime.evaluate') return null;
          throw error;
        }
      }, `one original call ${id}`, timeout);
      assert.equal(result.state, 'done', result.message); phase = callPhase; return result.value as T;
    };
    phase = 'original renderer API';
    await call("import('/api/index.ts').then(module => {window.__TEST_retainedApi=module.api;return true})");
    return { cdp, call, assertCurrent, original, electron: electron!,
      async nativeChildren(executable: string) {
        assertCurrent(); observeDescendants();
        return (await selectedLinuxProcesses(executable)).filter(value => descendants.has(key(value)));
      },
      async nativeImageChildren(sha256: string, namespace: string) {
        assertCurrent(); observeDescendants();
        assert.match(sha256, /^[a-f0-9]{64}$/);
        assert.equal(await realpath(namespace), namespace);
        const values = [];
        for (const originalChild of descendants.values()) {
          if (!originalLinuxProcessPresent(originalChild)) continue;
          try {
            const executable = await readlink(`/proc/${originalChild.pid}/exe`);
            if (!executable.startsWith(namespace + '/') ||
              !/\/host-authority\/[a-f0-9]{64}\/images\/[a-f0-9]{64}\/(opencode|custodian)$/.test(executable)) continue;
            assert.equal(await realpath(executable), executable);
            const named = await lstat(executable, { bigint: true });
            const loaded = await stat(`/proc/${originalChild.pid}/exe`, { bigint: true });
            assert.ok(named.isFile() && !named.isSymbolicLink() && named.uid === BigInt(process.getuid!()) &&
              named.nlink === 1n && (named.mode & 0o777n) === 0o500n && named.dev === loaded.dev && named.ino === loaded.ino);
            if (await fileHash(`/proc/${originalChild.pid}/exe`) !== sha256) continue;
            const after = await lstat(executable, { bigint: true });
            assert.ok(named.dev === after.dev && named.ino === after.ino && named.size === after.size &&
              named.mtimeNs === after.mtimeNs && named.ctimeNs === after.ctimeNs);
            assert.equal(linuxProcessIdentity(originalChild.pid).birth, originalChild.birth);
            values.push({ ...originalChild, executable, sha256, dev: String(named.dev), ino: String(named.ino) });
          } catch (error) {
            if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          }
        }
        assertCurrent(); return values;
      },
      async close() {
        assertCurrent();
        await cdp!.evaluate('void window.electronAPI.windowControls.close(); true');
        const until = Date.now() + 45_000;
        // Kernel disappearance can precede Node's original child exit callback.
        while ((originalLinuxProcessPresent(original) ||
          (child.exitCode === null && child.signalCode === null)) && Date.now() < until)
          await new Promise<void>(resolve => setTimeout(resolve, 100));
        assert.equal(originalLinuxProcessPresent(original), false, 'ordinary Quit reaps original launcher');
        assert.equal(child.exitCode, 0, 'normal app exit');
        assert.equal(child.signalCode, null, 'ordinary Quit is not signal termination');
        cdp!.close(); assert.equal(await capture.confirmStopped(), true, 'original app process group released');
        clearInterval(ancestryTimer);
        await new Promise<void>(resolve => log.end(resolve));
      },
      async cleanup() {
        // Close the captured Electron before its dev launcher; losing the
        // launcher first cannot authorize later numeric process-group signals.
        try { await cdp?.send('Browser.close'); } catch { /* Original custody still decides cleanup. */ }
        cdp?.close(); const stopped = await capture.confirmStopped(); clearInterval(ancestryTimer);
        await new Promise<void>(resolve => log.end(resolve)); return stopped;
      },
    };
  } catch (error) { failure = error; }
  try { await cdp?.send('Browser.close'); } catch { /* No numeric process adoption after root exit. */ }
  cdp?.close();
  const stopped = await capture.confirmStopped();
  clearInterval(ancestryTimer);
  await new Promise<void>(resolve => log.end(resolve));
  const reason = failure instanceof Error ? failure.message : String(failure);
  writeFileSync(join(input.root, `coexistence-app-${input.epoch}-failure.json`), JSON.stringify({
    phase, reason, original, electron, exitCode: child.exitCode, signalCode: child.signalCode,
    cleanupConfirmed: stopped, rendererEvents: cdp?.events.slice(-30),
  }, null, 2), { mode: 0o600 });
  if (!stopped) throw new AggregateError([failure, new Error('original app cleanup unknown')],
    `Original app startup failed during ${phase}: ${reason}; original app cleanup unknown`);
  throw new Error(`Original app startup failed during ${phase}: ${reason}`, { cause: failure });
}
