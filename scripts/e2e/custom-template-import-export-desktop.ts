/**
 * Disposable Linux desktop E2E for custom-template JSON import/export.
 * Run with a test DISPLAY: pnpm exec tsx scripts/e2e/custom-template-import-export-desktop.ts
 * Native dialog selections are fixtures. UI, preload IPC, validation, SQLite,
 * file reads and atomic exports are real; no provider or user project is used.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Existing transport used by the other desktop harnesses.
// @ts-expect-error Existing JavaScript CDP helper has no declaration file.
import { CdpClient } from './comment-notification/cdp.mjs';

interface Cdp {
  evaluate(expression: string): Promise<unknown>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
  on(method: string, callback: (params: unknown) => void): void;
}
interface Template {
  templateId: string;
  name: string;
  revision: number;
  teamPrompt: string;
  members: { name: string; role: string; workflow?: string }[];
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.platform, 'linux', 'This harness uses a disposable Linux desktop');
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'custom-template-TEST-')));
const output = process.env.CUSTOM_TEMPLATE_E2E_OUTPUT_DIR ?? path.join(root, 'evidence');
const claude = path.join(root, 'claude');
const userData = path.join(root, 'user-data');
const statePath = path.join(root, 'native-dialog.json');
const dialogAudit = path.join(root, 'native-dialog-audit.ndjson');
const runtimeAudit = path.join(root, 'runtime-audit.ndjson');
const runtime = path.join(root, 'deny-runtime.ts');
const fixtureJson = path.join(root, 'portable.json');
const exportedJson = path.join(root, 'exported.json');
const invalidJson = path.join(root, 'invalid.json');
const invalidEncoding = path.join(root, 'invalid-utf8.json');
const descriptionTooLong = path.join(root, 'description-too-long.json');
const receipt: Record<string, unknown> = {
  scope: 'Linux dev:mcp; fixture native dialogs; real renderer, IPC, SQLite and filesystem',
  root,
  output,
  passed: false,
  checks: [] as string[],
};
const checks = receipt.checks as string[];
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let app: ChildProcess | undefined;
let cdp: Cdp | undefined;
let logs = '';
const rendererErrors: unknown[] = [];
let port: number | undefined;

const portable = {
  format: 'agent-teams-custom-template',
  schemaVersion: 1,
  name: 'Portable review 日本語',
  description: 'Reusable review team — пример',
  teamPrompt: 'Review the proposed change.\nПроверь сохранение данных.',
  members: [{ name: 'reviewer', role: 'Reviewer', workflow: 'Inspect\nTest\nReport' }],
};

await Promise.all([claude, userData, output].map((dir) => mkdir(dir, { recursive: true })));
await writeFile(fixtureJson, JSON.stringify(portable, null, 2));
await writeFile(invalidJson, '{invalid');
await writeFile(invalidEncoding, Buffer.from([0xc3, 0x28]));
await writeFile(descriptionTooLong, JSON.stringify({ ...portable, description: 'x'.repeat(2001) }));
await writeFile(dialogAudit, '');
await writeFile(runtimeAudit, '');
await writeFile(
  path.join(claude, 'agent-teams-config.json'),
  JSON.stringify({
    general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
  })
);
const version = JSON.parse(await readFile(path.join(repo, 'runtime.lock.json'), 'utf8')).version;
await writeFile(
  runtime,
  `#!${await realpath(process.execPath)}\nimport { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(runtimeAudit)}, JSON.stringify(args) + '\\n');
if (args.length === 1 && args[0] === '--version') console.log(${JSON.stringify(version)});
else process.exitCode = 77;
`
);
await chmod(runtime, 0o755);

// Replace only OS dialog selection in the disposable main bundle, before the
// production adapter is imported. No renderer API or storage response is mocked.
const nativeDialogFixture = `
if (process.type === 'browser' && require('node:worker_threads').isMainThread) {
  const fs = require('node:fs');
  const path = require('node:path');
  const dialog = require('electron').dialog;
  const choose = (kind, args) => {
    const selection = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
    if (selection.kind !== kind) throw new Error('Unexpected test dialog: ' + kind);
    if (selection.path && !path.resolve(selection.path).startsWith(${JSON.stringify(root + path.sep)})) {
      throw new Error('Dialog fixture escaped its disposable directory');
    }
    fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({kind:'consumed'}));
    fs.appendFileSync(${JSON.stringify(dialogAudit)}, JSON.stringify({kind, selection, options: args.at(-1)}) + '\\n');
    if (selection.fail) throw new Error('Synthetic native picker failure');
    return selection;
  };
  dialog.showOpenDialog = async (...args) => {
    const selection = choose('open', args);
    return {canceled: !selection.path, filePaths: selection.path ? [selection.path] : []};
  };
  dialog.showSaveDialog = async (...args) => {
    const selection = choose('save', args);
    return {canceled: !selection.path, filePath: selection.path};
  };
}
`;
const rendererPort = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    assert(address && typeof address !== 'string');
    server.close(() => resolve(address.port));
  });
});
const configPath = path.join(root, 'electron.e2e.config.ts');
await writeFile(
  configPath,
  `import config from ${JSON.stringify(path.join(repo, 'electron.vite.config.ts'))};
const output = config.main.build.rollupOptions.output;
export default {...config,
  main: {...config.main, build: {...config.main.build, rollupOptions: {...config.main.build.rollupOptions,
    output: {...output, banner: output.banner + ';\\n' + ${JSON.stringify(nativeDialogFixture)}}}}},
  renderer: {...config.renderer, server: {...config.renderer.server, port: ${rendererPort}, strictPort: true}}
};\n`
);

async function evaluate<T>(expression: string): Promise<T> {
  assert(cdp, 'Owned renderer must be connected');
  return (await cdp.evaluate(expression)) as T;
}
async function until(expression: string, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return;
    } catch (error) {
      if (
        !/execution context was destroyed|cannot find.*execution context|cannot find context with specified id/i.test(
          String(error)
        )
      )
        throw error;
    }
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}
const topDialog = `Array.from(document.querySelectorAll('[role="dialog"]')).at(-1)`;
const button = (text: string, within = 'document') =>
  `Array.from(${within}.querySelectorAll('button')).find(e => e.textContent?.trim() === ${JSON.stringify(text)} && !e.disabled)`;
async function click(expression: string) {
  await until(
    `(() => { const e = ${expression}; if (!(e instanceof HTMLElement)) return false;
    e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect();
    const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return r.width>0 && r.height>0 && (hit===e || e.contains(hit)); })()`,
    'unobstructed click target'
  );
  const point = await evaluate<{ x: number; y: number }>(
    `(() => { const r = (${expression}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`
  );
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp!.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  }
}
async function screenshot(name: string) {
  await pause(250);
  await cdp!.screenshot(path.join(output, name + '.png'));
}
async function selection(kind: 'open' | 'save', chosenPath?: string, fail = false) {
  await writeFile(statePath, JSON.stringify({ kind, path: chosenPath, fail }));
}
async function library(): Promise<Template[]> {
  const result = await evaluate<{ status: string; templates?: Template[] }>(
    'window.electronAPI.customTeamTemplates.listTemplates()'
  );
  assert(['empty', 'ready'].includes(result.status), JSON.stringify(result));
  return result.templates ?? [];
}
async function openImport() {
  await click(`document.querySelector('[data-testid="import-template-button"]')`);
  await until(`${topDialog}?.textContent?.includes('Native file picker')`, 'native import dialog');
}
async function importFile(file: string) {
  await selection('open', file);
  await click(button('Import Template', topDialog));
}
async function closeDialog() {
  const count = await evaluate<number>('document.querySelectorAll(\'[role="dialog"]\').length');
  await click(button('Close', topDialog));
  await until(`document.querySelectorAll('[role="dialog"]').length < ${count}`, 'dialog closes');
}
async function start() {
  logs = '';
  app = spawn('pnpm', ['dev:mcp', '--noSandbox', '--config', configPath], {
    cwd: repo,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
      AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userData,
      CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'multimodel-data'),
      CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'multimodel-cache'),
      XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
      XDG_DATA_HOME: path.join(root, 'xdg-data'),
      XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
      XDG_STATE_HOME: path.join(root, 'xdg-state'),
      CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: runtime,
      CLAUDE_TERMINAL_DAEMON_BINARY: runtime,
      CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
      NODE_BINARY: process.execPath,
      ELECTRON_DISABLE_SANDBOX: '1',
      AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    },
  });
  for (const stream of [app.stdout, app.stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      logs += chunk.toString();
    });
  }
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error('Owned dev:mcp exited: ' + app.exitCode);
    const actualPort = logs.match(
      /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//
    )?.[1];
    if (actualPort) {
      try {
        const targets = (await fetch(`http://127.0.0.1:${actualPort}/json/list`).then((r) =>
          r.json()
        )) as { type: string; url: string; webSocketDebuggerUrl: string }[];
        const target = targets.find(
          (t) => t.type === 'page' && new URL(t.url).port === String(rendererPort)
        );
        if (target) {
          cdp = (await CdpClient.connect(target.webSocketDebuggerUrl)) as Cdp;
          port = Number(actualPort);
          break;
        }
      } catch {
        /* The owned renderer is still starting. */
      }
    }
    await pause(100);
  }
  assert(cdp, 'Owned dev:mcp renderer did not appear');
  cdp.on('Runtime.exceptionThrown', (event) => rendererErrors.push(event));
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1500,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await until(
    'window.electronAPI?.customTeamTemplates && window.__agentTeamsDevStore',
    'real preload API',
    60_000
  );
  await until(
    '(async () => (await window.electronAPI.startup.getStatus()).ready)()',
    'desktop ready',
    60_000
  );
  await evaluate('window.__agentTeamsDevStore.getState().openTeamsTab()');
  await until(button('Templates'), 'Templates action', 60_000);
  await click(button('Templates'));
  await until(
    `document.querySelector('[data-testid="import-template-button"]')`,
    'My Templates library'
  );
}
async function stop() {
  if (cdp) {
    await cdp.evaluate('window.electronAPI.windowControls.close()').catch(() => undefined);
    await cdp.close().catch(() => undefined);
    cdp = undefined;
  }
  if (app?.pid) {
    const pid = app.pid;
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await pause(200);
    }
  }
  app = undefined;
}

console.log(
  JSON.stringify({ fixture: root, output, launch: 'pnpm dev:mcp', nativeDialogFixture: true })
);
try {
  await start();
  assert.equal((await library()).length, 0);
  await screenshot('01-empty-library');
  await openImport();
  await selection('open');
  await click(button('Import Template', topDialog));
  await until(button('Import Template', topDialog), 'cancelled picker becomes interactive');
  assert.equal((await library()).length, 0);
  checks.push('Cancelling the native picker does not write and leaves Import interactive.');

  for (const [file, testId] of [
    [invalidJson, 'import-template-invalid-json'],
    [invalidEncoding, 'import-template-invalid-encoding'],
    [descriptionTooLong, 'import-template-validation-failed'],
  ]) {
    await importFile(file);
    await until(`document.querySelector('[data-testid="${testId}"]')`, testId);
    assert.equal(
      await evaluate(
        `Boolean(${button('Import Template', topDialog)} && ${button('Close', topDialog)})`
      ),
      true
    );
    assert.equal((await library()).length, 0);
  }
  assert.match(await evaluate<string>(`${topDialog}.innerText`), /description is too long/i);
  await screenshot('02-validation-error-recovery');
  checks.push(
    'Invalid JSON, invalid UTF-8 and overlong description show precise errors, allow retry, and write nothing.'
  );

  await importFile(fixtureJson);
  await until(`document.querySelector('[data-testid="import-template-done"]')`, 'import success');
  const [original] = await library();
  assert(original);
  assert.equal(original.name, portable.name);
  assert.equal(original.teamPrompt, portable.teamPrompt);
  assert.deepEqual(original.members, portable.members);
  await screenshot('03-import-success');
  await closeDialog();
  await until(
    `document.querySelector('[data-testid="export-template-${original.templateId}"]')`,
    'new library row'
  );
  await click(`document.querySelector('[data-testid="export-template-${original.templateId}"]')`);
  await selection('save', exportedJson);
  await click(button('Export', topDialog));
  await until(`document.querySelector('[data-testid="export-template-done"]')`, 'export success');
  assert.deepEqual(JSON.parse(await readFile(exportedJson, 'utf8')), portable);
  await screenshot('04-portable-export');
  checks.push(
    'Import and export round-trip Unicode and multiline content through real SQLite and files, excluding local identity/revision metadata.'
  );
  await closeDialog();

  await openImport();
  await importFile(exportedJson);
  await until(
    `document.querySelector('[data-testid="import-template-name-conflict"]')`,
    'duplicate name conflict'
  );
  assert.equal((await library()).length, 1);
  await screenshot('05-duplicate-name');
  await click(`document.querySelector('#import-rename-name')`);
  await cdp!.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: 2,
  });
  await cdp!.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: 2,
  });
  await cdp!.send('Input.insertText', { text: portable.name + ' copy' });
  await click(button('Confirm import', topDialog));
  await until(
    `document.querySelector('[data-testid="import-template-done"]')`,
    'renamed import success'
  );
  const saved = await library();
  assert.equal(saved.length, 2);
  assert.equal(new Set(saved.map((t) => t.templateId)).size, 2);
  assert.deepEqual(
    saved.find((t) => t.templateId === original.templateId),
    original
  );
  assert(saved.some((t) => t.name === portable.name + ' copy'));
  await closeDialog();
  await screenshot('06-two-independent-templates');
  checks.push(
    'Duplicate import does not overwrite; the rename flow creates a fresh identity and preserves the original.'
  );

  await closeDialog();
  await click(button('Templates'));
  await until(
    `document.querySelector('[data-testid="custom-template-library"]')?.children.length === 2`,
    'reopened persisted library'
  );
  assert.deepEqual(await library(), saved);
  await screenshot('07-reopened-library');
  checks.push(
    'Closing and reopening My Templates re-reads both saved rows from the real storage worker.'
  );

  receipt.cdpPort = port;
  receipt.savedTemplateIds = saved.map((t) => t.templateId);
  receipt.rendererErrors = rendererErrors;
  assert.equal(rendererErrors.length, 0, 'Unexpected renderer exception');
  receipt.dialogs = (await readFile(dialogAudit, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  receipt.runtimeProbes = (await readFile(runtimeAudit, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  receipt.passed = true;
} catch (error) {
  receipt.failure = String(error);
  if (cdp) {
    receipt.lastVisibleText = await evaluate<string>('document.body.innerText').catch(
      () => '<unavailable>'
    );
    await screenshot('failure').catch(() => undefined);
  }
  process.exitCode = 1;
} finally {
  await stop();
  await writeFile(path.join(output, 'dev-mcp.log'), logs);
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(
    JSON.stringify({
      passed: receipt.passed,
      checks,
      failure: receipt.failure,
      receipt: path.join(output, 'receipt.json'),
    })
  );
}
