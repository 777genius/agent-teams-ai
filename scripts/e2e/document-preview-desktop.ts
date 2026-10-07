#!/usr/bin/env node
/**
 * Sandbox-only document preview proof. Never launches agents or accesses real projects.
 * Run: xvfb-run -a node --experimental-strip-types scripts/e2e/document-preview-desktop.ts
 * FLYFISH_E2E_FIXTURES contains pinned official example documents. --production
 * verifies built renderer assets from a file:// Electron parent after pnpm build.
 * Typecheck separately: node ./node_modules/@typescript/native/bin/tsc --ignoreConfig
 *   --noEmit --target ES2023 --module ESNext
 *   --moduleResolution bundler --esModuleInterop --skipLibCheck --types node
 *   scripts/e2e/document-preview-desktop.ts
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, truncate } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface CdpResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string }; text?: string };
  data?: string;
}
interface CdpMessage {
  sessionId?: string;
  id?: number;
  result?: CdpResult;
  error?: { message: string };
  method?: string;
  params?: unknown;
}
class Cdp {
  socket: WebSocket;
  id = 0;
  pending = new Map<
    number,
    {
      resolve: (value: CdpResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  exceptions: unknown[] = [];
  contexts: { id: number; origin: string; sessionId?: string }[] = [];
  network: string[] = [];
  previewRequests: string[] = [];
  sessions: string[] = [];
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (!message.id) {
        const params = message.params as Record<string, any> | undefined;
        if (message.method === 'Runtime.executionContextCreated' && params?.context) {
          this.contexts.push({ ...params.context, sessionId: message.sessionId });
        }
        if (message.method === 'Network.requestWillBeSent' && params?.request?.url) {
          this.network.push(params.request.url);
          if (message.sessionId) this.previewRequests.push(params.request.url);
        }
        if (message.method === 'Target.attachedToTarget' && params?.sessionId) {
          this.sessions.push(params.sessionId);
          void this.send('Runtime.enable', {}, params.sessionId).catch(() => {});
          void this.send('Network.enable', {}, params.sessionId).catch(() => {});
          void this.send('Log.enable', {}, params.sessionId).catch(() => {});
        }
        if (message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded')
          this.exceptions.push(message.params);
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
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP closed'));
      }
      this.pending.clear();
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
        once: true,
      });
    });
    return new Cdp(socket);
  }
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<CdpResult> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  async evaluate<T = unknown>(
    expression: string,
    context?: { id: number; sessionId?: string }
  ): Promise<T> {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...(context ? { contextId: context.id } : {}),
      },
      context?.sessionId
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      );
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
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: `Key${key.toUpperCase()}`,
      modifiers,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: `Key${key.toUpperCase()}`,
      modifiers,
    });
  }
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const production = process.argv.includes('--production');
const baseline = process.argv.includes('--baseline') || process.argv.includes('--expect-rejection');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'TEST-flyfish-preview-'));
const project = path.join(sandbox, 'project');
const artifacts = path.join(sandbox, 'artifacts');
const claudeRoot = path.join(sandbox, 'claude');
const userDataRoot = path.join(sandbox, 'user-data');
await Promise.all(
  [project, artifacts, claudeRoot, userDataRoot].map((dir) => mkdir(dir, { recursive: true }))
);
const receipt: Record<string, unknown> = {
  sandbox,
  project,
  platform: process.platform,
  baseline,
  cases: [],
};
const cases: Record<string, unknown>[] = [];
receipt.cases = cases;
receipt.productionAssets = production;
const appLogs: string[] = [];
let app: ChildProcess | null = null;
let cdp: Cdp | null = null;
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('No port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
async function launch(): Promise<Cdp> {
  const port = await freePort();
  const executable = production
    ? path.join(repo, 'node_modules/electron/dist/electron')
    : process.execPath;
  const args = production
    ? [`--remote-debugging-port=${port}`, '--no-sandbox', repo]
    : [
        path.join(repo, 'node_modules/electron-vite/bin/electron-vite.js'),
        'dev',
        '--remoteDebuggingPort',
        String(port),
        ...(process.platform === 'linux' ? ['--noSandbox'] : []),
      ];
  app = spawn(executable, args, {
    cwd: repo,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: production ? 'production' : 'development',
      AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
      AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claudeRoot,
      AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userDataRoot,
      CLAUDE_CONFIG_DIR: claudeRoot,
      CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
      NODE_BINARY: process.execPath,
      CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: process.execPath,
    },
  });
  const remember = (chunk: Buffer) => {
    appLogs.push(chunk.toString());
    if (appLogs.length > 200) appLogs.shift();
  };
  app.stdout?.on('data', remember);
  app.stderr?.on('data', remember);
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    if (app.exitCode !== null) throw new Error(`Electron exited (${app.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      });
      const targets = (await response.json()) as {
        type: string;
        url: string;
        webSocketDebuggerUrl?: string;
      }[];
      const target = targets.find(
        (item) =>
          item.type === 'page' && !item.url.startsWith('devtools:') && item.webSocketDebuggerUrl
      );
      if (target?.webSocketDebuggerUrl) {
        const client = await Cdp.connect(target.webSocketDebuggerUrl);
        await client.send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
        await client.send('Runtime.enable');
        await client.send('Page.enable');
        await client.send('Network.enable');
        await client.send('Log.enable');
        cdp = client; // Preserve startup diagnostics/screenshot if renderer mounting fails.
        await client.wait(
          'window.electronAPI?.editor && document.querySelector("#root")?.childElementCount',
          'Electron renderer'
        );
        await client.wait('!document.querySelector("#splash")', 'application splash dismissed');
        return client;
      }
    } catch (error) {
      if (cdp) throw error; /* retry only before CDP attachment */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Electron CDP startup timed out');
}
const viewExpression = `(await window.__editorSourceImport('utils/editorBridge.ts')).editorBridge.getView()`;
const storeExpression = `(await window.__editorSourceImport('store/index.ts')).useStore`;
async function mountProductionPreview(client: Cdp): Promise<void> {
  // Production asset smoke uses the real preload reader and packaged iframe entry.
  // The full project editor routing is exercised separately by the dev UI cases.
  await client.evaluate(`(async () => {
    await window.electronAPI.editor.open(${JSON.stringify(project)});
    document.querySelector('#root').style.display='none';
    const container=document.createElement('div');container.id='editor-large-e2e';
    container.style.cssText='position:fixed;inset:0;background:#18181b;color:white';document.body.append(container);
    window.__productionPreviewOpen=async(file,theme='dark')=>{
      container.replaceChildren();
      if(file.endsWith('small.txt')) {const result=await window.electronAPI.editor.readFile(file);const pre=document.createElement('pre');pre.textContent=result.content;container.append(pre);return;}
      let preview;
      try{preview=await window.electronAPI.editor.readDocumentPreview(file);}
      catch(error){container.dataset.documentPreview=String(error).includes('20 MB')?'limit':'error';container.textContent=String(error);return;}
      container.dataset.documentPreview='loading';const frame=document.createElement('iframe');
      frame.src='document-preview://viewer/document-preview.html?parentOrigin=null';frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.style.cssText='width:100%;height:100%;border:0';
      const requestId=crypto.randomUUID();
      const receive=event=>{if(event.source!==frame.contentWindow||event.origin!=='document-preview://viewer'||event.data?.protocol!=='document-preview-v1')return;
        if(event.data.kind==='initialized'){const buffer=new Uint8Array(preview.bytes).buffer;frame.contentWindow.postMessage({protocol:'document-preview-v1',kind:'load',requestId,buffer,fileName:preview.fileName,theme},'document-preview://viewer',[buffer]);return;}
        if(event.data.requestId!==requestId)return;
        if(event.data.kind==='ready'||event.data.kind==='error')container.dataset.documentPreview=event.data.kind;};
      window.addEventListener('message',receive);
      container.append(frame);
    };
  })()`);
}

async function mountEditor(client: Cdp): Promise<void> {
  if (production) return mountProductionPreview(client);
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
  await client.wait(
    `(async () => { const s = ${storeExpression}.getState(); return s.editorProjectPath === ${JSON.stringify(project)} && !s.editorFileTreeLoading && !!s.editorFileTree; })()`,
    'sandbox editor initialization'
  );
}
async function open(client: Cdp, file: string, editable = false): Promise<number> {
  const start = Date.now();
  if (production) {
    await client.evaluate(`window.__productionPreviewOpen(${JSON.stringify(file)})`);
    return Date.now() - start;
  }
  await client.evaluate(
    `(async () => { ${storeExpression}.getState().openFile(${JSON.stringify(file)}); })()`
  );
  if (editable)
    await client.wait(
      `(async () => { const view = ${viewExpression}; const store = ${storeExpression}.getState(); return store.editorActiveTabId === ${JSON.stringify(file)} && !!view && document.querySelector('#editor-large-e2e [data-editor-file]')?.getAttribute('data-editor-file') === ${JSON.stringify(file)} && document.querySelector('#editor-large-e2e .cm-content'); })()`,
      `CodeMirror ${path.basename(file)}`
    );
  if (!editable)
    await client.evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'
    );
  return Date.now() - start;
}
async function screenshot(client: Cdp, name: string): Promise<void> {
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  assert(shot.data);
  await writeFile(path.join(artifacts, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function previewContext(client: Cdp) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const candidates = client.contexts
      .filter((item) => item.origin === 'document-preview://viewer')
      .reverse();
    for (const context of candidates) {
      try {
        if (await client.evaluate('!!document.querySelector("#root")', context)) return context;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Preview execution context missing');
}
try {
  const fixtures = process.env.FLYFISH_E2E_FIXTURES;
  assert(fixtures, 'FLYFISH_E2E_FIXTURES must contain real valid sample.pdf/docx/xlsx/pptx');
  for (const name of ['sample.pdf', 'sample.docx', 'sample.xlsx', 'sample.pptx', 'external.docx']) {
    await copyFile(path.join(fixtures, name), path.join(project, name));
  }
  await writeFile(path.join(project, 'small.txt'), 'Text editor remains available');
  await writeFile(path.join(project, 'corrupt.pdf'), '%PDF-1.7\nbroken document');
  await writeFile(path.join(project, 'corrupt.docx'), Buffer.from([0x50, 0x4b, 3, 4, 0, 1]));
  await writeFile(path.join(project, 'oversized.pdf'), '%PDF-1.7');
  await truncate(path.join(project, 'oversized.pdf'), 21 * 1024 * 1024);
  cdp = await launch();
  await mountEditor(cdp);
  if (!production)
    await cdp.evaluate(`(async()=>{
    const store=${storeExpression}; const state=store.getState();
    store.setState({appConfig:{...state.appConfig,general:{...state.appConfig?.general,theme:'dark'}}});
    window.__previewAcknowledgements=[];
    window.addEventListener('message',event=>{
      if(event.origin==='document-preview://viewer'&&event.data?.protocol==='document-preview-v1'&&event.data.kind==='ready')
        window.__previewAcknowledgements.push(event.data.requestId);
    });
  })()`);
  const originals = new Map<string, string>();
  for (const extension of ['pdf', 'docx', 'xlsx', 'pptx']) {
    const file = path.join(project, 'sample.' + extension);
    originals.set(file, hash(await readFile(file)));
    await open(cdp, file);
    await cdp.wait(
      'document.querySelector("[data-document-preview=ready]")',
      'actual ' + extension + ' preview',
      120_000
    );
    const context = await previewContext(cdp);
    const contentExpression = `(() => {
      const visit = (node) => {
        let text=''; let paintedCanvases=0; let cellInk=0;
        const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);
        while(walker.nextNode()) if(!walker.currentNode.parentElement?.closest('style,script') && walker.currentNode.parentElement?.getClientRects().length) text+=' '+walker.currentNode.textContent;
        for(const canvas of node.querySelectorAll?.('canvas')||[]) {
          if(canvas.width<100||canvas.height<100)continue;
          try {const data=canvas.getContext('2d')?.getImageData(0,0,canvas.width,canvas.height).data;let dark=0;
            if(data)for(let i=0;i<data.length;i+=16) {
              const pixel=i/4; const x=pixel%canvas.width; const y=Math.floor(pixel/canvas.width);
              if(data[i+3]>0&&(data[i]<230||data[i+1]<230||data[i+2]<230))dark++;
              // Ignore row/column headers and pale grid lines. Metadata plus header
              // ink is not proof that asynchronous workbook cells have painted.
              if(x>100&&y>60&&y<canvas.height-70&&data[i+3]>0&&data[i]<100&&data[i+1]<100&&data[i+2]<100)cellInk++;
            }
            if(dark>10)paintedCanvases++;
          }catch{}
        }
        for(const element of node.querySelectorAll?.('*')||[]) if(element.shadowRoot) {const value=visit(element.shadowRoot);text+=' '+value.text;paintedCanvases+=value.paintedCanvases;cellInk+=value.cellInk;}
        return {text:text.replace(/\\s+/g,' ').trim(),paintedCanvases,cellInk};
      };
      const info=visit(document.querySelector('#root'));let parentAccessible=false;
      try{parentAccessible=!!parent.electronAPI;}catch{}
      return {...info,api:!!window.electronAPI,parentAccessible};
    })()`;
    let info: { text: string; paintedCanvases: number; cellInk: number; parentAccessible: boolean; api: boolean };
    const until = Date.now() + 60_000;
    while (true) {
      info = await cdp.evaluate(contentExpression, context);
      const rendered =
        extension === 'pdf'
          ? info.paintedCanvases > 0 && info.text.includes('The magic of Prince')
          : extension === 'xlsx'
            ? info.cellInk > 100 &&
              info.text.includes('701 rows, 16 columns') &&
              info.text.includes('100%') &&
              !info.text.includes('Parsing Excel')
            : extension === 'pptx'
              ? info.text.includes('NASA') && info.text.includes('Artemis')
              : info.text.length > 100 && !info.text.includes('Loading Word');
      if (rendered) break;
      if (Date.now() > until)
        throw new Error('Actual ' + extension + ' content not rendered: ' + info.text.slice(-800));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(
      !info.api && !info.parentAccessible,
      'preview must not access privileged parent/preload'
    );
    const restrictions = await cdp.evaluate<number[]>(
      `Promise.all(['/package.json','/@fs/etc/passwd','/%2f..%2fsecret'].map(path=>fetch('document-preview://viewer'+path).then(response=>response.status)))`,
      context
    );
    assert(
      restrictions.every((status) => status === 403),
      'protocol must refuse files outside viewer asset allowlist'
    );
    assert(info.text.length > 100 || info.paintedCanvases > 0, 'actual rendered document content');
    assert(
      !cdp.previewRequests.some((url) => /^https?:/.test(url)),
      'documents must use local preview assets'
    );
    if (extension === 'pdf' && !production) {
      for (const theme of ['light', 'dark']) {
        const count = await cdp.evaluate<number>('window.__previewAcknowledgements.length');
        await cdp.evaluate(
          `(async()=>{const store=${storeExpression};const state=store.getState();store.setState({appConfig:{...state.appConfig,general:{...state.appConfig.general,theme:${JSON.stringify(theme)}}}});})()`
        );
        await cdp.wait(
          `window.__previewAcknowledgements.length>${count}&&document.querySelector('[data-document-preview=ready]')`,
          'fresh theme load acknowledgement'
        );
        assert.equal(
          await cdp.evaluate('document.body.classList.contains("dark")', context),
          theme === 'dark'
        );
      }
      const ids: string[] = await cdp.evaluate<string[]>('window.__previewAcknowledgements');
      assert.equal(
        new Set(ids).size,
        ids.length,
        'each theme load owns a new acknowledgement identity'
      );
      receipt.themeReload = true;
    }
    await screenshot(cdp, 'preview-' + extension);
    cases.push({
      extension,
      ...info,
      text: info.text.slice(0, 1200),
      requests: cdp.previewRequests,
    });
    await open(cdp, path.join(project, 'small.txt'), true);
    await cdp.wait(
      '!document.querySelector("#editor-large-e2e iframe")',
      'iframe removed on tab switch'
    );
  }
  await open(cdp, path.join(project, 'external.docx'));
  await cdp.wait(
    'document.querySelector("[data-document-preview=ready]")',
    'DOCX external resources blocked'
  );
  await open(cdp, path.join(project, 'corrupt.pdf'));
  await cdp.wait(
    'document.querySelector(\"[data-document-preview=error]\")',
    'PDF parser error fallback',
    90_000
  );
  await screenshot(cdp, 'pdf-parser-fallback');
  await open(cdp, path.join(project, 'corrupt.docx'));
  await cdp.wait(
    'document.querySelector("[data-document-preview=error]")',
    'corrupt fallback',
    120_000
  );
  await screenshot(cdp, 'corrupt-fallback');
  await open(cdp, path.join(project, 'oversized.pdf'));
  await cdp.wait('document.querySelector("[data-document-preview=limit]")', 'oversize fallback');
  for (const [file, digest] of originals)
    assert.equal(hash(await readFile(file)), digest, 'preview never writes source');
  const remote = cdp.previewRequests.filter(
    (url) => /^https?:/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1):/.test(url)
  );
  assert.deepEqual(remote, [], 'no external requests for all document cases');
  receipt.ok = true;
  receipt.network = cdp.previewRequests;
  receipt.parentAPIIsolated = true;
  receipt.tabCleanup = true;
} catch (error) {
  receipt.ok = false;
  receipt.error = String(error);
  receipt.contexts = cdp?.contexts;
  receipt.exceptions = cdp?.exceptions;
  receipt.network = cdp?.network;
  if (cdp) {
    try {
      await screenshot(cdp, 'failure');
    } catch {}
  }
  console.error(receipt);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await writeFile(path.join(artifacts, 'electron.log'), appLogs.join(''));
  cdp?.socket.close();
  const owned = app as ChildProcess | null;
  if (owned?.pid && owned.exitCode === null) {
    try {
      process.kill(process.platform === 'win32' ? owned.pid : -owned.pid, 'SIGTERM');
    } catch {}
  }
  console.log('Artifacts: ' + artifacts);
}
