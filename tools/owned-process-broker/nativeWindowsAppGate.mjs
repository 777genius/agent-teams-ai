/** TEST real packaged Windows Main: explicit metadata Refresh, explicit Retry, original UI Kill. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Cdp } from '../../scripts/e2e/release-updater/cdp.mts';
import {
  packagedArtifact, fingerprint, preparePackagedProfile, packagedTarget,
  retainPackagedLineage, packagedOrphanObservation, packagedDrainSnapshot, closePackagedBrowser,
} from '../../scripts/e2e/opencode-diagnostics/packaged.mjs';
import {
  assertPortAvailable, processes, ownedTree, sameIdentity, listeners,
} from '../../scripts/e2e/opencode-diagnostics/platform.mjs';
import { readPackagedOpenCodeV2 } from '../../scripts/legacy-agent-host/packaged-opencode-v2-inputs.ts';
import { captureDesktopSourceHashes, verifyDesktopSourceFreeze } from '../../scripts/legacy-agent-host/desktop-source-freeze.ts';
import { desktopProofSources } from '../../scripts/legacy-agent-host/desktop-proof-sources.ts';
import { desktopProofWindowsRetrySources } from '../../scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts';
import { createDesktopUiControls, desktopJsLiteral } from '../../scripts/legacy-agent-host/desktop-ui-controls.ts';
import { desktopProcessOwnerExpression, readDesktopProcessData } from '../../scripts/legacy-agent-host/desktop-native-process-ui.ts';
import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { prepareNativeWindowsAppFixture } from './nativeWindowsAppFixture.ts';

const object = value => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value;
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = path => sha(readFileSync(path));
const errorText = error => error instanceof Error ? (error.stack ?? error.message).slice(0,4000) : String(error).slice(0,1000);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
assert.equal(args.length, 6, 'app.exe broker.exe query-fixture.exe selection.json selection-SHA256 receipt.json');
const [executable, broker, queryFixture, selectionPath, selectionSha256, receiptPath] = args;
for (const path of [executable, broker, queryFixture, selectionPath, receiptPath])
  assert.ok(isAbsolute(path) && resolve(path) === path && !/[\r\n\0]/u.test(path));
assert.equal(process.platform, 'win32');
assert.ok(process.arch === 'x64' || process.arch === 'arm64');
assert.equal(process.version, 'v24.21.0');
assert.equal(process.env.OWNED_PROCESS_VENDOR_TEST_GO, '1');
assert.match(process.env.EXPECTED_SOURCE_SHA ?? '', /^[a-f0-9]{40}$/);
assert.match(selectionSha256, /^[a-f0-9]{64}$/);
assert.match(basename(executable), /\.exe$/i);
assert.ok(!/(?:setup|uninstall)/i.test(basename(executable)));
assert.equal(existsSync(receiptPath), false);
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
assert.equal(sourceHead, process.env.EXPECTED_SOURCE_SHA);
const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-windows-retained-ui-')));
const artifact = await packagedArtifact(executable);
const resourcesRoot = join(dirname(artifact.app.path), 'resources/legacy-agent-host');
const packagedCapture = {
  resourcesRoot, manifestSha256: hash(join(resourcesRoot, 'opencode-v2-candidate.json')),
  appAsar: artifact.archive.path, appAsarSha256: artifact.archive.sha256,
};
assert.equal(packagedCapture.manifestSha256, process.env.OPENCODE_V2_PACKAGED_MANIFEST_SHA256);
const packaged = await readPackagedOpenCodeV2(packagedCapture);
assert.equal(packaged.manifest.sourceHead, sourceHead);
assert.equal(packaged.manifest.platform, 'win32-' + process.arch);
assert.equal(await realpath(broker), join(resourcesRoot, 'windows-retry-custody/owned-process-broker.exe'));
const sources = [...new Set([...desktopProofSources, ...desktopProofWindowsRetrySources])];
const sourceHashes = await captureDesktopSourceHashes(repository, sources);
const profileData = {
  root, home: join(root, 'app-home'), temp: join(root, 'app-temp'), userData: join(root, 'app-user-data'),
};
const baseEnvironment = await preparePackagedProfile(profileData);
await writeFile(join(baseEnvironment.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT, 'agent-teams-config.json'),
  JSON.stringify({ general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark' } }), { flag: 'wx' });
const fixtureRoot = join(root, 'fixture');
await mkdir(fixtureRoot);
const fixture = await prepareNativeWindowsAppFixture({
  root: await realpath(fixtureRoot), broker, fixture: queryFixture, selectionPath, selectionSha256,
  packaged: { nodeExecutable: packaged.node, nodeVersion: 'v' + packaged.manifest.node.version, hostEntry: packaged.entry },
});
const selection = hostTeamSelectionKey(fixture.handleId);
const appEnvironment = Object.freeze({ ...baseEnvironment,
  AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH: fixture.descriptorPath,
  AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256: fixture.descriptorSha256,
});
const logPath = receiptPath.replace(/\.json$/i, '') + '.app.log';
const proof = {
  kind: 'TEST_WINDOWS_PACKAGED_SAME_MAIN_PROCESS_UI', status: 'INCOMPLETE', cleanup: false,
  sourceHead, platform: 'win32-' + process.arch, nodeVersion: process.version,
  root, selection, descriptorSha256: fixture.descriptorSha256,
  packaged: { artifact, capture: packagedCapture, node: packaged.node, hostEntry: packaged.entry,
    nodeSha256: packaged.manifest.node.binarySha256, hostEntrySha256: packaged.manifest.hostEntrySha256 },
  selectedSourceHashes: sourceHashes, originalInputPins: fixture.pins,
  counts: { mainStarts: 0, initialRuntimeOpen: 0, businessInput: 0, refreshClicks: 0, retryClicks: 0, uiStops: 0, quit: 0 },
  phases: [], uiSteps: [], screenshots: [], appLog: logPath,
};
let app, cdp, appLog, main, hostA, hostB, writerA, exit, exitPromise, binding;
let lineage = [], startedAt, outerDeadline, activeDeadline, activePhase = 'prepare';
let acceptingExit = false, completed = false, primaryError;
let quitStarted = false, shutdownResult;
const remaining = () => {
  const left = Math.floor(Math.min(outerDeadline, activeDeadline) - performance.now());
  assert.ok(left > 0, 'Original Windows UI phase expired: ' + activePhase);
  return left;
};
const begin = (name, milliseconds) => {
  activePhase = name;
  activeDeadline = Math.min(outerDeadline, performance.now() + milliseconds);
  proof.phases.push({ phase: name, atMs: performance.now() - startedAt, budgetMs: milliseconds });
  remaining();
};
const within = async action => {
  const left = remaining();
  let timer;
  try {
    const result = await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Original Windows UI phase expired: ' + activePhase)), left);
    })]);
    remaining();
    return result;
  } finally { clearTimeout(timer); }
};
const check = () => {
  remaining();
  if (!acceptingExit) {
    assert.deepEqual(fixture.model.failures, []);
    assert.equal(exit, undefined, 'Original packaged Main must remain alive');
  }
};
const poll = async (read, label) => {
  for (;;) {
    check();
    const value = await within(read);
    if (value !== false && value !== null && value !== undefined) return value;
    await delay(Math.min(100, remaining()));
  }
};
const captureCensus = () => {
  check();
  const snapshot = processes();
  assert.ok(snapshot.length <= 10000, 'Complete original Windows process census');
  const liveMain = main && snapshot.find(row => row.pid === main.pid && row.birth === main.birth);
  if (main && !acceptingExit) sameIdentity(main, liveMain);
  if (liveMain) {
    const retained = retainPackagedLineage(lineage, ownedTree(snapshot, main));
    assert.equal(retained.truncated, false); lineage = retained.records;
  }
  const orphans = packagedOrphanObservation(lineage, snapshot);
  assert.equal(orphans.censusTruncated, false); assert.equal(orphans.candidatesTruncated, false);
  assert.deepEqual(orphans.candidates, [], 'No unexplained child of any original retained ancestor');
  remaining();
  return snapshot;
};
const assertOwnedRenderer = () => {
  const snapshot = captureCensus(), ids = listeners();
  assert.ok(ids.length > 0 && ids.every(pid => snapshot.some(current =>
    current.pid === pid && lineage.some(original => original.pid === pid && original.birth === current.birth))),
  'CDP listener belongs to this original Main family');
  remaining();
};
const readJson = async path => {
  const response = await fetch('http://127.0.0.1:9222' + path,
    { signal: AbortSignal.timeout(Math.min(3000, remaining())), redirect: 'error' });
  assert.equal(response.status, 200);
  return response.json();
};
const port = {
  async send(method, params = {}) {
    check();
    const result = await within(() => cdp.send(method, params));
    check(); return result;
  },
  async evaluate(expression) {
    const guarded = proof.rendererUrl === undefined ? expression : '(async()=>{const expected=' +
      desktopJsLiteral(proof.rendererUrl) + ',preload=window.electronAPI,backend=preload?.agentBackend;' +
      'const current=()=>{if(String(location.href).split(/[?#]/u)[0]!==expected||window.electronAPI!==preload||preload?.agentBackend!==backend)' +
      'throw new Error("Original packaged renderer changed");};current();const value=await (' + expression + ');current();return value;})()';
    const response = await port.send('Runtime.evaluate',
      { expression: guarded, returnByValue: true, awaitPromise: true });
    assert.equal(response.exceptionDetails, undefined, 'Original renderer evaluation: ' +
      String(response.exceptionDetails?.exception?.description ?? response.exceptionDetails?.text ?? ''));
    return response.result.value;
  },
};
const originalBinding = async () => {
  assertOwnedRenderer();
  const snapshot = object(await port.evaluate('(async()=>await window.electronAPI.agentBackend.getConnections())()'));
  assert.equal(snapshot.state, 'ready'); assert.ok(Array.isArray(snapshot.bindings) && snapshot.bindings.length === 1);
  const value = object(snapshot.bindings[0]);
  assert.deepEqual(value.handle, { handleId: fixture.handleId });
  assert.equal(value.label, fixture.prepared.profile.teams[0].binding.teamName);
  assert.deepEqual(value.members, [{ memberId: 'alice-id', label: 'alice' }]);
  if (binding) assert.deepEqual(value, binding, 'Same whole original public binding after recovery');
  return value;
};
const invoke = async (operation, commandId, payload) => {
  assertOwnedRenderer();
  const request = { operation, commandId, handle: { handleId: fixture.handleId }, payload };
  const result = object(await port.evaluate('(async()=>await window.electronAPI.agentBackend.invoke(' +
    desktopJsLiteral(request) + '))()'));
  assert.equal(result.ok, true, 'Original public ' + operation + ': ' + JSON.stringify(result));
  return object(result.value);
};
const readRuntime = () => invoke('runtime.read', 'TEST-windows-original-runtime-read', { memberId: 'alice-id' });
const readWriter = () => {
  try { return fixture.writer(); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
};
const assertHost = (writer, snapshot) => {
  const selected = snapshot.filter(row => row.pid === writer.pid);
  assert.equal(selected.length, 1);
  const host = selected[0];
  assert.equal(host.parent, main.pid, 'Original Main is the real Host parent');
  assert.equal(String(host.executable).toLowerCase(), packaged.node.toLowerCase());
  sameIdentity(main, snapshot.find(row => row.pid === main.pid));
  assert.ok(lineage.some(row => row.pid === host.pid && row.birth === host.birth));
  return host;
};
const screenshot = async name => {
  assertOwnedRenderer();
  const data = await port.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const bytes = Buffer.from(data.data, 'base64');
  assert.ok(bytes.length > 0 && bytes.length <= 16 * 1024 * 1024);
  const path = receiptPath.replace(/\.json$/i, '') + '.' + name + '.png';
  await within(() => writeFile(path, bytes, { flag: 'wx' }));
  proof.screenshots.push({ phase: activePhase, path, bytes: bytes.length, sha256: sha(bytes) });
};
const processOwner = (row, stopped = false) =>
  desktopProcessOwnerExpression(selection, row.id, stopped ? null : row.processRef);
const readProcesses = async () => {
  const value = await readDesktopProcessData(port, selection,
    { rendererUrl: proof.rendererUrl, bindingJson: JSON.stringify(binding) });
  fixture.assertRows(value.processes);
  return value;
};
const killTarget = row => '(() => { const matches=[...document.querySelectorAll(' +
  desktopJsLiteral('[data-section-id="processes"] span.font-medium') + ')].filter(node=>node.textContent?.trim()===' +
  desktopJsLiteral(row.label) + '); if(matches.length!==1)return {unavailableTarget:true,matches:matches.length};' +
  'const parent=matches[0].parentElement;if(!parent)return {unavailableTarget:true,matches:0};' +
  'const pid=parent.querySelector("span.font-mono"), buttons=[...parent.querySelectorAll("button")].filter(b=>b.textContent.trim()==="Kill");' +
  'if(buttons.length!==1)return {unavailableTarget:true,matches:buttons.length};const button=buttons[0];' +
  'if(pid?.textContent?.trim()!==' + desktopJsLiteral('PID' + row.pid) +
  '||!button||button.textContent?.trim()!=="Kill"||button.disabled)return {unavailableTarget:true,matches:1};' +
  'const rect=button.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2,hit=document.elementFromPoint(x,y);' +
  'if(rect.width<=0||rect.height<=0||!hit||!(hit===button||button.contains(hit)))return {unavailableTarget:true,matches:1};' +
  'return {x,y,tag:button.tagName,text:button.textContent.trim()}; })()';
const quit = async () => {
  if (quitStarted) return shutdownResult;
  quitStarted = true;
  acceptingExit = true;
  begin('original-product-Quit', 30000);
  proof.counts.quit++;
  proof.quit = { attempted: true };
  const snapshot = captureCensus();
  if (main && snapshot.some(row => row.pid === main.pid && row.birth === main.birth)) {
    try {
      proof.quit.acknowledgement = await within(() => closePackagedBrowser({
        assertOwnership: async () => {
          const current = captureCensus();
          sameIdentity(main, current.find(row => row.pid === main.pid));
          const ids = listeners();
          assert.ok(ids.length > 0 && ids.every(pid => lineage.some(row => row.pid === pid &&
            current.some(value => value.pid === pid && value.birth === row.birth))));
        },
        readVersion: () => readJson('/json/version'), connect: endpoint => new WebSocket(endpoint),
        timeoutMs: Math.min(3000, remaining()), receipt: proof.quit,
      }));
    } catch (error) { proof.quit.acknowledgementFailure = errorText(error); }
  }
  if (exitPromise) proof.appExit = await within(() => exitPromise);
  assert.deepEqual(proof.appExit, { code: 0, signal: null }, 'Actual product Main exits successfully');
  const final = await poll(async () => {
    const current = captureCensus(), ids = listeners();
    const state = packagedDrainSnapshot(lineage, current, ids);
    if (!state.drained) return false;
    return { ...state, census: current, lineage };
  }, 'original complete App family and listener release');
  proof.finalCensus = final;
  const command = object(proof.quit.command);
  assert.deepEqual(Object.keys(command).sort(), ['at', 'id', 'method']);
  assert.equal(command.id, 1); assert.equal(command.method, 'Browser.close');
  assert.ok(Number.isSafeInteger(command.at) && command.at > 0, 'Original product Quit was actually sent');
  shutdownResult = final;
  return final;
};

try {
  await assertPortAvailable();
  startedAt = performance.now(); outerDeadline = startedAt + 300000;
  begin('packaged-App-startup', 120000);
  appLog = createWriteStream(logPath, { flags: 'wx' });
  appLog.on('error', error => { proof.appLogFailure = errorText(error); });
  app = spawn(artifact.app.path, ['--remote-debugging-port=9222'], {
    cwd: root, env: appEnvironment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  });
  proof.counts.mainStarts++;
  app.stdout.pipe(appLog, { end: false }); app.stderr.pipe(appLog, { end: false });
  exitPromise = new Promise(resolve => {
    app.once('error', error => { exit = { spawnError: errorText(error) }; resolve(exit); });
    app.once('close', (code, signal) => { exit = { code, signal }; resolve(exit); });
  });
  assert.ok(Number.isInteger(app.pid) && app.pid > 1);
  main = await poll(async () => processes().find(row => row.pid === app.pid) ?? false, 'original actual Main birth');
  assert.equal(String(main.executable).toLowerCase(), artifact.app.path.toLowerCase());
  proof.originalMain = main;
  await poll(async () => {
    const current = captureCensus(), ids = listeners();
    if (!ids.length) return false;
    assert.ok(ids.every(pid => lineage.some(row => row.pid === pid &&
      current.some(value => value.pid === pid && value.birth === row.birth))));
    return true;
  }, 'original Main CDP ownership');
  const target = await poll(async () => {
    assertOwnedRenderer();
    const targets = await readJson('/json/list');
    if (!Array.isArray(targets) || !targets.some(row => row.type === 'page' && String(row.url).startsWith('file:'))) return false;
    return packagedTarget(targets, artifact.renderer, true);
  }, 'actual packaged renderer target');
  cdp = await within(() => Cdp.connect(target.webSocketDebuggerUrl));
  await port.send('Runtime.enable'); await port.send('Page.enable');
  proof.rendererUrl = String(target.url).split(/[?#]/u)[0];
  assert.equal(await port.evaluate('String(location.href).split(/[?#]/u)[0]'), proof.rendererUrl);
  await poll(() => port.evaluate('Boolean(window.electronAPI?.agentBackend?.getConnections && window.electronAPI?.agentBackend?.invoke)'), 'original public preload');
  binding = structuredClone(await originalBinding()); proof.originalPublicBinding = binding;
  writerA = await poll(async () => readWriter(), 'original Host writer publication');
  hostA = assertHost(writerA, captureCensus());
  proof.originalHost = { identity: hostA, writer: writerA };

  begin('one-initial-Runtime-Open', 45000);
  proof.counts.initialRuntimeOpen++;
  const opened = await invoke('runtime.open', 'TEST-windows-one-original-open', { memberId: 'alice-id' });
  assert.equal(opened.nativeReady, true); assert.equal(opened.attached, true);
  proof.originalOpen = opened;
  begin('one-original-business-input-and-UI', 35000);
  proof.counts.businessInput++;
  const sent = await invoke('message.send', fixture.bootstrap.commandId, fixture.bootstrap.payload);
  assert.equal(sent.phase, 'completed'); assert.equal(sent.operation, 'message.send');
  assert.ok(typeof sent.deliveryId === 'string' && sent.deliveryId.length > 0);
  proof.originalMessage = sent;
  const terminal = await poll(async () => {
    const state = await readRuntime();
    assert.ok(Array.isArray(state.inputs) && state.inputs.length === 1);
    const input = state.inputs[0];
    assert.equal(input.inputId, sent.deliveryId);
    if (input.phase !== 'terminal') return false;
    assert.equal(input.terminal, 'succeeded'); return state;
  }, 'original bootstrap terminal result');
  proof.originalRuntime = terminal;
  const original = await within(() => fixture.captureOriginal(activeDeadline));
  proof.originalProcesses = original;
  const providerPid = original.registrations[0].capture.root.pid;
  assert.ok(lineage.some(row => row.pid === providerPid &&
    captureCensus().some(current => current.pid === row.pid && current.birth === row.birth)));
  const ui = createDesktopUiControls(port, {
    assertOwnedRenderer,
    step: value => { assert.ok(proof.uiSteps.length < 128); proof.uiSteps.push({ phase: activePhase, ...value }); },
  });
  await ui.observeInput();
  await ui.waitRead('Boolean(document.querySelector("#sidebar-tasks-panel"))', 'original sidebar', remaining());
  await ui.clickSidebar(fixture.uiSeed.subject);
  await ui.waitRead('Boolean(document.querySelector(\'[data-section-id="processes"]\'))', 'original Processes rows', remaining());
  if (await port.evaluate('Boolean(document.querySelector(\'[data-section-id="processes"] button[aria-label="Expand section"]\'))'))
    await ui.click('[data-section-id="processes"] button[aria-label="Expand section"]', 'expand original Processes section');
  for (const row of original.rows) {
    const owner = object(await ui.waitRead(processOwner(row), 'original exact process props', remaining()));
    assert.equal(owner.teamName, selection); assert.deepEqual(owner.process,
      { ...row, observation: 'same-live', canTerminate: true });
  }
  proof.beforeCrashPublic = await readProcesses();
  await screenshot('before-crash');

  begin('actual-Host-A-exit-and-metadata-Refresh', 10000);
  fixture.crashOriginal();
  proof.hostExitCensus = await poll(async () => {
    const current = captureCensus();
    if (current.some(row => row.pid === hostA.pid && row.birth === hostA.birth)) return false;
    return current;
  }, 'positive original Host A birth absence');
  await within(() => fixture.afterOriginalExit(activeDeadline));
  const surface = '[data-testid="host-backend-recovery"]';
  await ui.waitRead('Boolean(document.querySelector(' + desktopJsLiteral(surface) + '))', 'retained Team recovery surface', remaining());
  proof.counts.refreshClicks++;
  await ui.click(surface + ' button', 'explicit original metadata Refresh', 'Refresh');
  proof.readError = await ui.waitRead('(() => { const surface=document.querySelector(' + desktopJsLiteral(surface) + ');' +
    'if(!surface)return null; const errors=[...surface.querySelectorAll(\'[role="alert"] p\')].map(node=>node.textContent?.trim())' +
    '.filter(text=>text==="Host team read unavailable"||text==="Host teams unavailable");' +
    'const buttons=[...surface.querySelectorAll("button")]; if(errors.length!==1||!buttons.some(b=>b.textContent.trim()==="Refresh"&&!b.disabled)' +
    '||!buttons.some(b=>b.textContent.trim()==="Retry"&&!b.disabled))return null;return errors[0];})()',
  'genuine closed Host read marker with separate controls', remaining());
  for (const row of original.rows)
    assert.equal(object(await ui.waitRead(processOwner(row), 'original rows retained during outage', remaining())).process.processRef, row.processRef);

  begin('one-explicit-same-Main-Retry', 10000);
  proof.counts.retryClicks++;
  await ui.click(surface + ' button', 'explicit product Retry once', 'Retry');
  const successorWriter = await poll(async () => {
    const writer = readWriter();
    if (!writer || writer.pid === writerA.pid) return false;
    assert.notEqual(writer.token, writerA.token); return writer;
  }, 'actual successor writer acquisition');
  hostB = assertHost(successorWriter, captureCensus());
  assert.notEqual(hostB.pid, hostA.pid);
  proof.successorHost = { identity: hostB, writer: successorWriter };
  await ui.waitRead('(() => {const s=document.querySelector(' + desktopJsLiteral(surface) + ');if(!s)return false;' +
    'const b=[...s.querySelectorAll("button")];return b.some(x=>x.textContent.trim()==="Refresh"&&!x.disabled)' +
    '&&!b.some(x=>x.textContent.trim()==="Retry")&&!s.querySelector(\'[role="alert"]\');})()',
  'original refreshed Team after positive product recovery', remaining());
  await originalBinding();
  await within(() => fixture.afterRetry(activeDeadline));
  proof.afterRetryPublic = await readProcesses();
  for (const row of original.rows) {
    const owner = object(await ui.waitRead(processOwner(row), 'same original process refs after Retry', remaining()));
    assert.deepEqual(owner.process, { ...row, observation: 'same-live', canTerminate: true });
  }
  proof.sameMainAfterRetry = captureCensus().find(row => row.pid === main.pid);
  sameIdentity(main, proof.sameMainAfterRetry);
  await screenshot('after-retry');

  proof.stops = [];
  for (const [index, role] of ['primary', 'neighbor'].entries()) {
    begin('original-UI-Kill-' + role, 10000);
    const row = original.rows[index];
    await ui.scrollTo('[data-section-id="processes"] span.font-medium', 'original visible target ' + role, row.label);
    fixture.beginStop(role, activeDeadline);
    proof.counts.uiStops++;
    await ui.clickExpression(killTarget(row), 'original UI Kill ' + role);
    const receipt = await within(() => fixture.completeStop(role));
    const stopped = object(await ui.waitRead(processOwner(row, true), 'original stopped row ' + role, remaining()));
    assert.equal(stopped.teamName, selection); assert.deepEqual(stopped.process, receipt.result);
    proof.stops.push({ role, receipt, renderer: stopped });
    await readProcesses();
    sameIdentity(main, captureCensus().find(value => value.pid === main.pid));
    await screenshot('after-' + role);
  }
  await quit();
  proof.nativeCleanup = await within(() => fixture.afterQuit(activeDeadline));
  proof.cleanup = true;
  completed = true;
} catch (error) {
  primaryError = error;
  proof.error = errorText(error);
} finally {
  if (app && !quitStarted) {
    try {
      if (!main && app.pid) {
        const snapshot = processes(), current = snapshot.find(row => row.pid === app.pid);
        if (current) {
          main = current; lineage = retainPackagedLineage([], ownedTree(snapshot, current)).records;
        }
      }
      await quit();
      proof.cleanup = true;
    } catch (error) { proof.cleanupFailure = errorText(error); }
  }
  cdp?.close();
  try { await fixture.close(); } catch (error) { proof.fixtureCloseFailure = errorText(error); }
  if (appLog) await new Promise(resolve => appLog.end(resolve));
  proof.modelRequests = fixture.model.observations.length;
  proof.modelProbes = fixture.model.probes.length;
  proof.modelFailures = fixture.model.failures;
  proof.modelNotifications = fixture.model.notificationAcks;
  proof.originalRuntimeGenerations = completed ? 1 : null;
  proof.actualHostSuccessors = hostB ? 1 : 0;
  proof.lineage = lineage;
  try {
    fixture.assertPins();
    assert.deepEqual(await packagedArtifact(executable), artifact);
    assert.deepEqual(await readPackagedOpenCodeV2(packagedCapture), packaged);
    proof.packagedAndNativeInputsUnchanged = true;
  } catch (error) { proof.inputFreezeFailure = errorText(error); }
  await verifyDesktopSourceFreeze(repository, sources, sourceHashes, proof);
  if (completed && !primaryError && proof.cleanup && proof.packagedAndNativeInputsUnchanged &&
    !proof.sourceFreezeFailure && !proof.appLogFailure && !proof.fixtureCloseFailure &&
    proof.modelRequests === 4 && proof.modelProbes === 0 && proof.modelFailures.length === 0 &&
    proof.modelNotifications.length === 2) proof.status = 'PASS';
  proof.elapsedMs = startedAt === undefined ? null : performance.now() - startedAt;
  await writeFile(receiptPath, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
}
assert.equal(proof.status, 'PASS', 'Original packaged Windows same-Main UI proof remains INCOMPLETE: ' + receiptPath);
process.stdout.write(JSON.stringify({ kind: proof.kind, status: proof.status, receiptPath, cleanup: proof.cleanup,
  sourceHead, platform: proof.platform, counts: proof.counts, modelRequests: proof.modelRequests,
  modelProbes: proof.modelProbes, actualHostSuccessors: proof.actualHostSuccessors }) + '\n');
