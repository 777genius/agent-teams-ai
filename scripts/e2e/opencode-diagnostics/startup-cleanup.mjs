import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, lstat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export const cleanupScenario = 'startup-cleanup';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Startup may create empty global hook queues, but never team or event state.
async function assertEmptyHookInfrastructure(dir, relative = '') {
  const directories = new Set([
    '',
    'runtime-hooks',
    ...['incoming', 'processing', 'processed', 'invalid', 'bin'].map(
      (name) => `runtime-hooks/${name}`
    ),
  ]);
  const info = await lstat(dir);
  assert(!info.isSymbolicLink(), `Linked hook infrastructure: ${dir}`);
  if (relative === 'runtime-hooks/bin/turn-settled-hook-v1.sh') {
    assert(info.isFile(), `Invalid installed hook: ${dir}`);
    return;
  }
  assert(info.isDirectory() && directories.has(relative), `Unexpected hook state: ${dir}`);
  for (const entry of await readdir(dir)) {
    await assertEmptyHookInfrastructure(
      path.join(dir, entry),
      relative ? `${relative}/${entry}` : entry
    );
  }
}

// Treat unexpected links/files as failure, never follow them.
export async function assertEmptyCleanupState(root) {
  const homes = [
    'home/.claude/teams',
    'home/.claude/tasks',
    'home/.claude/projects',
    'home/.claude/todos',
    'home/.local/share/opencode',
    'home/AppData/Roaming/opencode',
    'home/AppData/Local/opencode',
  ];
  for (const relative of homes) {
    let dir = root;
    let missing = false;
    for (const component of relative.split('/')) {
      dir = path.join(dir, component);
      let info;
      try {
        info = await lstat(dir);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing = true;
        break;
      }
      assert(
        info.isDirectory() && !info.isSymbolicLink(),
        `Unexpected team/task/session state: ${dir}`
      );
    }
    if (!missing) {
      const entries = await readdir(dir);
      if (relative === 'home/.claude/teams' && entries.includes('.member-work-sync')) {
        await assertEmptyHookInfrastructure(path.join(dir, '.member-work-sync'));
        entries.splice(entries.indexOf('.member-work-sync'), 1);
      }
      assert.deepEqual(entries, [], `Unexpected team/task/session state: ${dir}`);
    }
  }
  return homes;
}

export async function seedStartupCleanup(root) {
  assert.equal(process.platform, 'win32', 'Startup cleanup E2E is Windows-only');
  await mkdir(path.join(root, 'cleanup-control'));
  await assertEmptyCleanupState(root);
}

export async function verifyStartupCleanup({ root, evaluate, send }) {
  assert.equal(process.platform, 'win32', 'Startup cleanup E2E is Windows-only');
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert(Number.isSafeInteger(manifest.cleanupLaunchStartedAt));
  // Harness bound includes Electron startup and two separately budgeted cleanup attempts.
  // It never renews on polling; production admission deadlines remain independently recorded.
  const deadline = manifest.cleanupLaunchStartedAt + 360000;
  const evidence = { scenario: cleanupScenario, launchSubmitted: false, observations: [] };
  const checkTime = () =>
    assert(Date.now() < deadline, 'Cleanup E2E 360s observation limit exhausted');
  const events = async () => {
    let raw;
    try {
      raw = await readFile(path.join(root, 'calls.ndjson'), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    // Ignore an in-progress final journal append, not a malformed complete record.
    const rows = raw
      .slice(0, raw.lastIndexOf('\n') + 1)
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
    assert(!rows.some((e) => e.event === 'refused'), 'Forbidden fixture command attempted');
    return rows;
  };
  const accepted = async () => (await events()).filter((e) => e.event === 'accepted');
  const poll = async (fn) => {
    for (;;) {
      checkTime();
      const value = await fn();
      if (value) return value;
      await pause(100);
    }
  };
  const button = (label) =>
    `[...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
  const click = async (expression) => {
    checkTime();
    const point =
      await evaluate(`(() => { const b = ${expression}; if (!b || b.disabled) return null;
      b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect();
      return r.width && r.height ? {x:r.x+r.width/2,y:r.y+r.height/2} : null; })()`);
    assert(point, 'Required cleanup control unavailable');
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    return point;
  };
  const capture = async (state) => {
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    assert(typeof screenshot.data === 'string', 'Cleanup screenshot unavailable');
    const filename = `startup-cleanup-${state}.png`;
    await writeFile(path.join(root, filename), Buffer.from(screenshot.data, 'base64'));
    (evidence.screenshots ??= []).push(filename);
  };
  const status = () => evaluate('window.electronAPI.startup.getOpenCodeCleanupStatus()');
  const ui = () => evaluate(`document.querySelector('[role="dialog"]')?.innerText || ''`);
  const count = async (n) =>
    assert.equal((await accepted()).length, n, 'Unexpected cleanup dispatch');
  const observe = async (state, requestId) => {
    const value = await status();
    assert.deepEqual(value, { state, requestId });
    evidence.observations.push({ at: Date.now(), ...value });
    await assertEmptyCleanupState(root);
  };
  const release = async (requestId, coverage) => {
    const file = path.join(root, 'cleanup-control', requestId + '.release.json');
    await writeFile(file + '.tmp', JSON.stringify({ requestId, coverage }), { flag: 'wx' });
    await rename(file + '.tmp', file);
    const written = await poll(async () =>
      (await events()).find((e) => e.event === 'response-written' && e.requestId === requestId)
    );
    await observe('pending', requestId); // publication is not owner completion
    await poll(async () =>
      (await events()).find((e) => e.event === 'exit' && e.requestId === requestId && e.code === 0)
    );
    return written.at;
  };
  try {
    const first = await poll(async () => (await accepted())[0]);
    evidence.ownerStartedAt = first.request.body.deadlineUnixMs - 120000;
    evidence.attemptDeadlines = [first.request.body.deadlineUnixMs];
    await count(1);
    await observe('pending', first.requestId);
    const manage = `(() => { const label = [...document.querySelectorAll('span')].find(s => s.textContent.trim() === 'OpenCode (200+ models)' && s.classList.contains('truncate'));
      const row = label?.closest('div.grid'); return [...(row?.querySelectorAll('button') || [])].find(b => b.textContent.trim() === 'Manage'); })()`;
    await poll(async () => {
      if (await evaluate(`Boolean(${manage})`)) return true;
      const expand = `document.querySelector('[role="button"][aria-expanded="false"][aria-label*="provider" i]')`;
      if (await evaluate(`Boolean(${expand})`)) await click(expand);
      return false;
    });
    await click(manage);
    await poll(async () => /OpenCode startup cleanup is still running/.test(await ui()));
    assert(
      await evaluate(
        `Boolean(document.querySelector('[role="dialog"] [role="tab"][data-state="active"]')?.textContent.includes('OpenCode'))`
      ),
      'OpenCode settings not selected'
    );
    await capture('pending');
    for (let i = 0; i < 3; i++) {
      await click(button('Check cleanup'));
      await poll(async () => await evaluate(`Boolean(${button('Check cleanup')})`));
      await observe('pending', first.requestId);
      assert.match(await ui(), /OpenCode startup cleanup is still running/);
      assert((await ui()).includes(first.requestId));
      await count(1);
    }
    // Store only promise observations. No API replacement or application state injection.
    await evaluate(`(() => { window.__cleanupRetryObservation = {done:false};
      Promise.all([window.electronAPI.startup.retryOpenCodeCleanup(), window.electronAPI.startup.retryOpenCodeCleanup()])
      .then(values => { window.__cleanupRetryObservation = {done:true,values}; }, error => {
        window.__cleanupRetryObservation = {done:true,error:String(error)}; }); return true; })()`);
    await pause(500);
    await count(1);
    await observe('pending', first.requestId);
    const firstWritten = await release(first.requestId, 'partial');
    await poll(async () => {
      if ((await status()).state !== 'partial') return false;
      assert(Date.now() - firstWritten >= 8000, 'Partial status preceded tail drainage');
      await click(button('Check cleanup'));
      return true;
    });
    await poll(async () => /OpenCode startup cleanup was partial/.test(await ui()));
    assert(Date.now() - firstWritten >= 8000, 'Partial UI preceded tail drainage');
    const concurrent = await poll(() =>
      evaluate('window.__cleanupRetryObservation.done && window.__cleanupRetryObservation')
    );
    assert(!concurrent.error, concurrent.error);
    assert.deepEqual(
      concurrent.values,
      Array(2).fill({ state: 'pending', requestId: first.requestId })
    );
    evidence.concurrentPreloadRetries = concurrent.values;
    await observe('partial', first.requestId);
    await capture('partial');
    await count(1);
    await click(button('Retry OpenCode cleanup'));
    const second = await poll(async () => (await accepted())[1]);
    assert.notEqual(second.requestId, first.requestId);
    evidence.attemptDeadlines.push(second.request.body.deadlineUnixMs);
    assert(second.request.body.deadlineUnixMs > first.request.body.deadlineUnixMs);
    await count(2);
    await observe('pending', second.requestId);
    const busy = button('Checking cleanup…');
    assert(await evaluate(`Boolean(${busy}?.disabled)`), 'Retry must be busy while held');
    // Real input against the disabled control, not HTMLElement.click().
    const point = await evaluate(
      `(() => { const r=(${busy}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`
    );
    for (let i = 0; i < 2; i++)
      for (const type of ['mousePressed', 'mouseReleased'])
        await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    await pause(500);
    await count(2);
    assert(await evaluate(`Boolean(${busy}?.disabled)`));
    const secondWritten = await release(second.requestId, 'complete');
    await poll(async () => {
      const current = await status();
      evidence.lastStatus = current;
      assert.equal(
        current.requestId,
        second.requestId,
        'Cleanup result belongs to another attempt'
      );
      assert(
        current.state === 'pending' || current.state === 'complete',
        `Cleanup retry finished with ${current.state}; inspect desktop.log for scan/transport diagnostics`
      );
      return (
        current.state === 'complete' &&
        /OpenCode cleanup finished. You can start the team manually./.test(await ui())
      );
    });
    await observe('complete', second.requestId);
    await capture('complete');
    assert(Date.now() - secondWritten >= 8000, 'Complete UI preceded tail drainage');
    await count(2);
    evidence.events = await events();
    evidence.emptyStatePaths = await assertEmptyCleanupState(root);
    evidence.proofScope =
      'Zero submitted launches; UI recovery and supplemental preload coalescing. No proof of rejected-launch queueing, native host discovery, taskkill drainage or real registry mutation.';
    evidence.completedAt = Date.now();
    checkTime();
    evidence.passed = true;
    console.log(JSON.stringify(evidence));
  } catch (error) {
    evidence.passed = false;
    evidence.error = String(error);
    try {
      await capture('failure');
    } catch (captureError) {
      evidence.screenshotError = String(captureError);
    }
    throw error;
  } finally {
    await writeFile(
      path.join(root, 'startup-cleanup-evidence.json'),
      JSON.stringify(evidence, null, 2)
    );
  }
}
