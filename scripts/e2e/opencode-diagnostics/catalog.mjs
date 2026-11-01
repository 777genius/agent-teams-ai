import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { processes } from './platform.mjs';

export async function readPendingArtifact(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

export const catalogScenarios = [
  'delayed8s',
  'directory-error',
  'models-four-errors',
  'partial-success',
  'catalog-retry',
  'catalog-timeout',
];
const sources = ['opencode', 'anthropic', 'google', 'openrouter'];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fixture records are append ordered. A response belongs only to the latest start of
// its PID (Windows can reuse PIDs), and only to that start's operation/source.
function catalogFixtureRequests(calls) {
  const requests = [];
  const latest = new Map();
  for (const [index, event] of calls.entries()) {
    if (event.event === 'start') {
      const args = event.args ?? [];
      const scoped = (flag, value) => args[args.indexOf(flag) + 1] === value && args.includes(flag);
      const operation =
        args[0] === 'runtime' &&
        args[1] === 'status' &&
        args.includes('--summary') &&
        scoped('--provider', 'opencode')
          ? 'status'
          : args[0] === 'runtime' &&
              args[1] === 'providers' &&
              scoped('--runtime', 'opencode') &&
              ['directory', 'models'].includes(args[2])
            ? args[2]
            : null;
      const request = {
        start: event,
        index,
        operation,
        source: operation === 'models' ? args[args.indexOf('--provider') + 1] : null,
      };
      latest.set(event.pid, request);
      if (operation) requests.push(request);
    } else if (event.event === 'response') {
      const request = latest.get(event.pid);
      if (
        request?.operation &&
        request.operation === event.operation &&
        event.scenario === request.start.scenario &&
        event.at >= request.start.at &&
        (event.operation !== 'models' || event.source === request.source)
      )
        request.response = { ...event, index };
    }
  }
  return requests;
}

export function catalogRefreshEvidence(calls, { requireSummary = false } = {}) {
  const requests = catalogFixtureRequests(calls);
  const summary = requests.filter((r) => r.operation === 'status').at(-1);
  if (requireSummary && (!summary?.response || summary.response.failed)) return null;
  const directory = requests
    .filter(
      (r) =>
        r.operation === 'directory' &&
        (!requireSummary || (r.index > summary.response.index && r.start.at >= summary.response.at))
    )
    .at(-1);
  if (
    !directory?.response ||
    directory.response.failed ||
    !directory.start.args.includes('--summary')
  )
    return null;
  const models = sources.map((source) =>
    requests
      .filter(
        (r) =>
          r.operation === 'models' &&
          r.source === source &&
          r.index > directory.response.index &&
          r.start.at >= directory.response.at
      )
      .at(-1)
  );
  if (
    models.some(
      (r) =>
        !r?.response || r.response.failed || r.response.response?.models?.catalogState !== 'fresh'
    )
  )
    return null;
  if (requests.some((r) => !r.response)) return null;
  return { summary, directory, models };
}

export async function waitForReadyCatalog({ root, started, evaluate, send }) {
  for (let attempt = 0; attempt < 240; attempt++) {
    const calls = (await readPendingArtifact(path.join(root, 'calls.ndjson')))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
      .filter((c) => c.scenario === 'ready' && c.at >= started);
    const requests = catalogFixtureRequests(calls);
    // Drain the superseded work, which need not itself form a fresh generation.
    // Two overlapping directories may straddle the first source's model request.
    const drained =
      requests.some((r) => r.operation === 'directory' && r.response) &&
      sources.every((source) =>
        requests.some((r) => r.operation === 'models' && r.source === source && r.response)
      ) &&
      requests.every((r) => r.response);
    if (drained) {
      await writeFile(
        path.join(root, 'ready-catalog-subprocess.json'),
        JSON.stringify(calls, null, 2)
      );
      // A superseded overlapping generation may have painted a stale warning.
      // Recover through the real UI only after its requests drain, keeping the
      // scenario fixed until this new summary and catalog have both completed.
      await verifyCatalog({ root, scenario: 'ready', evaluate, send, requireSummary: true });
      return;
    }
    await pause(500);
  }
  assert.fail('Ready scenario catalog requests did not settle before the next fixture scenario');
}

export async function clickControl(evaluate, send, expression, preparePoint) {
  const readPoint = () => evaluate(`(() => { const b = ${expression}; if (!b || b.disabled) return null;
      b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  const point = await (preparePoint ? preparePoint(readPoint) : readPoint());
  assert(point, 'Required desktop control unavailable');
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
}

export function correlateReport(copied, logs) {
  const ids = [
    ...new Set([...copied.matchAll(/reportId[:=]\s*(oc-[a-f0-9]{32})/g)].map((m) => m[1])),
  ];
  assert(ids.length, 'No main report IDs in clipboard');
  for (const id of ids) assert(logs.includes(id), `Persistent main log missing ${id}`);
  return ids;
}

export async function verifyCatalog({
  root,
  scenario,
  evaluate,
  send,
  requireSummary = scenario === 'delayed8s',
}) {
  const save = (name, value) => writeFile(path.join(root, `${scenario}-${name}`), value);
  const screenshot = async (name) => {
    const shot = await send('Page.captureScreenshot');
    await save(`${name}.png`, Buffer.from(shot.data, 'base64'));
  };
  const click = (expression) => clickControl(evaluate, send, expression);
  const alert = `document.querySelector('[data-testid="opencode-catalog-error"]')`;
  const started = Date.now();
  try {
    // Existing dashboard action. No replacement APIs, synthetic responses or clipboard shims.
    await click(`[...document.querySelectorAll('button')].find(b =>
      /re-?check.*opencode|opencode.*re-?check/i.test(b.getAttribute('title') || ''))`);
    const previousClipboard = await evaluate('navigator.clipboard.readText()');
    const expectedFailures =
      scenario === 'models-four-errors'
        ? 4
        : scenario === 'partial-success'
          ? 3
          : ['directory-error', 'catalog-timeout'].includes(scenario)
            ? 1
            : 0;
    let calls = [];
    let text = '';
    let copied = '';
    let loadingCaptured = false;
    let completedCatalog;
    const maxAttempts = scenario === 'catalog-timeout' ? 660 : 240;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await pause(500);
      calls = (await readPendingArtifact(path.join(root, 'calls.ndjson')))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse)
        .filter((c) => c.scenario === scenario && c.at >= started);
      completedCatalog = catalogRefreshEvidence(calls, {
        requireSummary,
      });
      text = await evaluate('document.body.innerText');
      const visible = await evaluate(`${alert}?.innerText || ''`);
      if (scenario === 'delayed8s' && Date.now() - started < 7000) {
        assert(!visible, 'Delayed successful summary displayed an error before completion');
        if (!loadingCaptured && calls.some((c) => c.args?.[2] === 'directory')) {
          await screenshot('loading');
          loadingCaptured = true;
        }
      }
      if (expectedFailures && visible) {
        await click(`${alert}.querySelector('button')`);
        await pause(150);
        copied = await evaluate('navigator.clipboard.readText()');
        const ids = [...copied.matchAll(/origin=main reportId=(oc-[a-f0-9]{32})/g)];
        if (ids.length === expectedFailures && copied !== previousClipboard) break;
      } else if (
        !expectedFailures &&
        !visible &&
        completedCatalog &&
        (scenario !== 'delayed8s' ||
          completedCatalog.summary.response.at - completedCatalog.summary.start.at >= 7900) &&
        /fixture-model|Fixture .* model/.test(text)
      )
        break;
    }
    await save('ui.txt', text);
    await save('subprocess.json', JSON.stringify(calls, null, 2));
    const directoryStart = calls.find((c) => c.event === 'start' && c.args[2] === 'directory');
    assert(
      directoryStart?.args.includes('--summary'),
      'Dashboard did not request a real summary subprocess'
    );
    if (scenario === 'delayed8s') {
      assert(
        completedCatalog?.summary,
        'No completed provider summary and subsequent catalog refresh'
      );
      assert(
        completedCatalog.summary.response.at - completedCatalog.summary.start.at >= 7900,
        '8s status summary delay not observed'
      );
    }
    if (expectedFailures)
      assert.notEqual(copied, previousClipboard, 'Copy retained previous scenario report');
    const logs = await readPendingArtifact(path.join(root, 'user-data/logs/app-errors.ndjson'));
    assert(!logs.includes('DO_NOT_COPY_THIS_SECRET'));
    if (expectedFailures) {
      const ids = [...copied.matchAll(/origin=main reportId=(oc-[a-f0-9]{32})/g)].map((m) => m[1]);
      assert.equal(
        new Set(ids).size,
        expectedFailures,
        'Missing distinct main report IDs in actual clipboard'
      );
      correlateReport(copied, logs);
      if (scenario === 'models-four-errors' || scenario === 'partial-success') {
        for (const source of sources.filter(
          (s) => scenario !== 'partial-success' || s !== 'opencode'
        )) {
          assert(copied.includes(`provider_models source=${source}`));
          assert(calls.some((c) => c.event === 'response' && c.source === source && c.failed));
        }
      } else assert(copied.includes('provider_directory source=null'));
      if (scenario === 'catalog-timeout') {
        assert.match(copied, /timedOut: true/);
        assert.match(copied, /timeoutMs: 300000/);
        assert(Date.now() - directoryStart.at >= 299000);
        assert(!calls.some((c) => c.event === 'response' && c.pid === directoryStart.pid));
        const snapshot = processes();
        await save('timeout-processes.json', JSON.stringify(snapshot, null, 2));
        assert(
          !snapshot.some((p) => p.pid === directoryStart.pid),
          'Timed-out fixture subprocess is still present'
        );
      }
      assert.match(copied, /stage: runtime_command/);
      assert.match(copied, /Command: runtime providers (directory|models)/);
      assert.match(copied, /timeoutMs: 300000/);
      assert(!copied.includes('DO_NOT_COPY_THIS_SECRET'));
      await save('clipboard.txt', copied);
      await save(
        'main-log.ndjson',
        logs
          .split('\n')
          .filter((line) => ids.some((id) => line.includes(id)))
          .join('\n')
      );
    } else {
      assert(completedCatalog, 'No completed fresh catalog refresh');
      assert.equal(await evaluate(`${alert}?.innerText || ''`), '', 'Stale catalog error retained');
      assert.equal(
        new Set(
          calls
            .filter((c) => c.event === 'response' && c.operation === 'models' && !c.failed)
            .map((c) => c.source)
        ).size,
        4
      );
    }
    if (scenario === 'partial-success' || !expectedFailures)
      assert.match(
        text,
        /fixture-model|Fixture .* model/,
        'Successful models missing from real dashboard'
      );
    await screenshot('dashboard');
    if (expectedFailures) {
      await click(`${alert}?.querySelector('button[aria-expanded="false"]')`);
      let expanded = false;
      for (let attempt = 0; attempt < 20 && !expanded; attempt++) {
        expanded = await evaluate(`(() => {
        const trigger = ${alert}?.querySelector('button[aria-expanded="true"]');
        const content = trigger && document.getElementById(trigger.getAttribute('aria-controls'));
        if (!content || !content.getClientRects().length || !content.innerText.trim()) return false;
        for (let element = content; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          if (style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
        }
        return true;
        })()`);
        if (!expanded) await pause(50);
      }
      assert.equal(expanded, true, 'Diagnostic details are missing, collapsed, or empty');
      await screenshot('details');
    }

    // Independent normal preload IPC probe, explicitly a separate attempt from the UI.
    // Record its own IDs and correlate those to main logs, never substitute it into UI state.
    const inputs = expectedFailures > 1 ? sources : [null];
    const ipc = [];
    for (const source of inputs) {
      const input = source
        ? { runtimeId: 'opencode', providerId: source, projectPath: null, refresh: true }
        : {
            runtimeId: 'opencode',
            projectPath: null,
            summary: true,
            filter: 'all',
            limit: 100,
            refresh: true,
          };
      await evaluate(`window.__catalogProbe = {done:false};
        window.electronAPI.runtimeProviderManagement.${source ? 'loadModels' : 'loadProviderDirectory'}(${JSON.stringify(input)})
        .then(value => window.__catalogProbe = {done:true,value}, error => window.__catalogProbe = {done:true,error:String(error)}); void 0`);
      let result;
      for (let i = 0; i < maxAttempts; i++) {
        result = await evaluate('window.__catalogProbe');
        if (result.done) break;
        await pause(500);
      }
      assert(result?.done && !result.error, 'Normal preload IPC probe failed');
      assert.equal(result.value.schemaVersion, 1);
      const id = result.value.error?.diagnostics?.reportId;
      const shouldFail = source
        ? scenario === 'models-four-errors' ||
          (scenario === 'partial-success' && source !== 'opencode')
        : ['directory-error', 'catalog-timeout'].includes(scenario);
      assert.equal(Boolean(id), shouldFail, 'IPC error outcome differs from fixture scenario');
      if (scenario === 'catalog-timeout')
        assert.equal(result.value.error.diagnostics.timedOut, true);
      if (id)
        assert(
          (await readPendingArtifact(path.join(root, 'user-data/logs/app-errors.ndjson'))).includes(
            id
          )
        );
      ipc.push({ input, ...result });
    }
    await save('ipc.json', JSON.stringify(ipc, null, 2));
    console.log(JSON.stringify({ passed: true, scenario, root }));
  } catch (error) {
    try {
      await screenshot('failure');
    } catch {
      /* Preserve original failure. */
    }
    throw error;
  }
}
