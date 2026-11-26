/** Local, provider-free proof of the real Electron contextBridge error boundary. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createServer as createRendererServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const { build } = require(
  require.resolve('esbuild', {
    paths: [require.resolve('tsup', { paths: [path.join(root, 'mcp-server')] })],
  })
);
const sandbox = await mkdtemp(path.join(tmpdir(), 'TEST-team-definition-bridge-'));
const message = 'Open the interrupted project first';
const otherMessage = 'TEAM_PROJECT_CONTEXT_UNRECONCILED is only diagnostic text';
let rendererServer;

async function readRendererOutcomes() {
  const capture = async (call) => {
    try {
      const value = await call();
      return { resolved: true, isUndefined: value === undefined, value: value ?? null };
    } catch (error) {
      return {
        resolved: false,
        isError: error instanceof Error,
        message: error.message,
        text: String(error),
        failure: error.failure ?? null,
        recovery: globalThis.window.fixtureIsRecovery(error),
      };
    }
  };
  const raw = globalThis.window.electronAPI.teams;
  const adapted = globalThis.window.fixtureApi.teams;
  const results = {};
  for (const [name, methods] of [
    ['raw', raw],
    ['adapted', adapted],
  ]) {
    results[name] = {
      success: await capture(() => methods.updateConfig('test-success', {})),
      refusal: await capture(() => methods.updateConfig('test-refusal', {})),
      other: await capture(() => methods.updateConfig('test-other', {})),
      voidSuccess: await capture(() => methods.replaceMembers('test-success', { members: [] })),
    };
  }
  results.dto = await raw.definitionEdits.updateConfig('test-refusal', {});
  return results;
}

try {
  await build({
    absWorkingDir: root,
    entryPoints: ['src/preload/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: path.join(sandbox, 'preload.cjs'),
  });
  const rendererEntry = path.join(sandbox, 'renderer-entry.ts');
  await writeFile(
    rendererEntry,
    `import { api } from ${JSON.stringify(path.join(root, 'src/renderer/api/index.ts'))};
      import { isProjectContextRecoveryError } from ${JSON.stringify(path.join(root, 'src/renderer/components/team/definitionEdit/projectContextRecoveryError.ts'))};
      window.fixtureApi = api; window.fixtureIsRecovery = isProjectContextRecoveryError;`
  );
  await writeFile(
    path.join(sandbox, 'index.html'),
    '<!doctype html><title>TEST team definition bridge</title><script type="module" src="/renderer-entry.ts"></script>'
  );
  const paths = require(path.join(root, 'tsconfig.json')).compilerOptions.paths;
  // The production renderer graph includes Vite transforms such as import.meta.glob.
  rendererServer = await createRendererServer({
    configFile: false,
    root: sandbox,
    cacheDir: path.join(sandbox, 'vite-cache'),
    publicDir: false,
    logLevel: 'warn',
    // Match the Electron renderer's dependency target in electron.vite.config.ts.
    optimizeDeps: { esbuildOptions: { target: 'esnext' } },
    resolve: {
      alias: Object.fromEntries(
        Object.entries(paths).map(([alias, [target]]) => [
          alias.replace(/\/\*$/, ''),
          path.resolve(root, target.replace(/\/\*$/, '')),
        ])
      ),
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: true,
      hmr: false,
      fs: { allow: [root, sandbox] },
    },
  });
  await rendererServer.listen();
  const address = rendererServer.httpServer.address();
  assert.ok(address && typeof address === 'object', 'Owned renderer server must be listening');
  const rendererUrl = `http://127.0.0.1:${address.port}/`;
  await writeFile(
    path.join(sandbox, 'main.cjs'),
    `
    const { app, BrowserWindow, ipcMain } = require('electron');
    const path = require('node:path');
    app.setPath('userData', path.join(__dirname, 'user-data'));
    app.setPath('crashDumps', path.join(__dirname, 'crashes'));
    app.disableHardwareAcceleration();
    const requests = [];
    for (const channel of ['team:updateConfig', 'team:replaceMembers']) {
      ipcMain.handle(channel, async (_event, teamName) => {
        requests.push({ channel, teamName });
        if (teamName === 'test-refusal') return {
          success: false, error: ${JSON.stringify(message)},
          failure: { code: 'TEAM_PROJECT_CONTEXT_UNRECONCILED' },
        };
        if (teamName === 'test-other') return {
          success: false, error: ${JSON.stringify(otherMessage)}, failure: { code: 'OTHER_ERROR' },
        };
        return { success: true, data: channel === 'team:updateConfig' ? { name: 'Saved builders', members: [] } : undefined };
      });
    }
    const deadline = setTimeout(() => app.exit(2), 15_000);
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ show: false, webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: false,
        preload: path.join(__dirname, 'preload.cjs'),
      } });
      window.webContents.on('console-message', event => {
        if (event.level === 'error') console.error('Renderer: ' + event.message);
      });
      await window.loadURL(${JSON.stringify(rendererUrl)});
      await window.webContents.executeJavaScript('new Promise(resolve => { const ready = () => window.fixtureApi && window.fixtureIsRecovery ? resolve() : setTimeout(ready, 25); ready(); })');
      const outcomes = await window.webContents.executeJavaScript(${JSON.stringify(`(${readRendererOutcomes.toString()})()`)});
      console.log('TEAM_DEFINITION_BRIDGE=' + JSON.stringify({ outcomes, requests }));
      clearTimeout(deadline);
      window.destroy();
      app.exit(0);
    }).catch(error => { console.error(error); app.exit(1); });
  `
  );

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const flags = process.platform === 'linux' ? ['--ozone-platform=headless'] : [];
  if (process.getuid?.() === 0) flags.push('--no-sandbox');
  const { stdout } = await promisify(execFile)(
    require('electron'),
    [
      ...flags,
      `--user-data-dir=${path.join(sandbox, 'user-data')}`,
      path.join(sandbox, 'main.cjs'),
    ],
    { cwd: root, env, timeout: 25_000, maxBuffer: 1024 * 1024 }
  );
  const line = stdout.split('\n').find((value) => value.startsWith('TEAM_DEFINITION_BRIDGE='));
  assert.ok(line, 'Electron must report the actual renderer outcomes');
  const {
    outcomes: { raw, adapted, dto },
    requests,
  } = JSON.parse(line.slice('TEAM_DEFINITION_BRIDGE='.length));

  assert.deepEqual(raw.success, {
    resolved: true,
    isUndefined: false,
    value: { name: 'Saved builders', members: [] },
  });
  assert.deepEqual(adapted.success, raw.success);
  assert.deepEqual(raw.voidSuccess, { resolved: true, isUndefined: true, value: null });
  assert.deepEqual(adapted.voidSuccess, raw.voidSuccess);
  // This is the real failure mode: Electron kept the Error message but discarded failure.
  assert.equal(raw.refusal.isError, true);
  assert.equal(raw.refusal.message, message);
  assert.equal(raw.refusal.failure, null);
  assert.equal(raw.refusal.recovery, false);
  assert.deepEqual(adapted.refusal, {
    ...raw.refusal,
    failure: { code: 'TEAM_PROJECT_CONTEXT_UNRECONCILED' },
    recovery: true,
  });
  assert.deepEqual(dto, {
    type: 'team-definition-edit-refusal',
    message,
    failure: { code: 'TEAM_PROJECT_CONTEXT_UNRECONCILED' },
  });
  assert.equal(raw.other.isError, true);
  assert.equal(raw.other.message, otherMessage);
  assert.equal(raw.other.recovery, false);
  assert.deepEqual(adapted.other, raw.other);
  assert.equal(requests.length, 9, 'Each invocation must produce exactly one existing IPC request');
  console.log(
    'PASS: real Electron contextBridge, production preload and renderer API; success, refusal, unrelated error and raw compatibility (9 IPC requests).'
  );
} finally {
  try {
    await rendererServer?.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}
