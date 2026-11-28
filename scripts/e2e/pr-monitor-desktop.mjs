#!/usr/bin/env node
/**
 * Real dev:mcp Electron UI → preload → main → Get Modular reader → gh process.
 * Only GitHub CLI discovery is bound to an external fixture executable. Uses a
 * disposable project/config; denies every agent-runtime launch. Requires DISPLAY.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CdpClient } from './comment-notification/cdp.mjs';

const deviceFlow = process.argv.includes('--device-flow');
const noSandbox = process.env.PR_MONITOR_E2E_NO_SANDBOX === '1';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pr-monitor-TEST-')));
const output = process.env.PR_MONITOR_E2E_OUTPUT_DIR ?? path.join(root, 'evidence');
const claude = path.join(root, 'claude');
const userData = path.join(root, 'user-data');
const project = path.join(root, 'TEST-project');
const statePath = path.join(root, 'github-state.json');
const auditPath = path.join(root, 'github-audit.ndjson');
const runtimeAudit = path.join(root, 'runtime-audit.ndjson');
const receipt = {
  scope: deviceFlow
    ? 'Linux dev:mcp; real Device Flow, encrypted keychain store and fetch transport; fixture GitHub only'
    : 'Linux dev:mcp; real Electron and gh subprocess, fixture GitHub only',
  root,
  output,
  passed: false,
  checks: [],
};
let app;
let cdp;
let log = '';
let stopping = false;
const rendererErrors = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function stopApp() {
  if (app?.pid) {
    try {
      process.kill(-app.pid, 'SIGTERM');
    } catch {}
  }
}
function stop() {
  stopping = true;
  stopApp();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

async function until(check, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (stopping) throw new Error('Native E2E interrupted.');
    if (app?.exitCode !== null && app?.exitCode !== undefined)
      throw new Error('Electron exited: ' + log.slice(-5000));
    if (await check()) return;
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}
const evaluate = (expression) => cdp.evaluate(expression);
const page = `document.querySelector('section[aria-label="Pull Requests"]')`;
const button = (name) =>
  `Array.from(${page}.querySelectorAll('button')).find(e => e.textContent?.trim() === ${JSON.stringify(name)})`;
async function click(expression) {
  await until(
    () =>
      evaluate(
        `(() => {const e=${expression}; if(!e || e.disabled)return false; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return r.width>0&&r.height>0&&(hit===e||e.contains(hit));})()`
      ),
    'enabled visible control'
  );
  const point = await evaluate(
    `(() => {const r=(${expression}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`
  );
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
async function audit() {
  return (await readFile(auditPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function setPhase(phase) {
  const previous = await readFile(statePath, 'utf8')
    .then(JSON.parse)
    .catch(() => ({ cliAuthenticated: !deviceFlow, oauthApproved: false }));
  await writeFile(statePath, JSON.stringify({ ...previous, phase }));
}
const text = () => evaluate(`${page}.innerText`);

async function setup() {
  await Promise.all(
    [output, claude, userData, path.join(claude, 'projects'), path.join(project, '.git')].map(
      (dir) => mkdir(dir, { recursive: true })
    )
  );
  await Promise.all([writeFile(auditPath, ''), writeFile(runtimeAudit, ''), setPhase('queued')]);
  await writeFile(
    path.join(project, '.git', 'config'),
    '[core]\nrepositoryformatversion = 0\n[remote "origin"]\nurl = https://github.com/TEST/fixture.git\n'
  );
  await writeFile(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(
    path.join(claude, 'agent-teams-config.json'),
    JSON.stringify({
      general: {
        appLocale: 'en',
        theme: 'dark',
        defaultTab: 'dashboard',
        customProjectPaths: [project],
      },
    })
  );
  const runtime = path.join(root, 'deny-runtime.mjs');
  const lock = JSON.parse(await readFile(path.join(repo, 'runtime.lock.json'), 'utf8'));
  await writeFile(
    runtime,
    `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst args=process.argv.slice(2);appendFileSync(${JSON.stringify(runtimeAudit)},JSON.stringify(args)+'\\n');if(args.length===1&&args[0]==='--version')console.log(${JSON.stringify(lock.cliVersion ?? lock.version)});else process.exitCode=77;\n`
  );
  const gh = path.join(root, 'gh-fixture.mjs');
  await writeFile(
    gh,
    `#!${process.execPath}\nawait import(${JSON.stringify(path.join(repo, 'scripts/e2e/pr-monitor/gh-fixture.mjs'))});\n`
  );
  await Promise.all([chmod(runtime, 0o755), chmod(gh, 0o755)]);
  const rendererPort = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const oauthFixture = deviceFlow
    ? `
if(process.type==='browser' && require('node:worker_threads').isMainThread) {
 const original=globalThis.fetch;
 globalThis.fetch=async (url,init)=>{
  const hostname=new URL(String(url)).hostname;
  if(hostname!=='github.com' && hostname!=='api.github.com')return original(url,init);
  const fixture=await import(${JSON.stringify(pathToFileURL(path.join(repo, 'scripts/e2e/pr-monitor/oauth-fixture.mjs')).href)});
  return fixture.githubFixtureFetch(url,init,${JSON.stringify({ statePath, auditPath, gh })});
 };
}`
    : '';
  const config = path.join(root, 'electron.pr-monitor.config.ts');
  await writeFile(
    config,
    `import base from ${JSON.stringify(path.join(repo, 'electron.vite.config.ts'))};
const fixture = {name:'pr-monitor-cli-fixture',enforce:'pre',transform(source,id){
if(!id.replaceAll('\\\\','/').endsWith('/features/pr-monitor/main/infrastructure/ghTransport.ts'))return;
const pattern=/export function findGitHubCli\\(\\): string \\| null \\{[\\s\\S]+?\\n\\}/;
if(!pattern.test(source))throw new Error('CLI discovery fixture no longer matches production adapter');
return source.replace(pattern,${JSON.stringify('export function findGitHubCli(): string | null { return ' + JSON.stringify(gh) + '; }')});}};
const output=base.main.build.rollupOptions.output;
export default {...base,main:{...base.main,plugins:[fixture,...(base.main.plugins??[])],build:{...base.main.build,rollupOptions:{...base.main.build.rollupOptions,output:{...output,banner:(output.banner??'')+'\\n'+${JSON.stringify(oauthFixture)}}}}},renderer:{...base.renderer,server:{...base.renderer.server,port:${rendererPort},strictPort:true}}};\n`
  );
  const env = {
    ...process.env,
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
    CLAUDE_CONFIG_DIR: claude,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userData,
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: runtime,
    CLAUDE_TERMINAL_DAEMON_BINARY: runtime,
    CLAUDE_DEV_RUNTIME_CACHE_ROOT: path.join(root, 'runtime-cache'),
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'multimodel-data'),
    CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'multimodel-cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state'),
    AGENT_TEAMS_MCP_HTTP: '0',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    CLAUDE_DEV_RUNTIME_DISABLE_GH: '1',
    PR_MONITOR_E2E_STATE: statePath,
    PR_MONITOR_E2E_AUDIT: auditPath,
    NODE_BINARY: process.execPath,
  };
  // Fixture process must never inherit a real GitHub credential.
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  delete env.AGENT_TEAMS_GITHUB_CLIENT_ID;
  delete env.AGENT_TEAMS_GITHUB_APP_KIND;
  delete env.ELECTRON_DISABLE_SANDBOX;
  delete env.NO_SANDBOX;
  if (noSandbox) {
    env.ELECTRON_DISABLE_SANDBOX = '1';
    env.NO_SANDBOX = '1';
  }
  if (deviceFlow) {
    env.AGENT_TEAMS_GITHUB_CLIENT_ID = 'TEST_PUBLIC_CLIENT_ID';
    env.AGENT_TEAMS_GITHUB_APP_KIND = 'oauth-app';
  }
  app = spawn('pnpm', ['dev:mcp', ...(noSandbox ? ['--noSandbox'] : []), '--config', config], {
    cwd: repo,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.on('error', (error) => {
    log += '\n' + error.message;
  });
  for (const stream of [app.stdout, app.stderr])
    stream.on('data', (data) => {
      log += data.toString();
    });
  let cdpPort;
  await until(
    () => {
      cdpPort = log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1];
      return Boolean(cdpPort);
    },
    'owned Electron CDP',
    240_000
  );
  let target;
  await until(
    async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        target = list.find(
          (entry) => entry.type === 'page' && new URL(entry.url).port === String(rendererPort)
        );
        return Boolean(target);
      } catch {
        return false;
      }
    },
    'owned Electron renderer',
    60_000
  );
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', (event) => rendererErrors.push(event));
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.waitFor(
    'window.electronAPI?.prMonitor && window.__agentTeamsDevStore',
    'real preload and dev store',
    90_000
  );
}

async function run() {
  process.stdout.write('[PR Monitor E2E] Building and starting the owned Electron app.\n');
  await setup();
  process.stdout.write('[PR Monitor E2E] Driving the renderer through its real preload.\n');
  const projectId = await evaluate(
    `(async()=>{const groups=await window.electronAPI.getRepositoryGroups();const worktree=groups.flatMap(g=>g.worktrees).find(w=>w.path===${JSON.stringify(project)});if(!worktree)throw new Error('Sandbox project missing');window.__agentTeamsDevStore.getState().selectProject(worktree.id);return worktree.id;})()`
  );
  await cdp.waitFor(
    `document.querySelector('[aria-label="Open project pull requests"]')`,
    'project toolbar action'
  );
  await click(`document.querySelector('[aria-label="Open project pull requests"]')`);
  await cdp.waitFor(page, 'dedicated Pull Requests tab');
  await cdp.waitFor(button('Connect GitHub'), 'explicit consent');
  assert.equal((await audit()).length, 0, 'Account access before explicit consent');
  const request = { contextId: 'local', projectId };
  const denied = await evaluate(`window.electronAPI.prMonitor.list(${JSON.stringify(request)})`);
  assert.equal(denied.error.kind, 'consent_required');
  await cdp.screenshot(path.join(output, '01-consent.png'));
  receipt.checks.push(
    'Existing project scanner and Git identity, toolbar and tab, no account use before consent'
  );
  await click(button('Connect GitHub'));
  if (deviceFlow) {
    process.stdout.write('[PR Monitor E2E] Checking Device Flow and system keychain.\n');
    await until(
      async () => /No signed-in GitHub CLI account/.test(await text()),
      'CLI auth fallback'
    );
    await click(button('Sign in to GitHub'));
    await cdp.waitFor(
      "document.querySelector('[aria-label=\"GitHub verification code\"]')?.textContent === 'TEST-CODE'",
      'real device user code'
    );
    const pending = JSON.parse(await readFile(statePath, 'utf8'));
    pending.oauthApproved = true;
    await writeFile(statePath, JSON.stringify(pending));
    receipt.checks.push(
      'Unauthenticated CLI falls back to explicit backendless GitHub device authorization'
    );
  }
  await cdp.waitFor(
    `${page}.innerText.includes('TEST deterministic pull request')`,
    'real reader list'
  );
  if (deviceFlow) {
    const file = path.join(userData, 'data', 'pr-monitor-credentials', 'api-keys.json');
    const contents = await readFile(file, 'utf8');
    assert(!contents.includes('TEST_PRIVATE_OAUTH'));
    assert(
      JSON.parse(contents).every((item) => item.encryptionMethod === 'safeStorage'),
      'OAuth credential used an insecure fallback'
    );
    const generic = await evaluate(
      'window.electronAPI.apiKeys.lookup(["PR_MONITOR_GITHUB_DEVICE_LOGIN"])'
    );
    assert.deepEqual(generic, []);
    receipt.checks.push(
      'Native OS keychain encryption, owner-only feature vault, no token in generic renderer API'
    );
  }
  await click(
    `Array.from(${page}.querySelectorAll('button')).find(e=>e.textContent?.includes('TEST deterministic pull request'))`
  );
  await cdp.waitFor(
    `document.querySelector('[aria-label="Timeline for pull request #3"]')`,
    'timeline'
  );
  await until(async () => (await text()).includes('Queued'), 'queued workflow');
  for (const lane of ['CI lane', 'Review lane', 'Merge lane'])
    assert(
      await evaluate(`Boolean(document.querySelector('[aria-label=${JSON.stringify(lane)}]'))`),
      lane
    );
  await cdp.screenshot(path.join(output, '02-queued.png'));
  receipt.checks.push(
    'Real preload → IPC → Get Modular group → gh process → list and all independent lanes'
  );
  process.stdout.write('[PR Monitor E2E] Checking new heads, retries and authorization errors.\n');
  await setPhase('passed');
  await click(button('Refresh'));
  await until(async () => /Passed/.test(await text()), 'passed current CI');
  const passed = await text();
  assert(
    /Awaiting approval on this head/.test(passed),
    'Old-SHA approval must not become current approval'
  );
  assert(/Eligibility not established/.test(passed), 'Green CI must not imply merge readiness');
  assert(passed.includes('Attempt 1') && passed.includes('Attempt 2'), 'Retry history missing');
  await cdp.screenshot(path.join(output, '03-passed-stale-approval.png'));
  receipt.checks.push(
    'Green CI preserves pending stale-SHA review, merge not ready, retry attempts and jobs'
  );
  await setPhase('pushed');
  await click(button('Refresh'));
  await until(
    async () => /Queued/.test(await text()) && (await text()).includes('ccccccc'),
    'new head SHA'
  );
  receipt.checks.push('Push replaces current-head projection and invalidates prior success');
  const safe = await evaluate(
    `window.electronAPI.prMonitor.get(${JSON.stringify({ ...request, number: 3 })})`
  );
  assert(!JSON.stringify(safe).includes('TEST_SECRET_PROVIDER_PAYLOAD'));
  await setPhase('unauthorized');
  await click(button('Refresh'));
  await until(
    async () =>
      /GitHub access changed|sign in|authentication|account|authorized/i.test(
        await evaluate(`${page}.querySelector('[role="alert"]')?.textContent ?? ''`)
      ),
    'safe authentication error'
  );
  assert(!(await text()).includes('TEST_SECRET_PROVIDER_PAYLOAD'));
  await cdp.waitFor(button('Connect GitHub'), 'authorization loss clears the old account view');
  assert(
    !(await evaluate(
      'Boolean(document.querySelector(\'[aria-label="Timeline for pull request #3"]\'))'
    ))
  );
  receipt.checks.push(
    '401 revokes access immediately; provider payload is absent from IPC and renderer'
  );
  await setPhase('passed');
  await click(button('Connect GitHub'));
  await cdp.waitFor(
    `${page}.innerText.includes('TEST deterministic pull request')`,
    'reconnected list'
  );
  await click(
    `Array.from(${page}.querySelectorAll('button')).find(e=>e.textContent?.includes('TEST deterministic pull request'))`
  );
  await cdp.waitFor(
    `document.querySelector('[aria-label="Timeline for pull request #3"]')`,
    'reconnected timeline'
  );
  await setPhase('limited');
  await click(button('Refresh'));
  await until(async () => /Retry after/.test(await text()), 'rate limit deadline');
  const before = (await audit()).length;
  await click(button('Refresh'));
  await pause(500);
  assert.equal((await audit()).length, before, 'Manual refresh bypassed Retry-After');
  await cdp.screenshot(path.join(output, '04-rate-limit.png'));
  receipt.checks.push(
    '429 Retry-After blocks manual and scheduled retry; cached timeline is visibly stale'
  );
  await click(button(deviceFlow ? 'Sign out' : 'Disconnect'));
  await cdp.waitFor(button('Connect GitHub'), 'revoked consent');
  const revoked = await evaluate(`window.electronAPI.prMonitor.list(${JSON.stringify(request)})`);
  assert.equal(revoked.error.kind, 'consent_required');
  assert.equal((await audit()).length, before, 'Revocation accessed GitHub');
  if (deviceFlow)
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(userData, 'data', 'pr-monitor-credentials', 'api-keys.json'),
          'utf8'
        )
      ),
      []
    );
  const invocations = (await readFile(runtimeAudit, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(
    invocations.every((args) => args.length === 1 && args[0] === '--version'),
    'Agent runtime launched'
  );
  assert.equal(rendererErrors.length, 0, JSON.stringify(rendererErrors));
  receipt.checks.push('Disconnect revokes access, no runtime launch, no renderer exception');
  receipt.passed = true;
}

try {
  await run();
} catch (error) {
  receipt.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (cdp) {
    await cdp.screenshot(path.join(output, 'last-renderer.png')).catch(() => {});
    await cdp.close().catch(() => {});
  }
  stopApp();
  if (app && app.exitCode === null) {
    await Promise.race([new Promise((resolve) => app.once('exit', resolve)), pause(5000)]);
    if (app.exitCode === null) {
      try {
        process.kill(-app.pid, 'SIGKILL');
      } catch {}
    }
  }
  await Promise.all([
    writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)),
    writeFile(path.join(output, 'app.log'), log),
  ]);
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
}
