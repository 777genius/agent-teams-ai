import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { processes } from './platform.mjs';

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

export async function verifyCatalog({ root, scenario, evaluate, send }) {
  const save = (name, value) => writeFile(path.join(root, `${scenario}-${name}`), value);
  const screenshot = async (name) => {
    const shot = await send('Page.captureScreenshot');
    await save(`${name}.png`, Buffer.from(shot.data, 'base64'));
  };
  const click = async (expression) => {
    const point =
      await evaluate(`(() => { const b = ${expression}; if (!b || b.disabled) return null;
      b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    assert(point, 'Required desktop control unavailable');
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
  };
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
    for (let attempt = 0; attempt < 240; attempt++) {
      await pause(500);
      calls = (await readFile(path.join(root, 'calls.ndjson'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse)
        .filter((c) => c.scenario === scenario && c.at >= started);
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
        calls.filter((c) => c.event === 'response' && c.operation === 'models').length >= 4 &&
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
      const summaryStart = calls.find(
        (c) =>
          c.event === 'start' &&
          c.args[0] === 'runtime' &&
          c.args[1] === 'status' &&
          c.args.includes('--summary')
      );
      assert(summaryStart, 'No actual provider status summary subprocess');
      const end = calls.find((c) => c.event === 'response' && c.pid === summaryStart.pid);
      assert(end && end.at - summaryStart.at >= 7900, '8s status summary delay not observed');
    }
    if (expectedFailures)
      assert.notEqual(copied, previousClipboard, 'Copy retained previous scenario report');
    const logs = await readFile(path.join(root, 'user-data/logs/app-errors.ndjson'), 'utf8');
    assert(!logs.includes('DO_NOT_COPY_THIS_SECRET'));
    if (expectedFailures) {
      const ids = [...copied.matchAll(/origin=main reportId=(oc-[a-f0-9]{32})/g)].map((m) => m[1]);
      assert.equal(
        new Set(ids).size,
        expectedFailures,
        'Missing distinct main report IDs in actual clipboard'
      );
      for (const id of ids) assert(logs.includes(id), `Persistent main log missing ${id}`);
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
        assert.match(copied, /timeoutMs: 90000/);
        assert(Date.now() - directoryStart.at >= 89000);
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
      assert.match(copied, /timeoutMs: 90000/);
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
      const expanded = await evaluate(`(() => {
        const trigger = ${alert}?.querySelector('button[aria-expanded="true"]');
        const content = trigger && document.getElementById(trigger.getAttribute('aria-controls'));
        return Boolean(content && content.getClientRects().length && content.innerText.trim());
      })()`);
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
      for (let i = 0; i < 240; i++) {
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
          (await readFile(path.join(root, 'user-data/logs/app-errors.ndjson'), 'utf8')).includes(id)
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
