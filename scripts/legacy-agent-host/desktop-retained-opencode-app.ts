import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileHash } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { isLeadMember } from '../../src/shared/utils/leadDetection.ts';
import { Cdp, waitFor } from '../e2e/release-updater/cdp.mts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import { bounded } from './desktop-proof-bounds.ts';
import type { startRetainedOpenCodeModel } from './desktop-retained-opencode-model.ts';

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
/** Kernel identities only: protected executable/environment files are not inspected. */
export async function snapshotLinuxProcesses() {
  const values: ReturnType<typeof linuxProcessIdentity>[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      if ((await lstat(`/proc/${name}`)).uid !== process.getuid!()) continue;
      values.push(Object.freeze(linuxProcessIdentity(Number(name))));
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return Object.freeze(values);
}

export async function selectedLinuxProcesses(executable: string,
  owns: (identity: ReturnType<typeof linuxProcessIdentity>) => boolean) {
  const values: ReturnType<typeof linuxProcessIdentity>[] = [];
  for (const identity of await snapshotLinuxProcesses()) {
    // Same-UID runner services can deny exe access. Only the original observed
    // ancestry/group may be probed; an inaccessible owned identity stays UNKNOWN.
    if (identity.state === 'Z' || !owns(identity)) continue;
    try {
      if (await readlink(`/proc/${identity.pid}/exe`) !== executable) continue;
      const after = linuxProcessIdentity(identity.pid);
      if (after.birth === identity.birth && owns(after)) values.push(after);
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return values;
}

/** Absence evidence only. A namespace match never authorizes signaling a process. */
export async function testNamespaceLinuxProcesses(namespace: string,
  baseline: readonly ReturnType<typeof linuxProcessIdentity>[]) {
  const values: ReturnType<typeof linuxProcessIdentity>[] = [];
  assert.equal(await realpath(namespace), namespace);
  const preexisting = new Set(baseline.map(identity => `${identity.pid}:${identity.birth}`));
  for (const identity of await snapshotLinuxProcesses()) {
    // The snapshot precedes creation of this fresh TEST namespace. Exclude only
    // those exact original identities; PID reuse and new unreadable children fail.
    if (identity.state === 'Z' || preexisting.has(`${identity.pid}:${identity.birth}`)) continue;
    try {
      const executable = await readlink(`/proc/${identity.pid}/exe`);
      const environment = await readFile(`/proc/${identity.pid}/environ`, 'utf8');
      if ((executable.startsWith(namespace + '/') || environment.includes(namespace)) &&
        linuxProcessIdentity(identity.pid).birth === identity.birth) values.push(identity);
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return values;
}

/** Original dev entry, real preload and renderer. The captured process owns all cleanup. */
export async function startRetainedOpenCodeApp(input: {
  repo: string; root: string; node: string; env: Record<string, string>; port: number; epoch: number;
  donor4a?: true;
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
      observeDescendants();
      const candidates = await selectedLinuxProcesses(executable,
        row => row.group === original.group && descendants.has(key(row)));
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
    // Ozone can expose a 1x1 viewport despite the original BrowserWindow bounds.
    // Match the existing real Electron smokes before any original renderer work.
    phase = 'desktop viewport';
    assertCurrent();
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor(async () => {
      assertCurrent();
      return await cdp!.evaluate<boolean>('innerWidth === 1440 && innerHeight === 1000') || null;
    }, 'original desktop viewport', 30_000);
    phase = 'original preload';
    const apiReady = input.donor4a === true
      ? 'Boolean(window.electronAPI?.teams && window.electronAPI?.memberLogStream && window.electronAPI?.externalAgentConnection)'
      : 'Boolean(window.electronAPI?.teams && window.electronAPI?.agentBackend)';
    await waitFor(async () => await cdp!.evaluate<boolean>(
      `location.origin===${desktopJsLiteral(new URL(target.url).origin)}&&document.readyState==='complete'&&
       ${apiReady}&&
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
        return selectedLinuxProcesses(executable, value => descendants.has(key(value)));
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

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  assert.ok(typeof value === 'string' && value.length > 0);
  return value;
};
type RetainedApp = Awaited<ReturnType<typeof startRetainedOpenCodeApp>>;

/** Optional post-failure evidence only; no product IPC, action retry or cleanup authority. */
export async function captureRetainedDonorUiFailure(app: Pick<RetainedApp, 'assertCurrent' | 'original' | 'electron'> & {
  cdp: Pick<Cdp, 'evaluate' | 'send'>;
}, root: string, epoch: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
  const diagnostic: Record<string, unknown> = { status: 'INCOMPLETE',
    observation: 'after-original-failure-before-cleanup', atomicWithFailure: false,
    epoch: epoch?.kind ?? null, sourceCommit: epoch?.sourceCommit ?? null,
    original: app.original, electron: app.electron, observedAtMs: Date.now() };
  try {
    app.assertCurrent();
    const form = await bounded(app.cdp.evaluate(`(() => {
      const pages=document.querySelectorAll('[data-testid="create-team-page"]');
      if(pages.length!==1)return {status:'unavailable',pageCount:Math.min(pages.length,2)};
      const page=pages[0],footer=page.querySelector(':scope > div.grow');
      const text=(node,limit)=>node instanceof HTMLElement?node.innerText.slice(0,limit):null;
      const field=selector=>{const node=page.querySelector(selector);return node instanceof HTMLInputElement?
        {value:node.value.slice(0,1000),valid:node.validity.valid,ariaInvalid:node.getAttribute('aria-invalid')}:null;};
      return {status:'observed',readyState:document.readyState,pageCount:1,
        teamName:field('#team-name'),cwd:field('input[aria-label="Custom working directory"]'),
        solo:page.querySelector('#solo-team')?.getAttribute('aria-checked')??null,
        lead:text(page.querySelector('[data-role="lead-row"]'),500),
        formText:text(page,4000),footerText:text(footer,4000),
        errors:[...page.querySelectorAll('[role="alert"],[aria-invalid="true"],[class*="text-red-"]')]
          .slice(0,8).map(node=>text(node,300)),
        buttons:[...footer?.querySelectorAll('button')??[]].slice(0,8).map(node=>({
          text:text(node,160),disabled:node.disabled,ariaDisabled:node.getAttribute('aria-disabled')}))};
    })()`), 4000, 'read retained donor failure form');
    app.assertCurrent();
    assert.ok(Buffer.byteLength(JSON.stringify(form), 'utf8') <= 64 * 1024);
    diagnostic.form = form;
  } catch (error) {
    diagnostic.form = { unavailable: true, error: error instanceof Error ? error.message.slice(0,1000) : 'unavailable' };
  }
  let screenshotOpen = true;
  try {
    diagnostic.screenshot = await bounded((async () => {
      app.assertCurrent();
      const screenshot = await app.cdp.send<{ data: string }>(
        'Page.captureScreenshot', { format: 'png', fromSurface: true });
      if (!screenshotOpen) throw new Error('retained donor screenshot observation closed');
      app.assertCurrent();
      assert.ok(typeof screenshot.data === 'string' && screenshot.data.length > 0 && screenshot.data.length <= 8 * 1024 * 1024);
      const bytes = Buffer.from(screenshot.data, 'base64'), path = join(root, 'donor-history-failure.png');
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
      if (!screenshotOpen) throw new Error('retained donor screenshot observation closed');
      return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
    })(), 5000, 'retained donor failure screenshot');
  } catch (error) {
    diagnostic.screenshot = { unavailable: true, error: error instanceof Error ? error.message.slice(0,1000) : 'unavailable' };
  } finally { screenshotOpen = false; }
  diagnostic.finishedAtMs = Date.now();
  return diagnostic;
}

/** The same native reader and ambiguity checks serve both original retained epochs. */
export async function readRetainedNativeReply(input: {
  app: RetainedApp; teamName: string; memberName: string; member: Record<string, unknown>;
  expectedReply: string; failures: readonly string[]; observe(value: Record<string, unknown>): void;
}): Promise<Record<string, unknown> | null> {
  const { app, teamName, memberName, member, expectedReply, failures } = input;
  assert.equal(member.memberName, memberName); assert.equal(member.providerId, 'opencode');
  const laneId = member.laneId, nativeSessionId = member.runtimeSessionId;
  assert.ok(typeof laneId === 'string' && laneId.length > 0);
  assert.ok(typeof nativeSessionId === 'string' && nativeSessionId.length > 0);
  assert.deepEqual(failures, []);
  // This is the original member UI's native reader; generic JSONL logs are its fallback.
  const stream: Record<string, unknown> = await app.call(`window.__TEST_retainedApi.memberLogStream.getMemberLogStream(
    ${desktopJsLiteral(teamName)},${desktopJsLiteral(memberName)},${desktopJsLiteral({ laneId, limitSegments: 30, forceRefresh: true })})`);
  assert.ok(Array.isArray(stream.segments));
  const responseShapes: Record<string, unknown>[] = [];
  input.observe({ laneId, nativeSessionId, coverage: stream.coverage,
    warnings: stream.warnings, sources: stream.segments.map(value => record(value).source),
    actors: stream.segments.slice(0, 4).map(value => record(value).actor), responses: responseShapes });
  const segments = stream.segments.map(record).filter(segment => {
    const source = record(segment.source), actor = record(segment.actor);
    return source.provider === 'opencode_runtime' && source.label === 'OpenCode runtime' &&
      source.sessionId === nativeSessionId && source.laneId === laneId &&
      actor.memberName === memberName && actor.sessionId === nativeSessionId;
  });
  assert.ok(segments.length <= 1, 'native history binding is unambiguous');
  const replies: Record<string, unknown>[] = [];
  for (const segment of segments) {
    assert.ok(Array.isArray(segment.chunks));
    for (const value of segment.chunks) {
      const chunk = record(value);
      if (chunk.chunkType !== 'ai') continue;
      assert.ok(Array.isArray(chunk.responses));
      for (const responseValue of chunk.responses) {
        const response = record(responseValue);
        const shape: Record<string, unknown> = { type: response.type, role: response.role,
          sessionId: response.sessionId, uuid: response.uuid, expectedTextMatched: null };
        if (responseShapes.length < 16) responseShapes.push(shape);
        if (response.type !== 'assistant' || response.role !== 'assistant' ||
          response.sessionId !== nativeSessionId) continue;
        const content = typeof response.content === 'string' ? response.content :
          Array.isArray(response.content) ? response.content.map(record)
            .filter(block => block.type === 'text' && typeof block.text === 'string')
            .map(block => block.text).join('') : '';
        shape.expectedTextMatched = content === expectedReply;
        if (content !== expectedReply) continue;
        assert.ok(typeof response.uuid === 'string' && response.uuid.length > 0);
        replies.push({ provider: 'opencode_runtime', laneId, nativeSessionId,
          replyUuid: response.uuid,
          replyContentSha256: createHash('sha256').update(JSON.stringify(response.content)).digest('hex') });
      }
    }
  }
  assert.ok(replies.length <= 1, 'one actual native assistant reply');
  assert.deepEqual(failures, []);
  return replies[0] ?? null;
}

/** Three real UI epochs; API calls below are read-only witnesses, never producer mutations. */
export async function exerciseRetainedDonorHistory(input: {
  repo: string; sourceHead: string; root: string; node: string; port: number;
  donor: { root: string; commit: string; tree: string; node: { path: string };
    runtime: { path: string; sha256: string }; custody: { sha256: string } };
  v1: { path: string; sha256: string }; env: Record<string, string>;
  model: Awaited<ReturnType<typeof startRetainedOpenCodeModel>>;
  proof: Record<string, unknown>; cleanupErrors: unknown[];
  baseline: Awaited<ReturnType<typeof snapshotLinuxProcesses>>;
  reviewFixture: { filePath: string; relativePath: string; before: string; after: string;
    beforeSha256: string; afterSha256: string; commit: string; tree: string;
    png: { path: string; name: string; bytes: number; sha256: string } };
  assertInputs(): Promise<void>;
  captureReview(identity: Record<string, unknown>): Promise<Record<string, unknown>>;
  preserveCorpus(teamName: string, taskId: string): Promise<Record<string, unknown>>;
}) {
  const { proof, model, donor, root, reviewFixture } = input;
  const literal = desktopJsLiteral;
  const teamName = 'test-donor-4a-opencode-history', subject = 'TEST donor 4a retained sidebar record';
  const marker = 'TEST_RETAINED_V1_HISTORY', reply = 'REPLY_TEST_RETAINED_V1_HISTORY';
  const steps: Record<string, unknown>[] = [], epochs: Record<string, unknown>[] = [];
  const processes: Awaited<ReturnType<typeof selectedLinuxProcesses>> = [];
  Object.assign(proof, { teamName, marker, reply, steps, epochs, processes });
  let app: RetainedApp | undefined, failure: unknown;
  let member: Record<string, unknown>, memberName: string, taskId: string, messageId: string;
  let savedTask: unknown, savedMessage: unknown, nativeReply: Record<string, unknown>;
  let displayId: string, messageText: string, attachment: Record<string, unknown> | undefined;
  let savedReview: Record<string, unknown> | undefined;
  let inferenceAtDonorQuit: number | undefined;
  const getData = () => app!.call(`window.__TEST_retainedApi.teams.getData(${literal(teamName)})`);
  const getTask = () => app!.call(`window.__TEST_retainedApi.teams.getTask(${literal(teamName)},${literal(taskId!)})`);
  const captureProcesses = async () => {
    const values = [
      ...await app!.nativeChildren(donor.runtime.path),
      ...await app!.nativeImageChildren(input.v1.sha256, root),
      ...await app!.nativeImageChildren(donor.custody.sha256, root),
    ];
    for (const value of values) if (!processes.some(row => row.pid === value.pid && row.birth === value.birth)) processes.push(value);
    return values;
  };
  try {
    for (const [index, kind] of ['donor', 'current', 'cold'].entries()) {
      await input.assertInputs();
      app = await startRetainedOpenCodeApp({ repo: kind === 'donor' ? donor.root : input.repo,
        root, node: kind === 'donor' ? donor.node.path : input.node, env: input.env,
        port: input.port, epoch: index + 3, ...(kind === 'donor' ? { donor4a: true as const } : {}) });
      const epoch: Record<string, unknown> = { kind,
        sourceCommit: kind === 'donor' ? donor.commit : input.sourceHead,
        original: app.original, electron: app.electron, inferenceAtStart: model.observations.length };
      epochs.push(epoch);
      const ui = createDesktopUiControls(app.cdp, { assertOwnedRenderer: app.assertCurrent,
        step: value => steps.push({ epoch: kind, ...value }) });
      await ui.observeInput();
      const fill = async (selector: string, value: string) => {
        await ui.scrollTo(selector, 'original input visible');
        await ui.click(selector, 'focus original input');
        await ui.waitRead(`document.activeElement===document.querySelector(${literal(selector)})`, 'original input focused');
        app!.assertCurrent();
        await app!.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
        app!.assertCurrent();
        await app!.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
        app!.assertCurrent();
        await app!.cdp.send('Input.insertText', { text: value });
        await ui.waitRead(`document.querySelector(${literal(selector)})?.value===${literal(value)}`, 'original input acknowledged');
      };
      const openLead = async () => {
        const selector = '[data-section-id="team"] div[role="button"][tabindex="0"]';
        const displayName = memberName === 'team-lead' ? 'lead' : memberName;
        await ui.waitRead(`(() => {
          const rows=[...document.querySelectorAll(${literal(selector)})].filter(e=>e.getBoundingClientRect().width>0);
          return rows.length===1&&[...rows[0].querySelectorAll('span')].some(e=>e.textContent.trim()===${literal(displayName)});
        })()`, 'sole actual solo lead row');
        await ui.scrollTo(selector, 'actual solo lead visible');
        await ui.click(selector, 'open actual solo lead');
      };
      const visibleText = async (selector: string, expected: string) => ui.waitRead(`(() => {
        const panels=[...document.querySelectorAll(${literal(selector)})].filter(e=>e.getBoundingClientRect().width>0);
        if(panels.length!==1)return null;
        const rows=[...panels[0].querySelectorAll('p,pre,code,span,div')].filter(e=>{
          const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.innerText?.trim()===${literal(expected)};
        });return rows.length>0&&rows.length<=32?{text:${literal(expected)},matches:rows.length}:null;
      })()`, 'original visible ' + expected, 90_000);
      const openTask = async () => {
        const selector = '.kanban-task-card[data-task-id=' + literal(taskId!) + '] h5';
        await ui.scrollTo(selector, 'original retained Task subject', subject);
        await ui.click(selector, 'open original retained Task detail', subject);
        epoch.taskDetail = await ui.waitRead(`(() => {
          const nodes=[...document.querySelectorAll('[role="dialog"] [data-task-detail-content]')];
          if(nodes.length!==1)return null;const node=nodes[0];
          const key=Object.keys(node).find(key=>key.startsWith('__reactFiber$'));
          let fiber=key?node[key]:null;
          for(let depth=0;fiber&&depth<64;depth++,fiber=fiber.return){
            const model=fiber.memoizedProps?.model,task=model?.currentTask;
            if(model?.teamName===${literal(teamName)}&&task?.id===${literal(taskId!)}&&task.subject===${literal(subject)})
              return {teamName:model.teamName,taskId:task.id,subject:task.subject};
          }return null;
        })()`, 'exact original Task detail owner');
      };
      const attachmentSection = '[role="dialog"] section:has(svg.lucide-image)';
      const readAttachment = async () => {
        const task = record(await getTask());
        assert.equal(task.id, taskId); assert.ok(Array.isArray(task.attachments));
        assert.equal(task.attachments.length, 1, 'one actual Task attachment');
        const current = record(task.attachments[0]);
        assert.equal(current.filename, reviewFixture.png.name);
        assert.equal(current.mimeType, 'image/png'); assert.equal(current.size, reviewFixture.png.bytes);
        assert.ok(text(current.id));
        if (attachment) assert.deepEqual(current, attachment);
        const encoded = await app!.call<string>(
          `window.__TEST_retainedApi.teams.getTaskAttachment(${literal(teamName)},${literal(taskId!)},${literal(text(current.id))},'image/png')`
        );
        assert.equal(typeof encoded, 'string'); assert.ok(encoded.length <= 4096);
        const bytes = Buffer.from(encoded, 'base64');
        assert.equal(bytes.length, reviewFixture.png.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), reviewFixture.png.sha256);
        app!.assertCurrent();
        const section = record(await app!.cdp.evaluate(`(() => {
          const sections=[...document.querySelectorAll(${literal(attachmentSection)})];
          if(sections.length!==1)return null;
          const headers=[...sections[0].querySelectorAll(':scope > div:first-child > button[aria-label]')]
            .filter(e=>['Expand section','Collapse section'].includes(e.getAttribute('aria-label')));
          if(headers.length!==1)return null;const button=headers[0],r=button.getBoundingClientRect();
          return button instanceof HTMLButtonElement&&!button.disabled&&r.width>0&&r.height>0
            ?{collapsed:button.getAttribute('aria-label')==='Expand section'}:null;
        })()`));
        app!.assertCurrent();
        if (section.collapsed === true) {
          const header = attachmentSection + ' > div:first-child > button[aria-label="Expand section"]';
          await ui.scrollTo(header, 'original Task attachment header visible');
          await ui.click(header, 'expand original retained Task attachments');
        }
        await ui.scrollTo(attachmentSection + ' img[alt=' + literal(reviewFixture.png.name) + ']', 'original Task PNG visible');
        const image = record(await ui.waitRead(`(() => {
          const images=[...document.querySelectorAll(${literal(attachmentSection + ' img')})]
            .filter(e=>e.alt===${literal(reviewFixture.png.name)}&&e.complete&&e.naturalWidth===2&&e.naturalHeight===1);
          if(images.length!==1)return null;const image=images[0],r=image.getBoundingClientRect();
          return r.width>0&&r.height>0?{src:image.currentSrc||image.src,width:image.naturalWidth,height:image.naturalHeight}:null;
        })()`, 'actual original Task PNG visible'));
        assert.match(text(image.src), /^data:image\/png;base64,/);
        const visibleBytes = Buffer.from(text(image.src).split(',')[1]!, 'base64');
        assert.equal(visibleBytes.length, reviewFixture.png.bytes);
        assert.equal(createHash('sha256').update(visibleBytes).digest('hex'), reviewFixture.png.sha256);
        attachment = current;
        epoch.attachment = { ...current, sha256: reviewFixture.png.sha256, width: image.width, height: image.height };
      };
      if (kind === 'donor') {
        assert.deepEqual(await app.call('window.__TEST_retainedApi.teams.list()'), [], 'fresh donor has no seeded teams');
        await ui.click('button[aria-label="More actions"]', 'open existing More menu');
        await ui.click('button', 'open original Teams', 'Teams');
        await ui.click('div.mb-4:has(> div > div > h2) > div > div.ml-auto > button',
          'open original creation', 'Create Team');
        const page = '[data-testid="create-team-page"]';
        await fill(page + ' #team-name', teamName);
        await ui.scrollTo('#solo-team', 'solo control visible');
        await ui.click('#solo-team', 'select original solo mode');
        await ui.waitRead('document.querySelector("#solo-team")?.getAttribute("aria-checked")==="true"', 'solo selected');
        const leadTrigger = '[data-role="lead-row"] button[aria-label*=" provider, "]';
        await ui.scrollTo(leadTrigger, 'lead model picker visible');
        const picker = record(await ui.waitRead(`(() => {
          const rows=document.querySelectorAll('[data-role="lead-row"]');
          return rows.length===1?{open:Boolean(rows[0].querySelector('[data-testid="team-model-selector-provider-nav-opencode"]'))}:null;
        })()`, 'original lead picker state'));
        if (picker.open !== true) await ui.click(leadTrigger, 'open original lead model picker');
        await ui.click('[data-testid="team-model-selector-provider-nav-opencode"]', 'select original OpenCode provider');
        await ui.waitRead('document.querySelector("[data-testid=team-model-selector-provider-nav-opencode]")?.getAttribute("data-state")==="active"', 'OpenCode selected before cwd');
        await ui.scrollTo(page + ' button', 'custom cwd control visible', 'Custom path');
        await ui.click(page + ' button', 'choose original custom cwd', 'Custom path');
        await fill(page + ' input[aria-label="Custom working directory"]', join(root, 'project'));
        const clearFilters = '[data-testid="team-model-selector-clear-filters"]';
        await ui.scrollTo(clearFilters, 'original model source filters visible');
        await ui.click(clearFilters, 'clear original model source filter');
        const modelSelector = '[data-testid="team-model-selector-model-option"][aria-label^="TEST-model"]';
        await ui.waitRead(`(() => {const rows=[...document.querySelectorAll(${literal(modelSelector)})];
          return rows.length===1&&rows[0].querySelector('[data-testid="team-model-selector-model-name"]')?.textContent.trim()==='TEST-model';})()`, 'one finite project model');
        await ui.scrollTo(modelSelector, 'finite model visible');
        await ui.click(modelSelector, 'select actual TEST model');
        await ui.waitRead(`document.querySelector(${literal(modelSelector)})?.getAttribute('aria-pressed')==='true'`, 'actual model selected');
        await ui.scrollTo(leadTrigger, 'selected lead model control visible');
        await ui.click(leadTrigger, 'close original selected model picker');
        await ui.scrollTo(page + ' button', 'original Create visible', 'Create');
        await ui.click(page + ' button', 'create and launch original solo team', 'Create');
        const launched = await waitFor(async () => {
          const teams = await app!.call<unknown[]>('window.__TEST_retainedApi.teams.list()');
          if (!teams.map(record).some(row => row.teamName === teamName)) return null;
          const data = await getData(), config = record(data.config);
          assert.ok(Array.isArray(config.members));
          const leads = config.members.map(record).filter(isLeadMember);
          if (leads.length !== 1) return null;
          assert.equal(config.members.length, 1, 'solo creates only its actual lead');
          const name = text(leads[0]!.name);
          const runtime = await app!.call(`window.__TEST_retainedApi.teams.getTeamAgentRuntime(${literal(teamName)})`);
          const row = record(record(runtime.members)[name] ?? {});
          return row.alive === true && row.providerId === 'opencode' && row.historicalBootstrapConfirmed === true &&
            row.runtimeModel === 'test-legacy/TEST-model' && typeof row.runtimeSessionId === 'string' && row.runtimeSessionId &&
            typeof row.laneId === 'string' && row.laneId && typeof runtime.runId === 'string' && runtime.runId
            ? { row, name, runId: runtime.runId } : null;
        }, 'original donor solo native bootstrap', 180_000);
        member = launched.row; memberName = launched.name;
        await openLead();
        await ui.click('[role="dialog"] button', 'assign original retained task', 'Assign Task');
        await fill('#task-subject', subject);
        await ui.waitRead('document.querySelector("#task-start-immediately")?.getAttribute("aria-checked")==="true"', 'original task start default');
        await ui.click('#task-start-immediately', 'save task without a second business turn');
        await ui.waitRead('document.querySelector("#task-start-immediately")?.getAttribute("aria-checked")==="false"', 'task start disabled by original UI');
        await ui.click('[role="dialog"] button', 'create original retained task', 'Create');
        const task = await waitFor(async () => {
          const data = await getData(); assert.ok(Array.isArray(data.tasks));
          const tasks = data.tasks.map(record).filter(row => row.subject === subject);
          assert.ok(tasks.length <= 1); return tasks[0] ?? null;
        }, 'actual donor task identity', 30_000);
        taskId = text(task.id); proof.createdTask = task;
        await ui.waitRead('!document.querySelector("#task-subject")', 'original create task dialog settled');
        await openTask();
        await ui.scrollTo(attachmentSection + ' > div > button[aria-label="Expand section"]', 'original Task attachment section');
        await ui.click(attachmentSection + ' > div > button[aria-label="Expand section"]', 'expand original Task attachments');
        const fileSelector = attachmentSection + ' input[type="file"]';
        await ui.waitRead(`(() => {const nodes=document.querySelectorAll(${literal(fileSelector)});
          return nodes.length===1&&!nodes[0].disabled;})()`, 'original Task file input eligible');
        assert.equal(await fileHash(reviewFixture.png.path), reviewFixture.png.sha256);
        const dom = await app.cdp.send<{ root: { nodeId: number } }>('DOM.getDocument');
        app.assertCurrent();
        const fileInputs = await app.cdp.send<{ nodeIds: number[] }>('DOM.querySelectorAll', {
          nodeId: dom.root.nodeId, selector: fileSelector,
        });
        assert.equal(fileInputs.nodeIds.length, 1);
        app.assertCurrent();
        steps.push({ epoch: kind, action: 'fileInput', name: reviewFixture.png.name, sha256: reviewFixture.png.sha256 });
        await app.cdp.send('DOM.setFileInputFiles', { nodeId: fileInputs.nodeIds[0], files: [reviewFixture.png.path] });
        await ui.waitRead(
          `Boolean(document.querySelector(${literal(attachmentSection + ' img[alt=' + literal(reviewFixture.png.name) + ']')}))`,
          'Task upload acknowledged'
        );
        await readAttachment();
        await ui.click('[role="dialog"] button', 'close original Task detail before message', 'Close');
        await ui.waitRead('!document.querySelector("[role=dialog] [data-task-detail-content]")', 'Task detail closed');
        await openLead();
        await ui.click('[role="dialog"] button', 'open direct lead message', 'Send Message');
        await fill('#smd-message', marker + ' #');
        const suggestionSelector = '[role="listbox"] [role="option"]:has(svg.lucide-hash)';
        const suggestion = record(await ui.waitRead(`(() => {
          const rows=[...document.querySelectorAll(${literal(suggestionSelector)})].filter(e=>e.getBoundingClientRect().width>0);
          if(rows.length!==1||![...rows[0].querySelectorAll('div')].some(e=>e.textContent.trim()===${literal(subject)}))return null;
          const label=rows[0].querySelector('div > div > span')?.textContent.trim();
          return label&&/^#[A-Za-z0-9-]{1,128}$/.test(label)?{displayId:label.slice(1),subject:${literal(subject)}}:null;
        })()`, 'one real Task reference suggestion'));
        displayId = text(suggestion.displayId); messageText = marker + ' #' + displayId;
        await ui.click(suggestionSelector, 'choose original Task reference once');
        epoch.taskMention = suggestion;
        await ui.waitRead(`(() => {const value=document.querySelector('#smd-message')?.value;
          return typeof value==='string'&&value.startsWith(${literal(messageText)})&&value.includes('\\u2063')&&value.includes('\\u2064');})()`,
          'original encoded Task reference acknowledged');
        await ui.click('[role="dialog"] button', 'send one original HISTORY message', 'Send');
        await waitFor(async () => { assert.deepEqual(model.failures, []); return model.markers.has(marker) || null; }, 'donor inference observes original input', 90_000);
        nativeReply = await waitFor(() => readRetainedNativeReply({ app: app!, teamName, memberName, member,
          expectedReply: reply, failures: model.failures, observe: value => { epoch.nativeRead = value; } }), 'actual donor native reply', 90_000);
        const message = await waitFor(async () => {
          const data = await getData(); assert.ok(Array.isArray(data.messages));
          const rows = data.messages.map(record).filter(row => row.from === 'user' && row.to === memberName && row.text === messageText && row.source === 'user_sent');
          assert.ok(rows.length <= 1); return rows[0] ?? null;
        }, 'actual donor sent message identity', 30_000);
        messageId = text(message.messageId); savedMessage = message;
        assert.deepEqual(message.taskRefs, [{ taskId, displayId, teamName }]);
        proof.identity = { teamName, runId: launched.runId, memberName, laneId: text(member.laneId),
          nativeSessionId: text(member.runtimeSessionId), taskId, displayId, messageId, ...nativeReply };
        const children = await captureProcesses();
        assert.ok(children.some(row => 'sha256' in row && row.sha256 === input.v1.sha256), 'real original donor V1 image captured');
        epoch.nativeProcesses = children;
      } else {
        assert.equal(await app.call(`window.__TEST_retainedApi.teams.processAlive(${literal(teamName)})`), false);
        await ui.clickSidebar(subject);
      }
      const data = await getData();
      assert.ok(Array.isArray(data.tasks)); assert.ok(Array.isArray(data.messages));
      const taskBeforeReview = data.tasks.map(record).find(row => row.id === taskId!);
      assert.ok(taskBeforeReview); assert.equal(taskBeforeReview.subject, subject);
      assert.deepEqual(data.messages.map(record).find(row => row.messageId === messageId! && row.source === 'user_sent'), savedMessage);
      epoch.task = { id: taskId!, displayId: displayId!, subject };
      epoch.message = { messageId: messageId!, text: messageText!, to: memberName!,
        taskRefs: [{ taskId: taskId!, displayId: displayId!, teamName }] };
      epoch.visibleTask = await ui.waitRead(`(() => {
        const rows=[...document.querySelectorAll('#sidebar-tasks-panel [data-task-key]')].filter(e=>
          e.dataset.taskKey===${literal(JSON.stringify([teamName, taskId!]))}&&e.getBoundingClientRect().width>0);
        const value=rows.length===1?rows[0].querySelector('[data-task-card-field="subject"]')?.innerText:null;
        return value===${literal(subject)}?{key:rows[0].dataset.taskKey,subject:value}:null;
      })()`, 'same original visible task identity');
      await ui.waitRead('!document.querySelector("#smd-message")', 'original send dialog settled');
      await openTask();
      await readAttachment();
      const taskImage = await app.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(root, `donor-history-${kind}-task.png`), Buffer.from(taskImage.data, 'base64'), { mode: 0o600 });
      const changesSection = '[role="dialog"] section:has(svg.lucide-file-diff) > div > button[aria-label="Expand section"]';
      await ui.scrollTo(changesSection, 'original Task Changes section');
      await ui.click(changesSection, 'open original Task Changes');
      const changedFile = '[role="dialog"] [role="button"][aria-label=' + literal(reviewFixture.relativePath) + ']';
      await ui.scrollTo(changedFile, 'actual native Task file');
      await ui.click(changedFile, 'open original native Task diff');
      epoch.review = await ui.waitRead(`(() => {
        if(document.querySelectorAll('button[aria-label="Close Changes"]').length!==1||
          ![...document.querySelectorAll('h2')].some(e=>e.textContent.includes(${literal(subject)})))return null;
        const editors=[...document.querySelectorAll('.cm-editor')].filter(e=>e.getBoundingClientRect().width>0);
        if(editors.length!==1)return null;
        const visible=text=>[...editors[0].querySelectorAll('div,span')].some(e=>{
          const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.textContent.trim()===text;
        });
        return visible(${literal(reviewFixture.before.trim())})&&visible(${literal(reviewFixture.after.trim())})
          ?{filePath:${literal(reviewFixture.filePath)},relativePath:${literal(reviewFixture.relativePath)},
            visibleBefore:${literal(reviewFixture.before.trim())},visibleAfter:${literal(reviewFixture.after.trim())}}:null;
      })()`, 'actual native before and after in original Task Changes');
      const provenance = await input.captureReview(record(proof.identity));
      const stableReview = Object.fromEntries(
        ['binding', 'delivery', 'event', 'before', 'after'].map(key => [key, record(provenance[key])])
      );
      if (savedReview) assert.deepEqual(stableReview, savedReview, 'same persisted native Task change after restart');
      else savedReview = stableReview;
      record(epoch.review).provenance = provenance;
      const reviewImage = await app.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(root, `donor-history-${kind}-review.png`), Buffer.from(reviewImage.data, 'base64'), { mode: 0o600 });
      await ui.click('button[aria-label="Close Changes"]', 'close original Task Changes without decisions');
      await ui.waitRead(`!document.querySelector('button[aria-label="Close Changes"]')&&
        !document.querySelector('[role="dialog"] [data-task-detail-content]')`, 'original Changes and Task detail closed');
      const afterReview = await getData(); assert.ok(Array.isArray(afterReview.tasks));
      const reviewedTask = afterReview.tasks.map(record).find(row => row.id === taskId!);
      assert.ok(reviewedTask); assert.equal(reviewedTask.subject, subject);
      if (kind === 'donor') savedTask = reviewedTask;
      else assert.deepEqual(reviewedTask, savedTask, 'whole retained Task after its original Changes read');
      await openLead();
      await ui.click('[role="dialog"] [role="tab"]', 'open original native Logs', 'Logs');
      epoch.visibleMessage = await visibleText('[role="dialog"] [role="tabpanel"][data-state="active"]', messageText!);
      epoch.visibleReply = await visibleText('[role="dialog"] [role="tabpanel"][data-state="active"]', reply);
      const observed = await waitFor(() => readRetainedNativeReply({ app: app!, teamName, memberName: memberName!, member: member!,
        expectedReply: reply, failures: model.failures, observe: value => { epoch.nativeRead = value; } }), 'same original native history tuple', 90_000);
      assert.deepEqual(observed, nativeReply!); epoch.nativeHistory = observed;
      const screenshot = await app.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(root, `donor-history-${kind}.png`), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
      await ui.click('[role="dialog"] button', 'close original member Logs', 'Close');
      if (kind === 'donor') {
        await ui.click('button', 'original scoped donor Stop', 'Stop');
        await waitFor(async () => !(await app!.call(`window.__TEST_retainedApi.teams.processAlive(${literal(teamName)})`)) || null,
          'original donor Stop', 60_000);
        proof.stop = { processAlive: false, processes: [...processes] };
      }
      await captureProcesses();
      const original = app.original, electron = app.electron;
      await app.close(); app = undefined;
      assert.equal(originalLinuxProcessPresent(original), false);
      assert.equal(originalLinuxProcessPresent(electron), false);
      assert.equal(processes.some(originalLinuxProcessPresent), false);
      const namespaceAfter = await testNamespaceLinuxProcesses(root, input.baseline);
      assert.deepEqual(namespaceAfter, []);
      epoch.quit = { launcherAbsent: true, electronAbsent: true, launcherExitCode: 0,
        launcherSignal: null, originalGroupReleased: true, namespaceAfter };
      epoch.inferenceAfterQuit = model.observations.length;
      assert.deepEqual(model.failures, []);
      if (kind === 'donor') {
        record(proof.stop).originalNativeAbsentAfterQuit = true;
        inferenceAtDonorQuit = model.observations.length;
        assert.equal(model.observations.filter(row => row.marker === marker).length, 1);
        proof.corpus = await input.preserveCorpus(teamName, taskId!);
      } else assert.equal(model.observations.length, inferenceAtDonorQuit, 'retained UI read never replays inference');
      await input.assertInputs();
    }
  } catch (error) {
    failure = error;
    if (app) {
      try { proof.failureUi = await captureRetainedDonorUiFailure(app, root, epochs.at(-1)); }
      catch (captureError) { proof.failureUi = { status: 'INCOMPLETE', unavailable: true,
        error: captureError instanceof Error ? captureError.message.slice(0,1000) : 'unavailable' }; }
    }
  }
  finally {
    if (app) {
      try { assert.equal(await app.cleanup(), true); } catch (error) { input.cleanupErrors.push(error); }
    }
    try {
      assert.equal(processes.some(originalLinuxProcessPresent), false);
      assert.deepEqual(await testNamespaceLinuxProcesses(root, input.baseline), []);
    } catch (error) { input.cleanupErrors.push(error); }
  }
  proof.inferenceAtDonorQuit = inferenceAtDonorQuit ?? null;
  if (failure) throw failure;
}
