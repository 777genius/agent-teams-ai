/**
 * Disposable Linux desktop E2E for custom-template JSON import/export.
 * Run with a test DISPLAY: pnpm test:e2e:custom-template-import-export
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
const project = path.join(root, 'TEST-project');
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

await Promise.all(
  [claude, userData, output, project].map((dir) => mkdir(dir, { recursive: true }))
);
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
    // The creation page has a sticky header; 'nearest' can park cards underneath it.
    e.scrollIntoView({block:'center',inline:'nearest'}); const r=e.getBoundingClientRect();
    const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return r.width>0 && r.height>0 && (hit===e || e.contains(hit)); })()`,
    'unobstructed click target: ' + expression.slice(0, 160)
  );
  const point = await evaluate<{ x: number; y: number }>(
    `(() => { const r = (${expression}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`
  );
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp!.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  }
}
const templateConfirmDialog = `Array.from(document.querySelectorAll('[role="alertdialog"]')).find(e => e.querySelector('h2')?.textContent?.includes('Apply team template?'))`;

async function acceptTemplateSelection(selector: string, appliedPredicate: string) {
  if (
    !(await evaluate<boolean>(
      `Boolean(document.querySelector('[data-testid="create-team-template-picker"]'))`
    ))
  ) {
    await click(`document.querySelector('[data-testid="open-create-template-picker"]')`);
  }
  await until(selector, 'template option visible');
  await click(selector);
  // An untouched form can apply directly; a populated form must confirm first.
  await until(
    `(${templateConfirmDialog}) || (${appliedPredicate})`,
    'template selection confirmation or application'
  );
  if (await evaluate<boolean>(`Boolean(${templateConfirmDialog})`)) {
    await click(button('Apply template', templateConfirmDialog));
    await until(`!(${templateConfirmDialog})`, 'template confirmation closes');
  }
  await until(appliedPredicate, 'chosen template applied');
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
async function openImport(file?: string) {
  await selection('open', file);
  await click(`document.querySelector('[data-testid="import-template-button"]')`);
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
  await click(`document.querySelector('[data-testid="create-template-button"]')`);
  await until(`document.querySelector('#edit-template-name')`, 'create template editor');
  await click(`document.querySelector('#edit-template-name')`);
  await cdp!.send('Input.insertText', { text: 'Created via UI' });
  await click(button('Add member', topDialog));
  await click(`document.querySelector('#member-0-name')`);
  await cdp!.send('Input.insertText', { text: 'researcher' });
  await until(`document.querySelector('[data-participant-avatar] img')`, 'agent avatar');
  await click(`document.querySelector('#member-0-role')`);
  await until(
    `Array.from(document.querySelectorAll('[role="option"]')).some(e => e.textContent?.trim() === 'researcher')`,
    'role selector'
  );
  await click(
    `Array.from(document.querySelectorAll('[role="option"]')).find(e => e.textContent?.trim() === 'researcher')`
  );
  await click(`document.querySelector('#edit-template-prompt')`);
  await cdp!.send('Input.insertText', { text: 'Review the evidence.' });
  await click(button('Save template', topDialog));
  await until(
    `window.electronAPI.customTeamTemplates.listTemplates().then(x => x.templates?.some(t => t.name === 'Created via UI'))`,
    'created template persisted'
  );
  const createdTemplate = (await library()).find((template) => template.name === 'Created via UI');
  assert(createdTemplate);
  assert.equal(createdTemplate.members[0]?.role, 'researcher');
  await screenshot('00-created-template');
  await click(
    `document.querySelector('[data-testid="delete-template-${createdTemplate.templateId}"]')`
  );
  await click(button('Delete this template?', topDialog));
  await until(
    `window.electronAPI.customTeamTemplates.listTemplates().then(x => x.status === 'empty')`,
    'test template deleted'
  );
  checks.push('Creating a template uses the shared role selector and participant avatar.');
  await openImport();
  await until(`document.querySelectorAll('[role="dialog"]').length === 1`, 'cancel closes picker');
  assert.equal((await library()).length, 0);
  checks.push('Import directly opens the picker; cancellation does not write.');

  await openImport(invalidJson);
  await until(
    `document.querySelector('[data-testid="import-template-invalid-json"]')`,
    'invalid JSON'
  );
  for (const [file, testId] of [
    [invalidEncoding, 'import-template-invalid-encoding'],
    [descriptionTooLong, 'import-template-validation-failed'],
  ]) {
    await importFile(file);
    await until(`document.querySelector('[data-testid="${testId}"]')`, testId);
    assert.equal((await library()).length, 0);
  }
  checks.push('Invalid JSON, UTF-8 and oversized descriptions are rejected.');

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

  await openImport(exportedJson);
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
  const bundlePath = path.join(root, 'all-templates.json');
  await selection('save', bundlePath);
  await click(`document.querySelector('[data-testid="export-all-templates"]')`);
  await until(`document.body.innerText.includes('All templates exported')`, 'export all');
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
  assert.equal(bundle.format, 'agent-teams-custom-template-bundle');
  assert.equal(bundle.templates.length, 2);
  assert(!('templateId' in bundle.templates[0]));
  await openImport(bundlePath);
  await until(`document.querySelector('[data-testid="import-template-done"]')`, 'bundle import');
  assert.match(await evaluate<string>(`${topDialog}.innerText`), /0 imported, 2 skipped/);
  await closeDialog();
  checks.push('Export All produces a portable bundle and re-import skips name conflicts.');
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

  // Real management actions: duplicate -> edit -> delete an independent copy.
  // The original imported template must remain byte-for-byte unchanged.
  await click(
    `document.querySelector('[data-testid="duplicate-template-${original.templateId}"]')`
  );
  await until("document.querySelector('#duplicate-template-name')", 'duplicate template dialog');
  await click(button('Duplicate', topDialog));
  await until(
    `window.electronAPI.customTeamTemplates.listTemplates().then(x => x.templates?.length === 3)`,
    'duplicated row'
  );
  const duplicate = (await library()).find(
    (t) => !saved.some((old) => old.templateId === t.templateId)
  );
  assert(duplicate, 'Duplicate must allocate a fresh template id');
  await until(
    `document.querySelector('[data-testid="edit-template-${duplicate.templateId}"]')`,
    'duplicate in library'
  );
  await click(`document.querySelector('[data-testid="edit-template-${duplicate.templateId}"]')`);
  await until("document.querySelector('#edit-template-prompt')", 'edit template form');
  await click("document.querySelector('#edit-template-prompt')");
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
  const revisedPrompt = 'Edited through actual Electron UI';
  await cdp!.send('Input.insertText', { text: revisedPrompt });
  await click(`document.querySelector('[data-testid="template-edit-json"]')`);
  await until(`document.querySelector('.cm-content[contenteditable="true"]')`, 'JSON editor');
  await click(`document.querySelector('.cm-content[contenteditable="true"]')`);
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
  await cdp!.send('Input.insertText', { text: '{' });
  await until(
    `Array.from(${topDialog}.querySelectorAll('button')).find(e => e.textContent.trim() === 'Save changes')?.disabled`,
    'invalid JSON blocks saving'
  );
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
  await cdp!.send('Input.insertText', {
    text: JSON.stringify(
      {
        name: duplicate.name,
        description: portable.description,
        teamPrompt: revisedPrompt,
        members: portable.members,
      },
      null,
      2
    ),
  });
  await until(button('Save changes', topDialog), 'valid JSON enables saving');
  await screenshot('08-json-editor');
  await click(button('Save changes', topDialog));
  await until(
    `window.electronAPI.customTeamTemplates.listTemplates().then(x => x.templates?.some(t => t.templateId === ${JSON.stringify(duplicate.templateId)} && t.teamPrompt === ${JSON.stringify('Edited through actual Electron UI')}))`,
    'edited copy persisted'
  );
  await until(
    `document.querySelector('[data-testid="delete-template-${duplicate.templateId}"]')`,
    'edited row visible'
  );
  await screenshot('08-edited-independent-copy');
  await click(`document.querySelector('[data-testid="delete-template-${duplicate.templateId}"]')`);
  await until(button('Delete this template?', topDialog), 'delete confirmation');
  await click(button('Delete this template?', topDialog));
  await until(
    `window.electronAPI.customTeamTemplates.listTemplates().then(x => x.templates?.length === 2)`,
    'duplicate deleted'
  );
  assert.deepEqual(await library(), saved);
  await screenshot('09-copy-edited-deleted');
  checks.push(
    'Real Duplicate, Edit and Delete dialogs preserve the original template and revisions.'
  );
  checks.push('The shared JSON editor blocks invalid JSON and saves the full valid template.');

  // Re-launch the actual Electron application with the same isolated profile.
  // A dialog close/reopen alone cannot prove durable SQLite persistence.
  await closeDialog();
  await stop();
  await start();
  assert.deepEqual(await library(), saved);
  await screenshot('10-library-after-app-restart');
  checks.push(
    'Saved templates survive a full Electron process restart with unchanged ids and content.'
  );

  // Exercise the current Create Team page, not the old dialog. The imported
  // template must fill the editable draft without launching a provider.
  await closeDialog();
  await until(button('Create Team'), 'current create-team action');
  await click(button('Create Team'));
  await until(button('Custom path'), 'custom project selector');
  await click(button('Custom path'));
  await click(`document.querySelector('input[placeholder="/absolute/path/to/project"]')`);
  await cdp!.send('Input.insertText', { text: project });
  await until(
    `document.querySelector('[data-testid="open-create-template-picker"]')`,
    'template chooser button'
  );
  assert.equal(
    await evaluate(
      `Boolean(document.querySelector('[data-testid="create-team-template-picker"]'))`
    ),
    false
  );
  await click(`document.querySelector('[data-testid="open-create-template-picker"]')`);
  await until(
    `document.querySelector('[data-testid="create-template-option-custom-${original.templateId}"]')`,
    'custom template available in creation page'
  );
  const customOption = `document.querySelector('[data-testid="create-template-option-custom-${original.templateId}"]')`;
  const customApplied = `document.querySelector('#team-prompt')?.value === ${JSON.stringify(portable.teamPrompt)}`;
  await acceptTemplateSelection(customOption, customApplied);
  assert.equal(await evaluate(`Boolean(document.querySelector('[aria-label="Choose team provider"]'))`), false, 'Applying a template must not clear the current provider');
  await until(
    `Array.from(document.querySelectorAll('[data-testid="create-team-page"] input')).some(input => input.value === 'reviewer')`,
    'custom template roster applied to editable team fields'
  );
  await screenshot('11-create-from-custom-template');
  checks.push(
    'Real Create Team page restores the imported prompt and member roster without starting a runtime.'
  );

  const builtin = `document.querySelector('[data-testid^="create-template-option-builtin-"]')`;
  await click(`document.querySelector('[data-testid="open-create-template-picker"]')`);
  await until(builtin, 'builtin choices');
  await click(builtin);
  await until(templateConfirmDialog, 'confirm replacement of populated custom draft');
  assert.equal(
    await evaluate<string>("document.querySelector('#team-prompt')?.value"),
    portable.teamPrompt
  );
  assert.equal(
    await evaluate<string>(
      `document.querySelector('[data-testid="create-template-option-custom-${original.templateId}"]')?.getAttribute('aria-pressed')`
    ),
    'true'
  );
  await click(button('Cancel', templateConfirmDialog));
  await until(`!(${templateConfirmDialog})`, 'template replacement cancellation');
  assert.equal(
    await evaluate<string>("document.querySelector('#team-prompt')?.value"),
    portable.teamPrompt
  );
  await screenshot('12-confirmation-cancel-retains-draft');
  checks.push('Cancelling a new template selection does not replace the custom prompt or roster.');

  const builtinApplied = `document.querySelector('#team-prompt')?.value && document.querySelector('#team-prompt')?.value !== ${JSON.stringify(portable.teamPrompt)}`;
  await acceptTemplateSelection(builtin, builtinApplied);
  await screenshot('13-builtin-template-same-editor');

  const noneApplied = `!document.querySelector('[data-testid="create-team-template-picker"]') && !document.querySelector('#team-prompt')`;
  await acceptTemplateSelection(
    `document.querySelector('[data-testid="create-template-option-none"]')`,
    noneApplied
  );
  await screenshot('14-no-template');
  checks.push('Selecting No template confirms before clearing populated draft content.');
  await acceptTemplateSelection(customOption, customApplied);

  const newTeam = 'template-e2e-imported-team';
  await click("document.querySelector('#team-name')");
  // The current Create Team page seeds a suggested draft name. Replace it,
  // rather than append to it; this is a real keyboard interaction in Electron.
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
  await cdp!.send('Input.insertText', { text: newTeam });
  await until(
    `document.querySelector('#team-name')?.value === ${JSON.stringify(newTeam)}`,
    'new name entered'
  );
  const draftCheck = `(async () => { const db = await new Promise((resolve, reject) => { const request = indexedDB.open('keyval-store'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); return await new Promise((resolve, reject) => { const request = db.transaction('keyval').objectStore('keyval').get('createTeamDraft:form'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); })()`;
  await until(
    `(${draftCheck}).then(draft => draft?.teamName === ${JSON.stringify(newTeam)} && draft.cwdMode === 'custom' && draft.customCwd === ${JSON.stringify(project)} && draft.launchTeam === false)`,
    'sandbox project and config-only creation'
  );
  await click(button('Create'));
  await until(
    `window.electronAPI.teams.list().then(rows => rows.some(t => t.teamName === ${JSON.stringify(newTeam)}))`,
    'config-only team persisted from imported template',
    60_000
  );
  await screenshot('14-created-team-from-template');
  checks.push('Config-only creation from imported template persists through the real Teams API.');

  // Save the newly created real team back into the same library. This proves
  // the original A1 preview/confirm action and completes a user-visible cycle.
  await evaluate('window.__agentTeamsDevStore.getState().openTeamsTab()');
  await until(
    `document.querySelector('button[aria-label="Save as Template"]')`,
    'Save as Template action on the persisted team'
  );
  await click(`document.querySelector('button[aria-label="Save as Template"]')`);
  await until(
    `document.querySelector('[data-testid="custom-template-preview"]')`,
    'authoritative team snapshot preview'
  );
  await screenshot('15-save-team-as-template-preview');
  await click(button('Save template', topDialog));
  await until(
    `document.querySelector('[data-testid="custom-template-saved"]')`,
    'confirmed Save as Template'
  );
  const roundTrip = (await library()).filter(
    (template) => !saved.some((before) => before.templateId === template.templateId)
  );
  assert.equal(roundTrip.length, 1, 'Exactly one new template saved from the created team');
  assert.equal(roundTrip[0]!.teamPrompt, portable.teamPrompt);
  assert.deepEqual(
    roundTrip[0]!.members,
    portable.members,
    'Template round-trip must retain member role and workflow'
  );
  await screenshot('16-save-team-as-template-confirmed');
  checks.push(
    'Save as Template persists the same prompt, member name, role and workflow after real team creation.'
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
