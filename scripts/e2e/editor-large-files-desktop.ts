#!/usr/bin/env node
/**
 * Sandbox-only Electron CodeMirror regression proof, never launches agents.
 * Run: xvfb-run -a node --experimental-strip-types scripts/e2e/editor-large-files-desktop.ts
 * Red proof on the original checkout: append --baseline (or --expect-rejection).
 * Typecheck separately: node ./node_modules/@typescript/native/bin/tsc --ignoreConfig
 *   --noEmit --target ES2023 --module ESNext
 *   --moduleResolution bundler --esModuleInterop --skipLibCheck --types node
 *   scripts/e2e/editor-large-files-desktop.ts
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface CdpResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string }; text?: string };
  data?: string;
}
interface CdpMessage { id?: number; result?: CdpResult; error?: { message: string }; method?: string; params?: unknown }
class Cdp {
  socket: WebSocket;
  id = 0;
  pending = new Map<number, { resolve: (value: CdpResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  exceptions: unknown[] = [];
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (!message.id) {
        if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(message.params);
        return;
      }
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result ?? {});
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('CDP closed')); }
      this.pending.clear();
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true }); });
    return new Cdp(socket);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<CdpResult> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value as T;
  }
  async wait(expression: string, label: string, timeout = 90_000): Promise<void> {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (await this.evaluate<boolean>(`(async () => Boolean(await (${expression})))()`)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}; condition: ${expression}`);
  }
  async shortcut(key: string, shift = false): Promise<void> {
    const modifiers = (process.platform === 'darwin' ? 4 : 2) | (shift ? 8 : 0);
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: `Key${key.toUpperCase()}`, modifiers });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: `Key${key.toUpperCase()}`, modifiers });
  }
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseline = process.argv.includes('--baseline') || process.argv.includes('--expect-rejection');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'agent-teams-editor-large-'));
const project = path.join(sandbox, 'project');
const artifacts = path.join(sandbox, 'artifacts');
const claudeRoot = path.join(sandbox, 'claude');
const userDataRoot = path.join(sandbox, 'user-data');
await Promise.all([project, artifacts, claudeRoot, userDataRoot].map((dir) => mkdir(dir, { recursive: true })));
const receipt: Record<string, unknown> = { sandbox, project, platform: process.platform, baseline, cases: [] };
const cases: Record<string, unknown>[] = [];
receipt.cases = cases;
const appLogs: string[] = [];
let app: ChildProcess | null = null;
let cdp: Cdp | null = null;
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const fixture = async (name: string, bytes: number, kind: 'lines' | 'json' | 'single' | 'utf8' | 'crlf' = 'lines') => {
  const tail = '\nTAIL-retained-完整\n';
  const payloadBytes = bytes - Buffer.byteLength(tail);
  let content: string;
  if (kind === 'json') {
    const prefix = '{"entries":[\n';
    const row = '"' + 'j'.repeat(4096) + '",\n';
    const suffix = '"TAIL-retained-完整"]}\n';
    const rows = Math.floor((bytes - Buffer.byteLength(prefix + suffix)) / row.length);
    content = prefix + row.repeat(rows) + suffix;
  } else if (kind === 'single') content = 's'.repeat(bytes - 'TAIL-single'.length) + 'TAIL-single';
  else if (kind === 'utf8') {
    const row = 'UTF8-界🙂-search-token\n';
    content = row.repeat(Math.floor(payloadBytes / Buffer.byteLength(row))) + tail;
  } else if (kind === 'crlf') {
    const row = 'CRLF-search-token-' + 'w'.repeat(100) + '\r\n';
    content = '\uFEFF' + row.repeat(Math.floor(payloadBytes / row.length)) + 'TAIL-CRLF\r\n';
  } else {
    const row = 'plain-search-token-' + 'p'.repeat(100) + '\n';
    content = row.repeat(Math.floor(payloadBytes / row.length)) + 'p'.repeat(payloadBytes % row.length) + tail;
  }
  const file = path.join(project, name);
  await writeFile(file, content);
  return { file, name, bytes: Buffer.byteLength(content), chars: content.length, hash: hash(content), tail: content.slice(-40) };
};
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No port')); return; }
      server.close(() => resolve(address.port));
    });
  });
}
async function launch(): Promise<Cdp> {
  const port = await freePort();
  app = spawn(process.execPath, [path.join(repo, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev', '--remoteDebuggingPort', String(port), ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--noSandbox'] : [])], {
    cwd: repo, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
      AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claudeRoot, AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userDataRoot,
      CLAUDE_CONFIG_DIR: claudeRoot, CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0', NODE_BINARY: process.execPath,
      CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: process.execPath },
  });
  const remember = (chunk: Buffer) => { appLogs.push(chunk.toString()); if (appLogs.length > 200) appLogs.shift(); };
  app.stdout?.on('data', remember); app.stderr?.on('data', remember);
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    if (app.exitCode !== null) throw new Error(`Electron exited (${app.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      const targets = await response.json() as { type: string; url: string; webSocketDebuggerUrl?: string }[];
      const target = targets.find((item) => item.type === 'page' && !item.url.startsWith('devtools:') && item.webSocketDebuggerUrl);
      if (target?.webSocketDebuggerUrl) {
        const client = await Cdp.connect(target.webSocketDebuggerUrl);
        await client.send('Runtime.enable'); await client.send('Page.enable');
        await client.wait('window.electronAPI?.editor && document.querySelector("#root")?.childElementCount', 'Electron renderer');
        return client;
      }
    } catch { /* bounded startup retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Electron CDP startup timed out');
}
const viewExpression = `(await window.__editorSourceImport('utils/editorBridge.ts')).editorBridge.getView()`;
const storeExpression = `(await window.__editorSourceImport('store/index.ts')).useStore`;
async function mountEditor(client: Cdp): Promise<void> {
  // Mount the real overlay with its normal providers via dev imports. No production
  // test hooks, native picker, runtime, or team provisioning are involved.
  await client.evaluate(`(async () => {
    window.__editorErrors = [];
    window.addEventListener('unhandledrejection', event => window.__editorErrors.push(String(event.reason)));
    window.addEventListener('error', event => window.__editorErrors.push(String(event.error || event.message)));
    localStorage.setItem('editor-watcher-enabled', 'false');
    window.__editorSourceUrl = (relative) => {
      const main = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname.endsWith('/main.tsx'));
      if (!main) throw new Error('Renderer main module URL missing');
      const url = new URL(relative, main.name);
      const loaded = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === url.pathname);
      return loaded?.name ?? url.href;
    };
    window.__editorSourceImport = (relative) => import(window.__editorSourceUrl(relative));
    const dependencyCache = new Map();
    window.__editorDependencyImport = async (binding) => {
      if (dependencyCache.has(binding)) return dependencyCache.get(binding);
      const source = await (await fetch(window.__editorSourceUrl('components/team/editor/CodeMirrorEditor.tsx'))).text();
      const declaration = [...source.matchAll(/import\\s+([^;]*?)\\sfrom\\s*["']([^"']+)["']/g)].find(match => match[1].includes(binding));
      if (!declaration) throw new Error('Transformed CodeMirror dependency not found: ' + binding);
      const module = await import(declaration[2]); dependencyCache.set(binding,module); return module;
    };
    window.__editorImport = async (name) => {
      const suffix = '/deps/' + name + '.js';
      const resource = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname.endsWith(suffix));
      if (!resource) throw new Error('Loaded Vite dependency URL missing: ' + name);
      return import(resource.name);
    };
    const React = (await window.__editorImport('react')).default;
    const reactDom = await window.__editorImport('react-dom_client');
    const createRoot = reactDom.createRoot ?? reactDom.default?.createRoot;
    if (!createRoot) throw new Error('ReactDOM createRoot export missing');
    const { ProjectEditorOverlay } = await window.__editorSourceImport('components/team/editor/ProjectEditorOverlay.tsx');
    const { TooltipProvider } = await window.__editorSourceImport('components/ui/tooltip.tsx');
    const { LocalizationProvider } = await import(${JSON.stringify('/@fs' + repo + '/src/features/localization/renderer/ui/LocalizationProvider.tsx')});
    const container = document.createElement('div'); container.id = 'editor-large-e2e'; document.body.append(container);
    const root = createRoot(container); window.__editorE2eRoot = root;
    root.render(React.createElement(LocalizationProvider, { appConfig: null },
      React.createElement(TooltipProvider, {}, React.createElement(ProjectEditorOverlay, {
        projectPath: ${JSON.stringify(project)}, onClose: () => root.unmount()
      }))));
  })()`);
  await client.wait(`(async () => { const s = ${storeExpression}.getState(); return s.editorProjectPath === ${JSON.stringify(project)} && !s.editorFileTreeLoading && !!s.editorFileTree; })()`, 'sandbox editor initialization');
}
async function open(client: Cdp, file: string, editable = true): Promise<number> {
  const start = Date.now();
  await client.evaluate(`(async () => { ${storeExpression}.getState().openFile(${JSON.stringify(file)}); })()`);
  if (editable) await client.wait(`(async () => { const view = ${viewExpression}; const store = ${storeExpression}.getState(); return store.editorActiveTabId === ${JSON.stringify(file)} && !!view && document.querySelector('#editor-large-e2e [data-editor-file]')?.getAttribute('data-editor-file') === ${JSON.stringify(file)} && document.querySelector('#editor-large-e2e .cm-content'); })()`, `CodeMirror ${path.basename(file)}`);
  if (!editable) await client.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  return Date.now() - start;
}
async function screenshot(client: Cdp, name: string): Promise<void> {
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  assert(shot.data);
  await writeFile(path.join(artifacts, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function editAndSave(client: Cdp, item: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await client.evaluate(`(async () => { const view = ${viewExpression}; view.dispatch({selection:{anchor:view.state.doc.length}}); view.focus(); })()`);
  await client.send('Input.insertText', { text: 'EDIT-proof' });
  // Preserve dirty text/history on tab switch before saving.
  const small = path.join(project, 'small.txt');
  await open(client, small);
  await open(client, item.file);
  const restored = await client.evaluate<string>(`(async () => { const view = ${viewExpression}; return view.state.sliceDoc(Math.max(0,view.state.doc.length-80)); })()`);
  assert(restored.endsWith('EDIT-proof'), 'unsaved text must survive tab switch');
  await client.evaluate(`(async () => { (${viewExpression}).focus(); })()`);
  await client.shortcut('s');
  await client.wait(`(async () => { const s = ${storeExpression}.getState(); return !s.editorSaving[${JSON.stringify(item.file)}] && !s.editorModifiedFiles[${JSON.stringify(item.file)}] && !s.editorSaveError[${JSON.stringify(item.file)}]; })()`, 'successful keyboard save');
  const saved = await readFile(item.file);
  assert.equal(hash(saved), await client.evaluate<string>(`(async () => {
    const content = (${viewExpression}).state.sliceDoc();
    const bytes = new TextEncoder().encode(content); const digest = await crypto.subtle.digest('SHA-256',bytes);
    return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
  })()`), 'saved disk hash must equal actual full CodeMirror document');
  assert(saved.toString('utf8').endsWith(item.tail + 'EDIT-proof'), 'original file tail retained');
  if (item.name.endsWith('crlf.txt')) {
    assert.equal(saved[0], 0xef, 'BOM retained');
    assert(!/(^|[^\r])\n/.test(saved.toString('utf8')), 'CRLF roundtrip must not introduce bare LF');
  }
}
try {
  const small = await fixture('small.txt', 2048);
  const items = baseline
    ? [await fixture('baseline-17.txt', Math.round(17.2 * 1024 * 1024)), await fixture('baseline-19.txt', Math.round(19.8 * 1024 * 1024))]
    : [await fixture('large.txt', 20 * 1024 * 1024), await fixture('large.json', 20 * 1024 * 1024, 'json'),
      await fixture('single.txt', 20 * 1024 * 1024, 'single'), await fixture('utf8.txt', 20 * 1024 * 1024, 'utf8'),
      await fixture('windows-crlf.txt', 20 * 1024 * 1024, 'crlf')];
  cdp = await launch();
  console.log('Electron-ready');
  await mountEditor(cdp);
  console.log('Editor-mounted');
  for (const item of items) {
    console.log(`Case-start: ${item.name}`);
    if (baseline) await cdp.evaluate('window.__editorErrors = []');
    const openMs = await open(cdp, item.file, !baseline);
    if (baseline) {
      await cdp.wait('document.querySelector("#editor-large-e2e")?.innerText.includes("File too large")', 'original oversized-file rejection');
      await cdp.wait('window.__editorErrors.some(error => error.includes("File too large"))', 'original rejected cleanup promise');
      cases.push({ ...item, openMs, expectedRejection: true, expectedUnhandledRejection: true });
      console.log(`Case-pass: ${item.name} rejected`);
      continue;
    }
    const info: { length: number; tail: string; readOnly: boolean; language: boolean } = await cdp.evaluate<{ length: number; tail: string; readOnly: boolean; language: boolean }>(`(async () => {
      const view = ${viewExpression};
      const languageModule = await window.__editorDependencyImport('syntaxHighlighting');
      const language = languageModule.language ?? languageModule.default?.language;
      if (!language) throw new Error('CodeMirror language facet export missing');
      return {length:view.state.sliceDoc().length, tail:view.state.sliceDoc(Math.max(0,view.state.doc.length-80)),
        readOnly:view.state.readOnly, language:!!view.state.facet(language)};
    })()`);
    assert.equal(info.length, item.chars, 'full file character count');
    assert(info.tail.endsWith(item.tail), 'full file tail visible to CodeMirror');
    assert.equal(info.readOnly, false); assert.equal(info.language, false, 'large JSON syntax parsing disabled');
    await cdp.wait('document.querySelector("[data-editor-mode=large]")', 'visible reduced mode');
    const pingStart = Date.now();
    await cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => resolve(true)))');
    const responsiveMs = Date.now() - pingStart;
    assert(responsiveMs < 5000, 'renderer responds after full document mount');
    await screenshot(cdp, item.name.replace('.', '-') + '-open');
    await editAndSave(cdp, item);
    cases.push({ ...item, openMs, responsiveMs, saveHash: hash(await readFile(item.file)), fullText: true });
    console.log(`Case-pass: ${item.name} open=${openMs}ms responsive=${responsiveMs}ms`);
  }
  if (baseline) {
    await cdp.wait('window.__editorErrors.some(error => error.includes("File too large"))', 'original derived unhandled rejection');
    receipt.reproducedUnhandledRejection = true;
    await screenshot(cdp, 'baseline-rejection');
  } else {
    await open(cdp, small.file);
    // Actual search panel + document navigation use existing CodeMirror commands/UI.
    await cdp.evaluate(`(async () => { (${viewExpression}).focus(); })()`);
    await cdp.shortcut('f');
    await cdp.wait('document.querySelector("#editor-large-e2e .cm-panel input")', 'CodeMirror search panel');
    await cdp.evaluate(`(() => { const input = document.querySelector('#editor-large-e2e .cm-panel input'); input.focus(); })()`);
    await cdp.send('Input.insertText', { text: 'search-token' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
    await cdp.wait(`(async () => !(${viewExpression}).state.selection.main.empty)()`, 'search navigates to match');
    const crlfFile = items.find(item=>item.name.endsWith('crlf.txt'))!.file;
    await open(cdp, crlfFile);
    const pasted = await cdp.evaluate<{ addedLines: number; tail: string }>(`(async () => {
      const view = ${viewExpression}; const before = view.state.doc.lines;
      view.dispatch({ selection:{anchor:view.state.doc.length} }); view.focus();
      const clipboard = new DataTransfer(); clipboard.setData('text/plain', ${JSON.stringify('\nLF-paste-a\nLF-paste-b')});
      view.contentDOM.dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,bubbles:true,cancelable:true}));
      return { addedLines:view.state.doc.lines-before, tail:view.state.sliceDoc(view.state.doc.length-40) };
    })()`);
    assert.equal(pasted.addedLines, 2, 'LF clipboard input becomes real CRLF document lines');
    assert(pasted.tail.endsWith('\r\nLF-paste-a\r\nLF-paste-b'));
    await cdp.shortcut('s');
    await cdp.wait(`(async () => !${storeExpression}.getState().editorModifiedFiles[${JSON.stringify(crlfFile)}])()`, 'CRLF pasted content save');
    assert(!/(^|[^\r])\n/.test(await readFile(crlfFile,'utf8')));
    receipt.crlfPaste = true;
    // An acknowledgement for one full document must leave newer edits dirty.
    const concurrentFile = items[0].file;
    await open(cdp, concurrentFile);
    const concurrent = await cdp.evaluate<{ dirty: boolean; contentTail: string }>(`(async () => {
      const store = ${storeExpression}; const view = ${viewExpression};
      const pending = store.getState().saveFile(${JSON.stringify(concurrentFile)});
      view.dispatch({ changes: { from: view.state.doc.length, insert: '-CONCURRENT' } });
      await pending;
      return { dirty:!!store.getState().editorModifiedFiles[${JSON.stringify(concurrentFile)}], contentTail:view.state.sliceDoc(view.state.doc.length-40) };
    })()`);
    assert(concurrent.dirty, 'newer edit must remain dirty after save acknowledgement');
    assert(concurrent.contentTail.endsWith('-CONCURRENT'));
    assert(!(await readFile(concurrentFile, 'utf8')).endsWith('-CONCURRENT'), 'disk acknowledges original snapshot only');
    await cdp.evaluate(`(async () => { (${viewExpression}).focus(); })()`);
    await cdp.shortcut('s');
    await cdp.wait(`(async () => !${storeExpression}.getState().editorModifiedFiles[${JSON.stringify(concurrentFile)}])()`, 'second concurrent save');
    assert((await readFile(concurrentFile, 'utf8')).endsWith('-CONCURRENT'));
    const beforeRejectedSave = hash(await readFile(concurrentFile));
    await cdp.evaluate(`(async () => {
      const view = ${viewExpression}; view.dispatch({changes:{from:view.state.doc.length,insert:'x'.repeat(12*1024*1024+1)}}); view.focus();
    })()`);
    await cdp.shortcut('w');
    await cdp.wait(`Array.from(document.querySelectorAll('[role="dialog"] button')).some(button=>button.textContent?.trim()==='Save')`, 'unsaved tab close dialog');
    await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(button=>button.textContent?.trim()==='Save').click()`);
    await cdp.wait(`(async () => !!${storeExpression}.getState().editorSaveError[${JSON.stringify(concurrentFile)}])()`, 'oversized save rejected');
    const retained = await cdp.evaluate<boolean>(`(async () => {
      const state = ${storeExpression}.getState();
      return state.editorOpenTabs.some(tab=>tab.id===${JSON.stringify(concurrentFile)}) && !!state.editorModifiedFiles[${JSON.stringify(concurrentFile)}] && (${viewExpression}).state.doc.length>32*1024*1024;
    })()`);
    assert(retained, 'failed Save-and-Close must retain unsaved document and tab');
    assert.equal(hash(await readFile(concurrentFile)), beforeRejectedSave);
    await screenshot(cdp, 'rejected-save-retained-tab');
    await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(button=>button.textContent?.trim()==='Cancel').click()`);
    await cdp.evaluate(`(async () => { (${viewExpression}).focus(); })()`);
    await cdp.shortcut('z');
    await cdp.shortcut('s');
    await cdp.wait(`(async () => { const state=${storeExpression}.getState(); return !state.editorModifiedFiles[${JSON.stringify(concurrentFile)}] && !state.editorSaveError[${JSON.stringify(concurrentFile)}]; })()`, 'recovered from oversized edit');
    receipt.concurrentSave = true; receipt.failedCloseRetainsDirtyTab = true;
    const oversized = await fixture('oversized.txt', 33 * 1024 * 1024, 'single');
    const originalHash = oversized.hash;
    await open(cdp, oversized.file);
    await cdp.wait('document.querySelector("[data-editor-mode=preview]")', 'readonly preview mode');
    const preview = await cdp.evaluate<{ chars: number; readOnly: boolean; saveContent: string | null }>(`(async () => {
      const { editorBridge } = await window.__editorSourceImport('utils/editorBridge.ts');
      const view = editorBridge.getView(); view.dispatch({changes:{from:0,insert:'SHOULD-NOT-EDIT'}});
      return { chars:view.state.doc.length, readOnly:view.state.readOnly, saveContent:editorBridge.getContent(${JSON.stringify(oversized.file)}) };
    })()`);
    assert(preview.chars <= 256 * 1024); assert(preview.readOnly); assert.equal(preview.saveContent, null);
    await cdp.evaluate(`(async () => { ${storeExpression}.getState().saveFile(${JSON.stringify(oversized.file)}); })()`);
    const bridgeBypass = await cdp.evaluate<string>(`(async () => {
      try { await window.electronAPI.editor.writeFile(${JSON.stringify(oversized.file)}, 'partial'); return 'unexpected success'; }
      catch(error) { return String(error); }
    })()`);
    assert(bridgeBypass.includes('Read-only')); assert.equal(hash(await readFile(oversized.file)), originalHash);
    await screenshot(cdp, 'oversized-readonly');
    cases.push({ ...oversized, preview, immutable: true });
    const missing = path.join(project, 'missing-file.txt');
    await open(cdp, missing, false);
    await cdp.wait('document.querySelector("#editor-large-e2e")?.innerText.includes("ENOENT")', 'handled missing-file error');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await cdp.evaluate('window.__editorErrors'), [], 'read errors must not escape as unhandled rejection');
    await open(cdp, small.file);
    await screenshot(cdp, 'small-search-and-recovered');
    receipt.smallFile = true; receipt.searchNavigation = true; receipt.handledMissingFile = true;
  }
  receipt.rendererErrors = await cdp.evaluate('window.__editorErrors');
  receipt.cdpExceptions = cdp.exceptions;
  receipt.ok = true;
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  receipt.ok = false; receipt.error = String(error);
  if (cdp) { try { await screenshot(cdp, 'failure'); receipt.rendererErrors = await cdp.evaluate('window.__editorErrors'); } catch { /* retain logs */ } }
  console.error(JSON.stringify(receipt, null, 2)); process.exitCode = 1;
} finally {
  await writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await writeFile(path.join(artifacts, 'electron.log'), appLogs.join(''));
  cdp?.socket.close();
  const ownedProcess = app as ChildProcess | null;
  if (ownedProcess?.pid && ownedProcess.exitCode === null) {
    try { process.kill(process.platform === 'win32' ? ownedProcess.pid : -ownedProcess.pid, 'SIGTERM'); } catch { /* process already exited */ }
  }
  // Keep the unique sandbox, screenshots, disk fixtures and receipt as evidence.
  console.log(`Artifacts: ${artifacts}`);
}
