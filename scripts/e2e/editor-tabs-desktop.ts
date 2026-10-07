#!/usr/bin/env node
/** Sandbox-only project tab persistence and local icon proof.
 * Run: xvfb-run -a node --experimental-strip-types scripts/e2e/editor-tabs-desktop.ts
 * Launches the dev:mcp wrapper with an isolated CDP port and user data; never agents.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** JSON literals embedded in evaluated JavaScript also escape HTML/script separators. */
function jsLiteral(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Cannot serialize undefined as JavaScript literal');
  return serialized.replace(/[<>&\u2028\u2029]/g,
    (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

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

const repo = process.env.EDITOR_TABS_TEST_REPO ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const viewExpression = `(await window.__editorSourceImport('utils/editorBridge.ts')).editorBridge.getView()`;
const storeExpression = `(await window.__editorSourceImport('store/index.ts')).useStore`;
async function mountEditor(client: Cdp, project: string): Promise<void> {
  // Mount the real overlay with its normal providers via dev imports. No production
  // test hooks, native picker, runtime, or team provisioning are involved.
  await client.evaluate(`(async () => {
    window.__editorE2eRoot?.unmount(); document.querySelector('#editor-large-e2e')?.remove(); window.__editorErrors = [];
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
    const { LocalizationProvider } = await import(${jsLiteral('/@fs' + repo + '/src/features/localization/renderer/ui/LocalizationProvider.tsx')});
    const container = document.createElement('div'); container.id = 'editor-large-e2e'; document.body.append(container);
    const root = createRoot(container); window.__editorE2eRoot = root;
    root.render(React.createElement(LocalizationProvider, { appConfig: null },
      React.createElement(TooltipProvider, {}, React.createElement(ProjectEditorOverlay, {
        projectPath: ${jsLiteral(project)}, onClose: () => root.unmount()
      }))));
  })()`);
  await client.wait(`(async () => { const s = ${storeExpression}.getState(); return s.editorProjectPath === ${jsLiteral(project)} && !s.editorFileTreeLoading && !!s.editorFileTree; })()`, 'sandbox editor initialization');
}
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'TEST-editor-project-tabs-'));
const artifacts = path.join(sandbox, 'artifacts');
const projectA = path.join(sandbox, 'project-a');
const projectB = path.join(sandbox, 'project-b');
const claudeRoot = path.join(sandbox, 'claude');
const userDataRoot = path.join(sandbox, 'user-data');
await Promise.all([artifacts,projectA,projectB,claudeRoot,userDataRoot].map(dir=>mkdir(dir,{recursive:true})));
const first = path.join(projectA, 'first.txt');
const renamed = path.join(projectA, 'renamed.txt');
const missing = path.join(projectA, 'missing.txt');
const office = ['report.pdf','letter.docx','book.xlsx','slides.pptx'].map(name=>path.join(projectA,name));
const bFiles = ['b-first.txt','b-second.txt'].map(name=>path.join(projectB,name));
await Promise.all([first,...office,...bFiles].map(file=>writeFile(file,'sandbox-original\n')));
let app: ChildProcess|null = null;
let client: Cdp|null = null;
const logs: string[] = [];
const receipt: Record<string,unknown> = {sandbox,repo,userDataRoot,cases:[],launches:[]};
const cases=receipt.cases as Record<string,unknown>[];
async function freePort(): Promise<number> {
 return await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string')return reject(Error('No port'));server.close(()=>resolve(address.port));});});
}
async function launch(): Promise<Cdp> {
 const port=await freePort();
 const args=[path.join(repo,'scripts/dev-with-runtime.mjs'),'--remoteDebuggingPort',String(port), ...(process.getuid?.()===0?['--noSandbox']:[])];
 (receipt.launches as unknown[]).push({command:[process.execPath,...args],port});
 app=spawn(process.execPath,args,{cwd:repo,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'development',AGENT_TEAMS_DISABLE_SOURCEMAPS:'1',AGENT_TEAMS_ELECTRON_CLAUDE_ROOT:claudeRoot,AGENT_TEAMS_ELECTRON_USER_DATA_DIR:userDataRoot,CLAUDE_CONFIG_DIR:claudeRoot,CLAUDE_TEAM_OPENCODE_MCP_HTTP:'0',NODE_BINARY:process.execPath,CLAUDE_DEV_RUNTIME_CACHE_ROOT:path.join(repo,'.test-tmp-dev-mcp/runtime-cache')}});
 app.stdout?.on('data',(chunk:Buffer)=>logs.push(chunk.toString()));app.stderr?.on('data',(chunk:Buffer)=>logs.push(chunk.toString()));
 const until=Date.now()+180000;
 while(Date.now()<until){
  if(app.exitCode!==null)throw Error('app exited '+app.exitCode);
  try{
   const response=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)});
   const targets=await response.json() as {type:string;url:string;webSocketDebuggerUrl?:string}[];
   const target=targets.find(t=>t.type==='page'&&!t.url.startsWith('devtools:')&&t.webSocketDebuggerUrl);
   if(target?.webSocketDebuggerUrl){const c=await Cdp.connect(target.webSocketDebuggerUrl);await c.send('Runtime.enable');await c.send('Page.enable');await c.wait('window.electronAPI?.editor && document.querySelector("#root")?.childElementCount','app renderer');await c.send('Network.enable');await c.send('Network.setBlockedURLs',{urls:['*cdn.jsdelivr.net*','*unpkg.com*']});return c;}
  }catch{ /* bounded startup */ }
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 throw Error('startup timeout');
}
async function stop():Promise<void>{client?.socket.close();client=null;if(app?.pid){try{process.kill(-app.pid,'SIGTERM');}catch{}await new Promise<void>(resolve=>{if(app?.exitCode!==null)return resolve();app?.once('exit',()=>resolve());setTimeout(resolve,5000);});}app=null;}
async function state(c:Cdp):Promise<{paths:string[];active:string|null}>{return c.evaluate(`(async()=>{const s=${storeExpression}.getState();return {paths:s.editorOpenTabs.map(t=>t.filePath),active:s.editorActiveTabId};})()`);}
async function action(c:Cdp,method:string,...args:unknown[]):Promise<unknown>{return c.evaluate(`(async()=>${storeExpression}.getState()[${jsLiteral(method)}](...${jsLiteral(args)}))()`);}
async function shot(c:Cdp,name:string):Promise<void>{await c.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const data=await c.send('Page.captureScreenshot',{format:'png'});assert(data.data);await writeFile(path.join(artifacts,name+'.png'),Buffer.from(data.data,'base64'));}
async function expectSession(c:Cdp,paths:string[],active:string|null,label:string):Promise<void>{assert.deepEqual(await state(c),{paths,active},label);cases.push({case:label,result:'PASS',paths,active});}
async function waitView(c:Cdp,file:string):Promise<void>{await c.wait(`(async()=>{const view=${viewExpression};return !!view&&document.querySelector('#editor-large-e2e [data-editor-file]')?.getAttribute('data-editor-file')===${jsLiteral(file)};})()`,'actual CodeMirror '+path.basename(file));}
async function closeDialog(c:Cdp,button:string):Promise<void>{await c.evaluate(`document.querySelector('#editor-large-e2e button[aria-label="Close editor"]').click()`);await c.wait('!!document.querySelector("[role=dialog]")','unsaved dialog');await c.evaluate(`(()=>{const button=[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent===${jsLiteral(button)});if(!button)throw Error('button missing');button.click();})()`);}
const started=Date.now();
try{
 client=await launch();
 await mountEditor(client,projectA);
 for(const file of [...office,first])await action(client,'openFile',file);
 await action(client,'reorderEditorTabs',first,office[0]);
 await waitView(client,first);
 const icons=await client.evaluate<{tab:{name:string;svg:boolean;image:boolean;color:string}[];tree:{name:string;svg:boolean;image:boolean;color:string}[]}>(`(()=>{const names=${jsLiteral(office.map(f=>path.basename(f)))};const tab=names.map(name=>{const node=[...document.querySelectorAll('#editor-large-e2e [role=tab]')].find(t=>t.textContent.includes(name));const icon=node?.querySelector('svg');return{name,svg:!!icon,image:!!node?.querySelector('img'),color:icon?.style.color??''};});const tree=names.map(name=>{const text=[...document.querySelectorAll('#editor-large-e2e span')].find(n=>n.textContent===name&&!n.closest('[role=tab]'));const node=text?.parentElement;const icon=node?.querySelector('svg');return{name,svg:!!icon,image:!!node?.querySelector('img'),color:icon?.style.color??''};});return{tab,tree};})()`);
 assert(icons.tab.every(i=>i.svg&&!i.image&&i.color));assert(icons.tree.every(i=>i.svg&&!i.image&&i.color));assert.equal(new Set(icons.tab.map(i=>i.color)).size,4);cases.push({case:'Office tree and tab local SVG icons with CDN blocked',result:'PASS',icons});
 await shot(client,'project-a-icons');
 const aPaths=[first,...office];
 await mountEditor(client,projectB);for(const file of bFiles)await action(client,'openFile',file);await action(client,'reorderEditorTabs',bFiles[1],bFiles[0]);await action(client,'setActiveEditorTab',bFiles[0]);
 await mountEditor(client,projectA);await expectSession(client,aPaths,first,'A order and active restored after B');
 await mountEditor(client,projectB);await expectSession(client,[bFiles[1],bFiles[0]],bFiles[0],'B independent order and active');
 await client.send('Page.reload');await client.wait('window.electronAPI?.editor && document.querySelector("#root")?.childElementCount','reload');await mountEditor(client,projectA);await expectSession(client,aPaths,first,'renderer reload restores A');
 await action(client,'closeEditorTab',office[3]);await mountEditor(client,projectB);await mountEditor(client,projectA);aPaths.pop();await expectSession(client,aPaths,first,'closed tab stays closed after reopen');
 assert.equal(await action(client,'renameFileInTree',first,'renamed.txt'),true);aPaths[0]=renamed;
 await action(client,'deleteFileFromTree',office[2]);aPaths.splice(aPaths.indexOf(office[2]),1);
 await action(client,'openFile',missing);await client.wait(`!!document.querySelector('#editor-large-e2e [role=alert]')?.textContent.trim()`,'missing file existing error UX');cases.push({case:'missing restored file uses existing read error UI',result:'PASS'});
 await action(client,'setActiveEditorTab',renamed);await waitView(client,renamed);
 await client.evaluate(`(async()=>{const view=${viewExpression};view.dispatch({changes:{from:view.state.doc.length,insert:'DISCARDED'}});})()`);
 await client.wait(`localStorage.getItem(${jsLiteral('editor-draft:'+renamed)})?.includes('DISCARDED')`,'autosaved sandbox draft');
 await closeDialog(client,'Cancel');assert((await client.evaluate<string|null>(`localStorage.getItem(${jsLiteral('editor-draft:'+renamed)})`))?.includes('DISCARDED'));
 await closeDialog(client,'Discard & Close');await client.wait(`(async()=>${storeExpression}.getState().editorProjectPath===null)()`,'discard close');assert.equal(await client.evaluate(`localStorage.getItem(${jsLiteral('editor-draft:'+renamed)})`),null);
 await mountEditor(client,projectA);await waitView(client,renamed);assert.equal(await client.evaluate(`(async()=>(${viewExpression}).state.sliceDoc())()`),'sandbox-original\n');cases.push({case:'Cancel retains draft; Discard clears draft without changing disk or tab session',result:'PASS'});
 await client.evaluate(`(async()=>{const view=${viewExpression};view.dispatch({changes:{from:view.state.doc.length,insert:'SAVED'}});})()`);
 await closeDialog(client,'Save All & Close');await client.wait(`(async()=>${storeExpression}.getState().editorProjectPath===null)()`,'save all close');assert.equal(await readFile(renamed,'utf8'),'sandbox-original\nSAVED');cases.push({case:'Save All and Close writes actual sandbox content',result:'PASS'});
 await mountEditor(client,projectA);await waitView(client,renamed);
 await shot(client,'project-a-restored');
 await stop();client=await launch();await mountEditor(client,projectA);await expectSession(client,[...aPaths,missing],renamed,'full Electron process restart restores renamed/deleted/missing A tabs');
 await mountEditor(client,projectB);await expectSession(client,[bFiles[1],bFiles[0]],bFiles[0],'full Electron restart preserves independent B session');await shot(client,'project-b-restarted');
 receipt.status='PASS';receipt.durationMs=Date.now()-started;
}catch(error){receipt.status='FAIL';receipt.error=String(error);if(client)await shot(client,'failure').catch(()=>{});throw error;}
finally{await stop();await writeFile(path.join(artifacts,'receipt.json'),JSON.stringify(receipt,null,2));await writeFile(path.join(artifacts,'electron.log'),logs.join(''));console.log(JSON.stringify({status:receipt.status,durationMs:receipt.durationMs,artifacts,error:receipt.error}));}
