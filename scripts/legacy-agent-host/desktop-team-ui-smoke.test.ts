import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';

import { desktopShellEnvironmentProbeSource } from './desktop-backend-fixture.ts';
import { readRendererBackendConnections } from './desktop-backend-observations.ts';
import { attachRendererDiagnostics } from './desktop-team-ui-smoke.ts';
import { desktopTaskBoardAssignmentReadyExpression } from './desktop-task-comment-input-target.ts';
import { runDesktopTaskBoardAttachmentsUi } from './desktop-task-board-attachments-ui.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const ready = { originMatches: true, mainReady: true, errorPresent: false, phase: 'ready',
  uiDidInit: true, storePresent: true, rootChildCount: 1 };
function fixture(reads: ReturnType<typeof deferred<Record<string, unknown>>>[]) {
  const listeners = new Map<string, (value: unknown) => void>();
  const acknowledgments = reads.map(() => deferred<void>());
  let observations = 0, discovery = 0;
  const cdp = {
    on(method: string, listener: (value: unknown) => void) { listeners.set(method, listener); },
    async send(method: string) {
      if (method === 'Runtime.enable') listeners.get('Runtime.executionContextCreated')?.({
        context: { id: 7, auxData: { isDefault: true, frameId: 'TEST-frame' } },
      });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'TEST-frame', url: 'http://localhost:5173/' } } };
      if (method === 'Runtime.evaluate') return { result: { value: { url: 'http://localhost:5173/', readyState: 'complete' } } };
      return {};
    },
    async evaluate(expression: string) {
      if (expression.startsWith('Boolean(')) return true;
      if (expression === 'window.electronAPI.agentBackend.getConnections()') {
        discovery++; return { state: 'ready', bindings: [] };
      }
      assert.ok(expression.includes('window.electronAPI.startup.getStatus()'), 'only public startup snapshot before discovery');
      const index = observations++;
      assert.ok(reads[index], 'no extra startup read after its original deadline');
      acknowledgments[index]!.resolve();
      return reads[index]!.promise;
    },
  };
  const evidence: Record<string, unknown> = {};
  const start = (remainingMs: number) => attachRendererDiagnostics(cdp, 'http://localhost:5173/', evidence,
    { remainingMs, assertOwnedRenderer() {} }).then(() => readRendererBackendConnections(cdp));
  return { start, acknowledgments, evidence, discovery: () => discovery };
}

test('captured UI discovery waits for Main admission and actual mount while early diagnostics remain active', { timeout: 5000 }, async () => {
  const reads = [deferred<Record<string, unknown>>(), deferred<Record<string, unknown>>(), deferred<Record<string, unknown>>()];
  const f = fixture(reads), pending = f.start(3000);
  await Promise.race([f.acknowledgments[0]!.promise, pending.then(() => { assert.fail('discovery completed before Main/UI readiness was observed'); })]);
  assert.equal(f.discovery(), 0);
  const diagnostics = f.evidence.rendererDiagnostics as { startup: { status: string }; };
  assert.equal(diagnostics.startup.status, 'DOCUMENT_READY', 'document diagnostics do not wait for full app admission');
  reads[0]!.resolve({ ...ready, mainReady: false, phase: 'team-backups' });
  await f.acknowledgments[1]!.promise; assert.equal(f.discovery(), 0);
  reads[1]!.resolve({ ...ready, uiDidInit: false, rootChildCount: 0 });
  await f.acknowledgments[2]!.promise; assert.equal(f.discovery(), 0);
  reads[2]!.resolve({ ...ready, storePresent: false }); // Packed builds expose no DEV store.
  assert.deepEqual(await pending, { kind: 'read', value: { state: 'ready', bindings: [] } });
  assert.equal(f.discovery(), 1);
});

test('the original remaining startup deadline rejects a pending snapshot without late discovery or a reset', { timeout: 5000 }, async () => {
  const held = deferred<Record<string, unknown>>(), f = fixture([held]);
  const pending = f.start(500);
  const rejected = assert.rejects(pending, /Main\/UI startup readiness timed out; no mutation retry/);
  await f.acknowledgments[0]!.promise; assert.equal(f.discovery(), 0);
  await rejected; assert.equal(f.discovery(), 0);
  held.resolve(ready); await setImmediate(); assert.equal(f.discovery(), 0);
});


function readinessRuntime(expression: string, href: string, origin: string): Promise<Record<string, unknown>> {
  return Promise.resolve(runInNewContext(expression, {
    URL,
    location: { href, origin },
    window: { __claudeTeamsUiDidInit: true,
      electronAPI: { startup: { getStatus: async () => ({ ready: true, phase: 'ready' }) } } },
    document: { getElementById: () => ({ childElementCount: 1 }) },
  }) as Promise<Record<string, unknown>>);
}
async function observedReadinessExpression(rendererUrl: string, runtimeOrigin: string): Promise<string> {
  const listeners = new Map<string, (value: unknown) => void>();
  let evaluated = '';
  const cdp = {
    on(method: string, listener: (value: unknown) => void) { listeners.set(method, listener); },
    async send(method: string) {
      if (method === 'Runtime.enable') listeners.get('Runtime.executionContextCreated')?.({
        context: { id: 7, auxData: { isDefault: true, frameId: 'TEST-packed-frame' } },
      });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'TEST-packed-frame', url: rendererUrl } } };
      if (method === 'Runtime.evaluate') return { result: { value: { url: rendererUrl, readyState: 'complete' } } };
      return {};
    },
    async evaluate(expression: string) {
      evaluated = expression;
      return readinessRuntime(expression, rendererUrl, runtimeOrigin);
    },
  };
  const evidence: Record<string, unknown> = {};
  await attachRendererDiagnostics(cdp, rendererUrl, evidence, { remainingMs: 1000, assertOwnedRenderer() {} });
  const diagnostics = evidence.rendererDiagnostics as { startup: { appReadiness: { status: string } } };
  assert.equal(diagnostics.startup.appReadiness.status, 'READY');
  assert.ok(evaluated);
  return evaluated;
}

test('packed file readiness executes the actual diagnostic expression using exact href instead of Electron opaque origin', { timeout: 5000 }, async () => {
  const expected = 'file:///Volumes/TEST%20candidate/Agent.app/Contents/Resources/app.asar/out/renderer/index.html';
  assert.equal(new URL(expected).origin, 'null');
  const expression = await observedReadinessExpression(expected, 'file://');
  for (const href of [expected, expected + '#same-document-route'])
    assert.equal((await readinessRuntime(expression, href, 'file://')).originMatches, true, href);
  for (const href of [
    expected.replace('index.html', 'other.html'),
    expected.replace('/TEST%20candidate/', '/OTHER/'),
    expected.replace('file:///', 'file://foreign/'),
    expected + '?different-document-input',
    'https://foreign.example/index.html', 'not a URL',
  ]) assert.equal((await readinessRuntime(expression, href, 'file://')).originMatches, false, href);
});

test('HTTP readiness keeps exact origin and document path guards when the runtime location origin is untrusted', { timeout: 5000 }, async () => {
  const expected = 'http://localhost:5173/index.html';
  const expression = await observedReadinessExpression(expected, 'http://localhost:5173');
  assert.equal((await readinessRuntime(expression, expected + '#same-document-route', 'http://localhost:5173')).originMatches, true);
  for (const href of ['http://localhost:5173/other.html', 'http://localhost:5174/index.html',
    'https://localhost:5173/index.html', 'http://foreign.example:5173/index.html'])
    assert.equal((await readinessRuntime(expression, href, 'http://localhost:5173')).originMatches, false, href);
});


test('isolated shell fixture emits the actual framed environment and refuses shell effects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-desktop-shell-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'shell-probe.mjs'), log = join(root, 'sentinel.ndjson');
  await writeFile(script, desktopShellEnvironmentProbeSource(process.execPath, log));
  const nonce = 'AGENT_TEAMS_SHELL_ENV_12345678-1234-1234-1234-123456789abc';
  const command = `command printf '\\0%s\\0' '${nonce}_START' && env -0 && command printf '\\0%s\\0' '${nonce}_END'`;
  const env = { TEST_ONLY_VALUE: 'exact fixture value' };
  const assertDump = (dump: string) => {
    assert.ok(dump.endsWith('\0'), 'the actual environment dump remains NUL terminated');
    const entries = dump.split('\0').filter(Boolean).map(entry => {
      const separator = entry.indexOf('=');
      assert.ok(separator > 0);
      return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
    });
    assert.equal(new Set(entries.map(([key]) => key)).size, entries.length);
    const observed = Object.fromEntries(entries);
    assert.equal(observed.TEST_ONLY_VALUE, env.TEST_ONLY_VALUE);
    const extra = entries.filter(([key]) => key !== 'TEST_ONLY_VALUE');
    // macOS may insert this Core Foundation value before the Node script starts.
    if (process.platform === 'darwin' && extra.length === 1) {
      assert.equal(extra[0]![0], '__CF_USER_TEXT_ENCODING');
      assert.match(extra[0]![1], /^0x[0-9a-f]+:0x[0-9a-f]+:0x[0-9a-f]+$/iu);
    } else assert.deepEqual(extra, []);
  };
  for (const mode of ['-lic', '-ic']) {
    const actual = execFileSync(process.execPath, [script, mode, command], { env }).toString();
    const start = `\0${nonce}_START\0`, end = `\0${nonce}_END\0`;
    assert.ok(actual.startsWith(start), 'exact original start marker');
    assert.ok(actual.endsWith(end), 'exact original end marker');
    assertDump(actual.slice(start.length, -end.length));
  }
  assertDump(execFileSync(process.execPath, [script, '-ic', 'env -0'], { env }).toString());
  for (const refused of [command + '; touch arbitrary', command.replace('_END', '_OTHER'), 'env -0 && arbitrary']) {
    assert.throws(() => execFileSync(process.execPath, [script, '-lic', refused], { env, stdio: 'pipe' }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && error.status === 78));
  }
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { allowed: boolean });
  assert.deepEqual(calls.map(call => call.allowed), [true, true, true, false, false, false]);
});

function assignmentRuntime(stage?: 'in-progress-comment') {
  const identity = {
    contextId: 'TEST-context',
    teamName: 'host-team:TEST-owner',
    taskId: 'TEST-task',
  };
  const captured = { contextId: identity.contextId, surfaceId: 'TEST-original-surface' };
  const controller = {
    identity,
    surfaceId: captured.surfaceId,
    isOwner: true,
    canSubmit: true,
    attachmentError: null,
    session: {
      ownerSurfaceId: captured.surfaceId,
      ownerRevision: 1,
      commentText: '',
      partRevisions: { commentText: 0, pendingAttachments: 0 },
      submitPending: false,
      submitError: null,
      pendingAttachments: [],
      pendingAttachmentPreparationIds: [],
    },
  };
  const root = { return: null, stateNode: {} as { current: unknown } };
  root.stateNode.current = root;
  const dialogFiber = {
    return: root,
    memoizedProps: {
      open: true,
      teamName: identity.teamName,
      task: { id: identity.taskId },
      sessionController: controller,
    },
  };
  const trigger = {
    disabled: false,
    expanded: 'false',
    textContent: 'alice',
    getAttribute() {
      return this.expanded;
    },
  };
  const triggers = [trigger];
  const dialog = {
    __reactFiber$TEST: dialogFiber,
    getClientRects: () => [1],
    querySelectorAll(selector: string): unknown[] {
      return selector === 'textarea'
        ? [input]
        : selector === 'button[role="combobox"]'
          ? triggers
          : [];
    },
  };
  const input = {
    id: 'TEST-original-comment',
    disabled: false,
    getClientRects: () => [1],
    closest: () => dialog,
    __reactFiber$TEST: {
      return: dialogFiber,
      memoizedProps: {
        controller,
        contextId: identity.contextId,
        teamName: identity.teamName,
        taskId: identity.taskId,
        surfaceId: captured.surfaceId,
      },
    },
  };
  const detail = {
    identity: { ...identity },
    phase: 'ready',
    loading: false,
    refreshPending: false,
    full: { id: identity.taskId, owner: 'alice', status: 'pending' },
  };
  const state = {
    activeContextId: identity.contextId,
    selectedTeamName: identity.teamName,
    isContextSwitching: false,
    taskDetailById: { [JSON.stringify(Object.values(identity))]: detail },
  };
  const work = { refreshPending: false, teamUnavailable: false };
  const imports: string[] = [];
  const expression = desktopTaskBoardAssignmentReadyExpression(
    'TEST-owner',
    identity.taskId,
    captured,
    stage
  );
  assert.equal(
    expression.match(/await import\(/g)?.length,
    2,
    'only the two existing read-only observer modules'
  );
  const evaluate = () =>
    Promise.resolve(
      runInNewContext(expression.replaceAll('await import(', 'await __testImport('), {
        window: { __agentTeamsDevStore: { getState: () => state } },
        document: {
          getElementById: () => input,
          querySelectorAll: (selector: string) =>
            selector === '[role="dialog"]' ? [dialog] : selector === 'textarea' ? [input] : [],
        },
        async __testImport(path: string) {
          imports.push(path);
          if (path === '/store/slices/teamSlice.ts')
            return {
              isTeamDataRefreshPending(team: string) {
                assert.equal(team, identity.teamName);
                return work.refreshPending;
              },
            };
          assert.equal(path, '/store/team/taskDetailReadAuthority.ts');
          return {
            captureTaskDetailReadScope(teamName: string, contextId: string) {
              assert.deepEqual(
                { teamName, contextId },
                { teamName: identity.teamName, contextId: captured.contextId }
              );
              return { teamName, contextId };
            },
            isTaskDetailTeamUnavailable(observed: unknown, team: string, scope: unknown) {
              assert.equal(observed, state);
              assert.equal(team, identity.teamName);
              assert.deepEqual(scope, {
                teamName: identity.teamName,
                contextId: captured.contextId,
              });
              return work.teamUnavailable;
            },
          };
        },
      }) as Promise<Record<string, unknown> | null>
    );
  return { evaluate, imports, state, detail, controller, trigger, triggers, work };
}

test('original in-progress Task comment prerequisite requires its exact stage without an assignment control', async () => {
  const commentRuntime = () => {
    const f = assignmentRuntime('in-progress-comment');
    f.detail.full.status = 'in_progress';
    f.triggers.length = 0; // The real in-progress header renders an owner badge.
    return f;
  };
  const ready = await commentRuntime().evaluate();
  assert.equal(ready?.surfaceId, 'TEST-original-surface');
  for (const change of [
    (f: ReturnType<typeof commentRuntime>) => { f.detail.full.status = 'pending'; },
    (f: ReturnType<typeof commentRuntime>) => { f.detail.full.status = 'completed'; },
    (f: ReturnType<typeof commentRuntime>) => { f.detail.full.owner = 'bob'; },
    (f: ReturnType<typeof commentRuntime>) => { f.triggers.push(f.trigger); },
    (f: ReturnType<typeof commentRuntime>) => { f.work.refreshPending = true; },
    (f: ReturnType<typeof commentRuntime>) => { f.detail.refreshPending = true; },
    (f: ReturnType<typeof commentRuntime>) => { f.detail.loading = true; },
    (f: ReturnType<typeof commentRuntime>) => { f.detail.phase = 'unavailable'; },
    (f: ReturnType<typeof commentRuntime>) => { f.work.teamUnavailable = true; },
    (f: ReturnType<typeof commentRuntime>) => { f.state.activeContextId = 'foreign-context'; },
    (f: ReturnType<typeof commentRuntime>) => { f.state.selectedTeamName = 'host-team:foreign'; },
    (f: ReturnType<typeof commentRuntime>) => { f.detail.identity.taskId = 'foreign-task'; },
    (f: ReturnType<typeof commentRuntime>) => { f.controller.surfaceId = 'foreign-surface'; },
    (f: ReturnType<typeof commentRuntime>) => { f.controller.isOwner = false; },
  ]) {
    const f = commentRuntime();
    change(f);
    assert.equal(await f.evaluate(), null);
  }
  const assignment = assignmentRuntime();
  assignment.triggers.length = 0;
  assert.equal(await assignment.evaluate(), null, 'default assignment still requires its control');
});

test('Task attachment comment waits for its original focused owner after one click before inserting text', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-attachment-comment-focus-')));
  try {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=',
      'base64'
    );
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(png).digest('hex');
    const selector = '[role="dialog"] textarea[id="TEST-original-comment"]';
    const owner = {
      selector,
      identity: { contextId: 'TEST-context' },
      surfaceId: 'TEST-original-surface',
      inputId: 'TEST-original-comment',
      ownerRevision: 3,
      commentText: '',
      submitPending: false,
      submitError: null,
      pendingAttachmentCount: 0,
      pendingPreparationCount: 0,
      canSubmit: true,
      attachmentError: null,
    };
    const ready = {
      owner,
      settled: true,
      domValue: '',
      inputEnabled: true,
      visibility: 'visible',
      focused: true,
      documentFocused: true,
    };
    const afterFocus = [
      { ...ready, owner: null, settled: false, domValue: null, inputEnabled: false },
      {
        ...ready,
        owner: { ...owner, selector: '[role="dialog"] textarea[id="TEST-rebound-comment"]' },
      },
      { ...ready, focused: false },
      ready,
    ];
    let focused = false,
      focusClicks = 0,
      postFocusReads = 0,
      insertions = 0,
      fileInputs = 0;
    const inserted = new Error('TEST original insertion reached after readiness');
    const cdp = {
      async evaluate(expression: string) {
        if (expression.includes('const settled=await')) {
          if (!focused) return { ...ready, focused: false };
          assert.ok(
            postFocusReads < afterFocus.length,
            'no read beyond the original settled focus'
          );
          return afterFocus[postFocusReads++]!;
        }
        if (expression.startsWith('Boolean(')) return true;
        if (expression.includes('const currentFiber=')) return owner;
        if (expression.includes('naturalWidth===2'))
          return { src: `data:image/png;base64,${png.toString('base64')}`, width: 2, height: 1 };
        if (expression.includes('let parent=e.parentElement')) return { visible: true };
        if (expression.includes('const elements =')) return { x: 10, y: 20 };
        throw new Error('unexpected TEST observer expression');
      },
      async send(method: string, params?: Record<string, unknown>) {
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelectorAll') return { nodeIds: [2] };
        if (method === 'DOM.setFileInputFiles') {
          fileInputs++;
          return {};
        }
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
          focusClicks++;
          focused = true;
        }
        if (method === 'Input.insertText') {
          insertions++;
          assert.equal(params?.text, 'TEST attachment comment original');
          assert.equal(
            postFocusReads,
            afterFocus.length,
            'missing, rebound and unfocused owners were refused'
          );
          throw inserted;
        }
        return {};
      },
    };
    const image = { filename: 'TEST-task-owned.png', artifactId: digest, mimeType: 'image/png' };
    await assert.rejects(
      runDesktopTaskBoardAttachmentsUi(cdp, {
        root,
        taskId: 'TEST-task',
        subject: 'TEST task',
        handleId: 'TEST-owner',
        proof: {},
        assertOwnedRenderer() {},
        step() {},
        async task() {
          return { attachments: [image] };
        },
        async commands() {
          return [];
        },
        async receiptFor() {
          return {
            phase: 'completed',
            command: {
              payload: {
                attachment: {
                  artifactId: digest,
                  byteLength: png.length,
                  digest,
                  mimeType: image.mimeType,
                },
              },
            },
          };
        },
        async waitProduct<T>(
          read: () => Promise<T>,
          matches: (value: T) => boolean,
          label: string
        ) {
          for (let observation = 0; observation < 6; observation++) {
            const value = await read();
            if (matches(value)) return value;
          }
          throw new Error(`TEST original readiness did not settle: ${label}`);
        },
        async screenshot() {
          return { path: join(root, 'TEST-image.png'), sha256: digest };
        },
      }),
      (error) => error === inserted
    );
    assert.equal(focusClicks, 1, 'the original focus action is never replayed');
    assert.equal(fileInputs, 1, 'only the original image was uploaded before comment insertion');
    assert.equal(insertions, 1, 'one insertion follows the exact original readiness');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('original Task assignment prerequisite refuses receipt-only, pending and stale renderer state', async () => {
  const f = assignmentRuntime();
  f.work.refreshPending = true;
  assert.equal(
    await f.evaluate(),
    null,
    'physical receipt does not settle the original UI refresh'
  );
  f.work.refreshPending = false;
  f.detail.refreshPending = true;
  assert.equal(await f.evaluate(), null);
  f.detail.refreshPending = false;
  f.detail.loading = true;
  assert.equal(await f.evaluate(), null);
  f.detail.loading = false;
  f.detail.full.owner = 'bob';
  assert.equal(await f.evaluate(), null, 'retained pre-assignment full Task is not completion');
  f.detail.full.owner = 'alice';
  f.work.teamUnavailable = true;
  assert.equal(
    await f.evaluate(),
    null,
    'visible Task alone is not current accepted live authority'
  );
  f.work.teamUnavailable = false;
  const result = await f.evaluate();
  assert.equal(result?.surfaceId, 'TEST-original-surface');
  assert.equal((result?.identity as { contextId: string }).contextId, 'TEST-context');
  assert.deepEqual(
    [...new Set(f.imports)],
    ['/store/slices/teamSlice.ts', '/store/team/taskDetailReadAuthority.ts']
  );
});

test('original Task assignment prerequisite rejects a foreign context, Team, Task or rebound surface', async () => {
  for (const change of [
    (f: ReturnType<typeof assignmentRuntime>) => {
      f.state.activeContextId = 'foreign-context';
    },
    (f: ReturnType<typeof assignmentRuntime>) => {
      f.state.selectedTeamName = 'host-team:foreign';
    },
    (f: ReturnType<typeof assignmentRuntime>) => {
      f.detail.identity.taskId = 'foreign-task';
    },
    (f: ReturnType<typeof assignmentRuntime>) => {
      f.controller.surfaceId = 'foreign-surface';
    },
    (f: ReturnType<typeof assignmentRuntime>) => {
      f.controller.isOwner = false;
    },
    (f: ReturnType<typeof assignmentRuntime>) => {
      f.trigger.expanded = 'true';
    },
    (f: ReturnType<typeof assignmentRuntime>) => {
      f.trigger.textContent = 'bob';
    },
  ]) {
    const f = assignmentRuntime();
    change(f);
    assert.equal(await f.evaluate(), null);
  }
});
