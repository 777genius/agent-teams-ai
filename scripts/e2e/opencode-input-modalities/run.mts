#!/usr/bin/env node
/** Actual Electron + source runtime + native OpenCode, with a scripted loopback model.
 * No assertion here represents semantic image/video understanding or paid inference.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bounded, delay, rows } from '../../fixtures/native-teammate-attachments/harnessProof.ts';
import {
  terminateOwnedApp,
  type HarnessCdp,
} from '../../fixtures/native-teammate-attachments/harnessSupport.ts';
// @ts-expect-error Shared existing CDP client has no declaration file.
import { CdpClient } from '../comment-notification/cdp.mjs';
import { browserCall, type Locator } from './cdpArguments.ts';
import { nativeTitleSource, startModel, type ModelObservation } from './model.ts';
import {
  decodeQueueIndex,
  queueScopeKey,
  type QueueItem,
  type QueueScope,
} from '../../../src/features/manual-message-queue/core/domain/queue.ts';
import type {
  AttachmentPayload,
  SendMessageResult,
  TeamCreateResponse,
  TeamProvisioningProgress,
  MemberSpawnStatusesSnapshot,
} from '../../../src/shared/types/team.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const value = (flag: string): string => {
  const index = process.argv.indexOf(flag);
  assert(index > 0 && process.argv[index + 1], `${flag} is required`);
  return process.argv[index + 1];
};
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(value('--run-root'));
assert(path.basename(root).startsWith('TEST-'), 'Use a new owned TEST- directory');
const runtimeSource = await realpath(value('--runtime-source'));
const native = await realpath(value('--native'));
const nativeSha = value('--native-sha256');
assert.match(nativeSha, /^[a-f0-9]{64}$/);
assert.equal(digest(await readFile(native)), nativeSha);
const port = Number(value('--cdp-port'));
assert(Number.isSafeInteger(port) && port > 1024 && port < 65536);
const project = path.join(root, 'project');
const delayedProject = path.join(root, 'project-delayed');
const home = path.join(root, 'home');
const evidence = path.join(root, 'evidence');
const tmp = path.join(root, 'tmp');
await mkdir(root, { recursive: false }); // Never reuse a previous run or user state.
for (const dir of [project, delayedProject, home, evidence, tmp]) await mkdir(dir);
const suffix = randomUUID().slice(0, 8);
const specs = [
  { name: 'image', input: ['text', 'image'] },
  { name: 'video', input: ['text', 'video'] },
  { name: 'both', input: ['text', 'image', 'video'] },
  { name: 'none', input: ['text'] },
  { name: 'unknown', input: null },
].map((row) => ({
  ...row,
  id: `novel-${suffix}-${row.name}`,
  model: `openrouter/novel-${suffix}-${row.name}`,
}));
const team = `test-modalities-${suffix}`;
const model = await startModel();
const caseFailures: Array<{ case: string; error: string }> = [];
const receipt: Record<string, unknown> = {
  schemaVersion: 1,
  passed: false,
  caseFailures,
  team,
  project,
  fixture: 'scripted loopback catalog and OpenAI-compatible responder; no semantic media claim',
  native: { path: native, sha256: nativeSha },
  runtimeSource,
  nativeTitleClassification: nativeTitleSource,
};
let child: ChildProcess | undefined;
let cdp: HarnessCdp | undefined;
const logs: string[] = [];
let teamAttempted = false;
const save = () => writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
function assertSingleOriginalDelivery(
  fromIndex: number,
  messageId: string,
  targetModel: string,
  expectedFiles: ModelObservation['files']
): { delivery: ModelObservation; auxiliaryTitles: ModelObservation[] } {
  const related = model.observations
    .slice(fromIndex)
    .filter((row) => row.messageIds.includes(messageId));
  const deliveries = related.filter((row) => row.purpose !== 'native-title');
  assert.equal(
    deliveries.length,
    1,
    'Exactly one non-title delivery may carry the original message ID'
  );
  const delivery = deliveries[0];
  assert.equal(delivery.model, targetModel, 'Original delivery must use the actual target model');
  assert.deepEqual(
    delivery.files,
    expectedFiles,
    'Native original delivery must contain exactly the intended files'
  );
  assert(delivery.nativeSessionId, 'Native original session header is required');
  const auxiliaryTitles = related.filter((row) => row.purpose === 'native-title');
  for (const title of auxiliaryTitles) {
    assert.equal(
      title.model,
      specs[2].id,
      'Only the configured small model may generate auxiliary titles'
    );
    assert.equal(
      title.nativeSessionId,
      delivery.nativeSessionId,
      'Title must belong to the same native session'
    );
    assert.deepEqual(title.files, [], 'Source-proven auxiliary titles must remain text-only');
  }
  return { delivery, auxiliaryTitles };
}
async function api<T>(
  path: string[],
  args: unknown[] = [],
  timeoutMs?: number,
  source = 'api'
): Promise<T> {
  assert(cdp);
  const key = `TEST_pending_${randomUUID().replaceAll('-', '')}`;
  await browserCall(cdp, 'api-start', [key, source, path, args]);
  const result = await bounded<{ result?: T; error?: string }>(
    'actual IPC completion',
    () => browserCall(cdp!, 'pending-read', [key]),
    timeoutMs
  );
  await browserCall(cdp, 'pending-delete', [key]);
  assert(!result.error, result.error);
  return result.result as T;
}
async function waitExists(locator: Locator, label: string, timeoutMs = 30000): Promise<void> {
  await bounded(label, () => browserCall<boolean>(cdp!, 'exists', [locator]), timeoutMs);
}
async function click(locator: Locator): Promise<void> {
  let previousRect: string | undefined;
  const point = await bounded<{ x: number; y: number }>(
    `actionable click target ${JSON.stringify(locator)}`,
    async () => {
      const rect = await browserCall<{
        x: number;
        y: number;
        width: number;
        height: number;
      } | null>(cdp!, 'point', [locator]);
      receipt.lastClickTarget = { locator, rect };
      if (!rect) {
        previousRect = undefined;
        return null;
      }
      await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
      const probe = await browserCall<{ ready: boolean; opacity: string; hit: string | null }>(
        cdp!,
        'hit',
        [locator, rect]
      );
      receipt.lastClickTarget = { locator, rect, probe };
      const key = JSON.stringify(rect);
      const stable = previousRect === key;
      previousRect = key;
      return probe.ready && stable ? { x: rect.x, y: rect.y } : null;
    },
    10000
  );
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp!.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
async function captureUi(label: string): Promise<Record<string, unknown>> {
  if (!cdp) return { unavailable: 'Owned Electron CDP was not attached' };
  const captures = await Promise.allSettled([
    cdp.screenshot(path.join(evidence, `${label}.png`)),
    cdp
      .evaluate(
        `(() => { const s=window.__agentTeamsDevStore?.getState(); return {url:location.href,timeOrigin:performance.timeOrigin,body:document.body.innerText,dom:document.documentElement.outerHTML,activeTab:s?.getActiveTab(),paneLayout:s?.paneLayout,selectedTeamName:s?.selectedTeamName,loadedTeamName:s?.selectedTeamData?.teamName,selectedTeamLoading:s?.selectedTeamLoading,selectedTeamError:s?.selectedTeamError}; })()`
      )
      .then((snapshot) =>
        writeFile(path.join(evidence, `${label}-ui.json`), JSON.stringify(snapshot, null, 2))
      ),
  ]);
  return Object.fromEntries(
    captures.map((result, index) => [
      index === 0 ? 'screenshot' : 'snapshot',
      result.status === 'fulfilled'
        ? `${label}${index === 0 ? '.png' : '-ui.json'}`
        : String(result.reason),
    ])
  );
}
async function navigateToTeam(): Promise<void> {
  let stableDocument: number | undefined;
  let stableSince = 0;
  await bounded(
    'owned team page survives lazy dependency reload',
    async () => {
      // Vite can reload the document after the first lazy team import optimizes a dependency.
      // Rebind only navigation; provisioning and sends are never replayed.
      const current = await browserCall<{ timeOrigin: number; ready: boolean } | null>(
        cdp!,
        'navigate',
        [team, project, specs.map((spec) => spec.name)]
      );
      if (!current?.ready) {
        stableSince = 0;
        return false;
      }
      if (stableDocument !== current.timeOrigin || !stableSince) {
        stableDocument = current.timeOrigin;
        stableSince = Date.now();
      }
      return Date.now() - stableSince >= 2000;
    },
    90000
  );
  receipt.navigation = await captureUi('team-navigation');
}
async function openRecipient(name: string): Promise<void> {
  const back: Locator = { label: 'Back to chats' };
  if (await browserCall<boolean>(cdp!, 'exists', [back])) await click(back);
  const row: Locator = { prefix: `${name},` };
  await waitExists(row, `personal chat ${name}`);
  await click(row);
  await bounded('locked recipient', () => browserCall<boolean>(cdp!, 'recipient', [name]), 30000);
  await cdp!.evaluate(
    `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`
  );
}
async function stage(file: string): Promise<void> {
  const doc = (await cdp!.send('DOM.getDocument', { depth: 1 })) as { root: { nodeId: number } };
  const input = (await cdp!.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: '.message-composer-flat-toolbar input[type="file"][multiple]',
  })) as { nodeId: number };
  assert(input.nodeId > 0, 'Existing composer input required');
  await cdp!.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
}
async function fill(text: string): Promise<void> {
  await click({ selector: 'textarea[id^="compose-"]' });
  await cdp!.send('Input.insertText', { text });
}
const sendDisabled = `document.querySelector('.message-composer-send-button')?.matches(':disabled')`;
const previewCount = `document.querySelectorAll('button[aria-label^="Remove TEST."]').length`;
async function shortcutQueue(): Promise<void> {
  await click({ selector: 'textarea[id^="compose-"]' });
  for (const type of ['rawKeyDown', 'keyUp'])
    await cdp!.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: process.platform === 'darwin' ? 4 : 2,
    });
}
async function readManualQueue(scope: QueueScope) {
  // Existing keyval-store/keyval schema; version must already exist. Never upgrade or write.
  const raw = await browserCall<unknown>(cdp!, 'queue-read', [queueScopeKey(scope)]);
  return decodeQueueIndex(raw, scope);
}
function queueItemProof(item: QueueItem) {
  return {
    queueItemId: item.queueItemId,
    revision: item.revision,
    state: item.state,
    route: item.route,
    scope: item.scope,
    detail: item.detail,
    textSha256: digest(Buffer.from(item.text)),
    ...(item.attempt
      ? {
          attempt: {
            attemptId: item.attempt.attemptId,
            messageId: item.attempt.messageId,
            request: {
              messageId: item.attempt.request.messageId,
              actionMode: item.attempt.request.actionMode,
              ...('member' in item.attempt.request ? { member: item.attempt.request.member } : {}),
              textSha256: digest(Buffer.from(item.attempt.request.text)),
            },
          },
        }
      : {}),
  };
}
async function stageRendererTarget(model: string, cwd: string): Promise<void> {
  await browserCall(cdp!, 'stage-target', [model, cwd]);
}
try {
  const nativeModels = Object.fromEntries(
    specs.map((row) => [
      row.id,
      {
        name: row.id,
        tool_call: true,
        modalities: { input: row.input ?? ['text'], output: ['text'] },
        limit: { context: 128000, output: 4096 },
      },
    ])
  );
  await writeFile(
    path.join(project, 'opencode.json'),
    JSON.stringify({
      provider: {
        openrouter: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: model.baseURL, apiKey: 'TEST-loopback-only' },
          models: nativeModels,
        },
      },
      enabled_providers: ['openrouter'],
      model: specs[2].model,
      small_model: specs[2].model,
    })
  );
  // Only declaration provenance is scripted; dispatch, native bootstrap, serialization and UI are real.
  const config = path.join(root, 'catalog.json');
  const journal = path.join(evidence, 'catalog.ndjson');
  const release = path.join(root, 'catalog.release');
  await writeFile(
    config,
    JSON.stringify({
      runtimeSource,
      project: await realpath(project),
      delayedProject: await realpath(delayedProject),
      release,
      journal,
      models: specs.map((row) => ({ modelId: row.id, declaredInputModalities: row.input })),
    })
  );
  const wrapper = path.join(repo, 'scripts/e2e/opencode-input-modalities/catalog-cli.mts');
  await chmod(wrapper, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: path.join(home, '.claude'),
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: path.join(root, 'user-data'),
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: wrapper,
    CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: native,
    OPENCODE_BIN_PATH: native,
    OPENCODE_MODALITIES_E2E_CONFIG: config,
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    TMPDIR: tmp,
    npm_config_cache: path.join(root, 'npm-cache'),
    ELECTRON_CACHE: path.join(root, 'electron-cache'),
  };
  // Strict profiles read selected authentication from the native source auth store.
  // This credential is a literal for the owned loopback provider, never a user credential.
  const fixtureAuthPath = path.join(env.XDG_DATA_HOME!, 'opencode', 'auth.json');
  await mkdir(path.dirname(fixtureAuthPath), { recursive: true, mode: 0o700 });
  await writeFile(
    fixtureAuthPath,
    JSON.stringify({ openrouter: { type: 'api', key: 'TEST-loopback-only' } }),
    { mode: 0o600, flag: 'wx' }
  );
  receipt.fixtureAuthentication = {
    providerId: 'openrouter',
    source: fixtureAuthPath,
    kind: 'synthetic-api',
  };
  const nativeCatalog = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const source = spawn(
        runtimeSource,
        [
          'runtime',
          'providers',
          'models',
          '--runtime',
          'opencode',
          '--provider',
          'openrouter',
          '--json',
        ],
        { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '',
        stderr = '';
      source.stdout.on('data', (bytes: Buffer) => {
        stdout += bytes.toString();
      });
      source.stderr.on('data', (bytes: Buffer) => {
        stderr += bytes.toString();
      });
      source.on('error', reject);
      source.on('exit', (code) => resolve({ code, stdout, stderr }));
      const timer = setTimeout(() => source.kill('SIGTERM'), 120000);
      timer.unref();
      source.on('exit', () => clearTimeout(timer));
    }
  );
  await writeFile(
    path.join(evidence, 'native-catalog.json'),
    JSON.stringify(nativeCatalog, null, 2)
  );
  assert.equal(nativeCatalog.code, 0, 'Separate real native catalog read failed');
  const catalogOutput = JSON.parse(nativeCatalog.stdout) as {
    models?: { models: Array<{ modelId: string; declaredInputModalities?: string[] | null }> };
  };
  for (const spec of specs.slice(0, 4)) {
    const nativeRow = catalogOutput.models?.models.find(
      (row) => row.modelId === spec.id || row.modelId === spec.model
    );
    assert.deepEqual(
      nativeRow?.declaredInputModalities,
      spec.input,
      'Native declarations must survive actual runtime output separately from scripted fixture'
    );
  }
  receipt.nativeCatalog =
    'native-catalog.json: actual source runtime/native read; no model inference';
  // App-managed native resolver uses the same existing manifest seam as diagnostics fixtures.
  const manifest = path.join(
    env.AGENT_TEAMS_ELECTRON_USER_DATA_DIR!,
    'data/runtimes/opencode/current.json'
  );
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      version: '2.0.21',
      platformPackage: 'TEST-native',
      binaryPath: native,
      integrity: nativeSha,
      installedAt: new Date().toISOString(),
    })
  );
  child = spawn(
    process.execPath,
    [path.join(repo, 'scripts/dev-with-runtime.mjs'), `--remoteDebuggingPort=${port}`],
    { cwd: repo, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (bytes: Buffer) => {
      logs.push(bytes.toString());
      if (logs.length > 1000) logs.shift();
    });
  cdp = await bounded<HarnessCdp>('owned Electron CDP', async () => {
    assert(child!.exitCode === null, 'Owned app exited');
    const announced = logs
      .join('')
      .match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//);
    if (!announced) return null;
    assert.equal(Number(announced[1]), port, 'Refuse a substituted/foreign CDP endpoint');
    const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) =>
      r.json()
    )) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    for (const target of targets.filter((row) => row.type === 'page')) {
      const candidate = (await CdpClient.connect(target.webSocketDebuggerUrl)) as HarnessCdp;
      if (
        await candidate.evaluate(
          `Boolean(window.electronAPI?.teams && window.__agentTeamsDevStore)`
        )
      )
        return candidate;
      await candidate.close();
    }
    return null;
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.waitFor(
    `(async()=>Boolean((await window.electronAPI.startup.getStatus()).ready))()`,
    'startup',
    120000
  );
  teamAttempted = true;
  // TeamProvisioningBootstrapSpec budgets 110s per effective member (120s min,
  // 900s max) plus 30s outer grace. OpenCode secondary launches are serialized.
  const createTeamTimeoutMs = Math.min(900_000, Math.max(120_000, specs.length * 110_000)) + 30_000;
  receipt.createTeamObservationBudget = { members: specs.length, timeoutMs: createTeamTimeoutMs };
  const launch = await api<TeamCreateResponse>(
    ['teams', 'createTeam'],
    [
      {
        teamName: team,
        cwd: project,
        providerId: 'opencode',
        model: specs[2].model,
        syncModelsWithLead: false,
        prompt: 'TEST only. Reply READY and wait. Do not create tasks or inspect files.',
        members: specs.map((row) => ({
          name: row.name,
          providerId: 'opencode',
          model: row.model,
          role: 'TEST scripted transport observer',
        })),
      },
    ],
    createTeamTimeoutMs
  );
  assert(launch.runId);
  receipt.launch = launch;
  await bounded(
    'actual native bootstrap for every TEST member',
    async () => {
      model.check();
      const progress = await api<TeamProvisioningProgress>(
        ['teams', 'getProvisioningStatus'],
        [launch.runId]
      );
      assert(!['failed', 'cancelled'].includes(progress.state), `Provisioning ${progress.state}`);
      const statuses = await api<MemberSpawnStatusesSnapshot>(
        ['teams', 'getMemberSpawnStatuses'],
        [team]
      );
      receipt.progress = progress;
      receipt.spawnStatuses = statuses;
      return (
        progress.state === 'ready' &&
        statuses.runId === launch.runId &&
        specs.every((row) => {
          const status = statuses.statuses[row.name];
          return (
            status?.launchState === 'confirmed_alive' &&
            status.bootstrapConfirmed &&
            !status.hardFailure &&
            !status.skippedForLaunch
          );
        })
      );
    },
    240000
  );
  await api(['fetchTeams'], [], undefined, 'store');
  await navigateToTeam();
  // Warm the same actual main catalog key before the hook's first single upload.
  // Each recipient still resolves its declaration through the production hook.
  await api(
    ['runtimeProviderManagement', 'loadModels'],
    [
      {
        runtimeId: 'opencode',
        providerId: 'openrouter',
        projectPath: project,
        query: null,
        limit: null,
        cursor: null,
        refresh: false,
      },
    ]
  );
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    'base64'
  );
  // Minimal ISO BMFF ftyp bytes: transport fixture, not a semantic video fixture.
  const video = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
  const media = [
    { mime: 'image/png', file: path.join(root, 'TEST.png'), bytes: png },
    { mime: 'video/mp4', file: path.join(root, 'TEST.mp4'), bytes: video },
  ];
  for (const item of media) await writeFile(item.file, item.bytes);
  const matrix: unknown[] = [];
  receipt.uiMatrix = matrix;
  for (const spec of specs) {
    await openRecipient(spec.name);
    await bounded('actual scoped catalog response', async () =>
      (await readFile(journal, 'utf8').catch(() => '')).includes('"event":"response"')
    );
    await fill(`TEST ${spec.name} draft ${suffix}`);
    // Paste uses the real handler and bypasses file-picker accept only, never main admission.
    for (const item of media) {
      const expected = !!spec.input?.includes(item.mime.startsWith('image/') ? 'image' : 'video');
      const preview: Locator = { label: `Remove ${path.basename(item.file)}` };
      assert.equal(
        await cdp.evaluate<number>(previewCount),
        0,
        'Matrix draft must start without attachments'
      );
      await stage(item.file); // One upload; readiness polling must never repeat this side effect.
      if (expected) {
        await waitExists(preview, 'supported media admitted by real composer', 10000);
        assert.equal(
          await cdp.evaluate<number>(previewCount),
          1,
          'One intended upload creates one preview'
        );
      } else {
        await cdp.waitFor(
          `/unknown (image|video) input|does not declare (image|video) input/i.test(document.body.innerText)`,
          'distinct unsupported/unknown UI explanation'
        );
      }
      const admitted: boolean = await browserCall<boolean>(cdp, 'exists', [preview]);
      matrix.push({ member: spec.name, mime: item.mime, admitted });
      assert.equal(admitted, expected);
      if (admitted) {
        await click(preview);
        await cdp.waitFor(`${previewCount}===0`, 'matrix attachment removed before next upload');
      }
    }
    await cdp.screenshot(path.join(evidence, `${spec.name}.png`));
  }
  receipt.uiMatrix = matrix;
  const sends: unknown[] = [];
  receipt.nativeTransport = sends;
  for (const [index, spec] of [specs[0], specs[1]].entries()) {
    const item = media[index];
    await openRecipient(spec.name);
    assert.equal(
      await cdp.evaluate<number>(previewCount),
      0,
      'Native send draft must start without attachments'
    );
    await stage(item.file);
    await cdp.waitFor(
      `${previewCount}===1 && !${sendDisabled}`,
      'one supported-media preview and enabled Send'
    );
    const teamDir = path.join(home, '.claude', 'teams', team);
    const existingIds = new Set((await rows(teamDir, spec.name)).map((row) => row.messageId));
    const before = model.observations.length;
    await click({ selector: '.message-composer-send-button' });
    // The renderer can re-encode images. Establish expected provider bytes from the
    // independent persisted admission envelope, never from the downstream model request.
    const persisted = await bounded(
      'new persisted native attachment message',
      async () =>
        (await rows(teamDir, spec.name)).find(
          (row) =>
            row.messageId &&
            !existingIds.has(row.messageId) &&
            row.attachments?.some((attachment) => attachment.mimeType === item.mime)
        ) ?? null
    );
    assert(persisted.messageId, 'Persisted original message ID is required');
    assert.equal(
      persisted.attachments?.length,
      1,
      'One intended upload must persist exactly one attachment'
    );
    const prepared = persisted.attachments?.find((attachment) => attachment.mimeType === item.mime);
    assert(
      prepared?.filePath && prepared.sha256,
      'Persisted prepared attachment bytes/digest required'
    );
    const preparedPath = await realpath(prepared.filePath);
    const preparedRelative = path.relative(root, preparedPath);
    assert(
      preparedRelative && !preparedRelative.startsWith('..') && !path.isAbsolute(preparedRelative),
      'Prepared attachment must belong to the TEST run'
    );
    const preparedBytes = await readFile(preparedPath);
    const preparedSha256 = digest(preparedBytes);
    assert.equal(
      preparedSha256,
      prepared.sha256,
      'Stored prepared bytes must match inbox metadata'
    );
    assert.equal(
      preparedBytes.length,
      prepared.size,
      'Stored prepared size must match inbox metadata'
    );
    const indexRaw = await readFile(path.join(path.dirname(preparedPath), '_index.json'), 'utf8');
    const indexRows = JSON.parse(indexRaw) as Array<{
      id: string;
      mimeType: string;
      size?: number;
      sha256?: string;
    }>;
    assert(Array.isArray(indexRows), 'Actual TeamAttachmentStore index is required');
    const indexEntry = indexRows.find((entry) => entry.id === prepared.id);
    assert(indexEntry, 'Prepared attachment absent from immutable store index');
    assert.equal(indexEntry.mimeType, prepared.mimeType);
    assert.equal(indexEntry.sha256, preparedSha256);
    assert.equal(indexEntry.size, preparedBytes.length);
    if (item.mime.startsWith('video/')) {
      assert.deepEqual(
        preparedBytes,
        item.bytes,
        'Video transport must preserve original upload bytes'
      );
    }
    await writeFile(path.join(evidence, `prepared-${spec.name}.bin`), preparedBytes);
    await writeFile(path.join(evidence, `attachment-index-${spec.name}.json`), indexRaw);
    await writeFile(
      path.join(evidence, `persisted-${spec.name}.json`),
      JSON.stringify(persisted, null, 2)
    );
    const observed = await bounded('completed original target model request', async () => {
      model.check();
      return (
        model.observations
          .slice(before)
          .find(
            (row) =>
              row.purpose !== 'native-title' &&
              row.model === spec.id &&
              row.messageIds.includes(persisted.messageId!)
          ) ?? null
      );
    });
    assert.equal(observed.messageIds.length, 1, 'One correlated original message required');
    const messageId = observed.messageIds[0];
    assert.equal(
      messageId,
      persisted.messageId,
      'Native turn must correlate to independently persisted message'
    );
    await delay(800);
    const originalRequests = model.observations
      .slice(before)
      .filter((row) => row.purpose !== 'native-title' && row.messageIds.includes(messageId));
    assert.equal(
      originalRequests.length,
      1,
      'Exactly one completed original request is required before continuing'
    );
    assert.equal(
      originalRequests[0].model,
      spec.id,
      'Completed original request must target the selected model'
    );
    assert(observed.nativeSessionId, 'Completed original request must identify its native session');
    try {
      const deliveryProof = assertSingleOriginalDelivery(before, messageId, spec.id, [
        { mime: prepared.mimeType, sha256: preparedSha256, size: preparedBytes.length },
      ]);
      sends.push({
        member: spec.name,
        originalUpload: { mime: item.mime, size: item.bytes.length, sha256: digest(item.bytes) },
        independentlyPersisted: {
          messageId: persisted.messageId,
          attachment: prepared,
          indexEntry,
          retainedBytes: `prepared-${spec.name}.bin`,
          sha256: preparedSha256,
        },
        ...observed,
        auxiliaryTitles: deliveryProof.auxiliaryTitles,
      });
    } catch (error) {
      if (spec.name !== 'video') throw error;
      const failure = {
        case: 'video-native-mime-and-bytes',
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      };
      caseFailures.push(failure);
      sends.push({
        member: spec.name,
        passed: false,
        failure,
        originalUpload: { mime: item.mime, size: item.bytes.length, sha256: digest(item.bytes) },
        independentlyPersisted: {
          messageId,
          attachment: prepared,
          indexEntry,
          sha256: preparedSha256,
        },
        actualRequests: model.observations
          .slice(before)
          .filter((row) => row.messageIds.includes(messageId)),
      });
      receipt.videoFailureCapture = await captureUi('video-transport-failure');
      await save();
    }
  }
  receipt.nativeTransport = sends;
  for (const spec of [specs[3], specs[4]]) {
    for (const item of media) {
      const messageId = randomUUID();
      const payload: AttachmentPayload = {
        id: randomUUID(),
        filename: path.basename(item.file),
        mimeType: item.mime,
        size: item.bytes.length,
        data: item.bytes.toString('base64'),
      };
      const before = model.observations.length;
      let result: SendMessageResult | undefined;
      let refused: string | undefined;
      try {
        result = await api<SendMessageResult>(
          ['teams', 'sendMessage'],
          [
            team,
            { member: spec.name, messageId, text: 'TEST forbidden media', attachments: [payload] },
          ]
        );
      } catch (error) {
        refused = String(error);
      }
      assert(
        refused || result?.runtimeDelivery?.delivered === false,
        'Main must refuse unsupported/unknown media'
      );
      await delay(200);
      assert(
        !model.observations.slice(before).some((row) => row.messageIds.includes(messageId)),
        'Blocked media reached native model'
      );
      sends.push({ blocked: true, member: spec.name, mime: item.mime, messageId, result, refused });
    }
  }
  receipt.nativeTransport = sends;
  await openRecipient('both');
  for (const item of media) await stage(item.file);
  await cdp.waitFor(`${previewCount}===2 && !${sendDisabled}`, 'both supported previews');
  // Same exact cache key as the hook, deliberately without a renderer requestGroupId.
  // The main subscriber must retain the shared request when the UI cancels its own group.
  await browserCall(cdp, 'api-start', [
    'TEST_mainCatalogRead',
    'api',
    ['runtimeProviderManagement', 'loadModels'],
    [
      {
        runtimeId: 'opencode',
        providerId: 'openrouter',
        projectPath: delayedProject,
        query: null,
        limit: null,
        cursor: null,
        refresh: false,
      },
    ],
  ]);
  await bounded('ungrouped main catalog subscriber is pending', async () =>
    (await readFile(journal, 'utf8')).includes('"event":"pending"')
  );
  // Existing dev store stages TEST renderer state; production APIs/hooks remain intact.
  await stageRendererTarget(specs[2].model, delayedProject);
  await cdp.evaluate(
    `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`
  );
  await cdp.waitFor(
    `${sendDisabled} && ${previewCount}===2`,
    'pending project blocks and preserves media'
  );
  await stageRendererTarget(specs[4].model, project);
  await cdp.waitFor(
    `${sendDisabled} && ${previewCount}===2 && /unknown (image|video) input/i.test(document.body.innerText)`,
    'new unknown target blocks preserved draft'
  );
  assert(
    await cdp.evaluate<boolean>('window.TEST_mainCatalogRead?.done===false'),
    'UI cancellation released the pending main catalog subscriber'
  );
  await writeFile(release, 'release');
  await bounded('late previous-project fixture response', async () => {
    const rows = (await readFile(journal, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; cwd: string });
    return rows.some((row) => row.event === 'response' && row.cwd === delayedProject);
  });
  await cdp.waitFor('window.TEST_mainCatalogRead?.done===true', 'shared main subscriber settles');
  const mainCatalogRead = await cdp.evaluate<{
    done: boolean;
    error?: string;
    result?: {
      models?: { models: Array<{ modelId: string; declaredInputModalities?: string[] | null }> };
      error?: unknown;
    };
  }>('window.TEST_mainCatalogRead');
  assert(
    !mainCatalogRead.error && !mainCatalogRead.result?.error,
    'UI cancellation aborted shared main catalog read'
  );
  const retainedDeclaration = mainCatalogRead.result?.models?.models.find(
    (row) => row.modelId === specs[2].id
  );
  assert.deepEqual(retainedDeclaration?.declaredInputModalities, specs[2].input);
  assert(
    await cdp.evaluate<boolean>(`${sendDisabled} && ${previewCount}===2`),
    'Late previous-target/project declaration enabled media'
  );
  receipt.pendingScope = {
    oldProject: delayedProject,
    currentProject: project,
    oldModel: specs[2].model,
    currentModel: specs[4].model,
    preservedPreviews: 2,
    lateResponseIgnored: true,
    sharedMainSubscriber: mainCatalogRead,
  };
  await cdp.evaluate('delete window.TEST_mainCatalogRead');
  await cdp.screenshot(path.join(evidence, 'late-project-and-target.png'));
  await stageRendererTarget(specs[2].model, project);
  await cdp.waitFor(`!${sendDisabled}`, 'restored declared model');
  const queueSection = `document.querySelector('section[aria-label="Queued messages"]')`;
  const beforeRichQueue = model.observations.length;
  const existingQueuedMessageIds = new Set(
    (await rows(path.join(home, '.claude', 'teams', team), 'both')).map((row) => row.messageId)
  );
  await shortcutQueue();
  await delay(200);
  assert.equal(
    await cdp.evaluate<number>(`${queueSection}?.querySelectorAll('li').length ?? 0`),
    0,
    'Media must remain excluded from text-only queue'
  );
  assert.equal(
    await cdp.evaluate<number>(previewCount),
    2,
    'Queue refusal must preserve attachment draft'
  );
  assert.equal(
    model.observations.length,
    beforeRichQueue,
    'Queue shortcut must not dispatch rich draft'
  );
  for (const item of media) await click({ label: `Remove ${path.basename(item.file)}` });
  await cdp.waitFor(`${previewCount}===0`, 'rich draft attachments removed before text queue');
  await fill(` TEST queued-text-${suffix}`);
  await shortcutQueue();
  await cdp.waitFor(
    `${queueSection}?.querySelectorAll('li').length===1`,
    'persisted plain text queued'
  );
  assert.equal(model.observations.length, beforeRichQueue, 'Enqueue must not dispatch');
  const queueRoot = await api<{ resolvedPath: string }>(['config', 'getClaudeRootInfo']);
  assert.equal(await realpath(queueRoot.resolvedPath), await realpath(path.join(home, '.claude')));
  const queueScope: QueueScope = {
    transport: 'desktop-local-teams-v1',
    root: queueRoot.resolvedPath,
    contextId: 'local',
    host: null,
    teamName: team,
    chat: 'direct:both',
  };
  const queueBefore = await readManualQueue(queueScope);
  assert.equal(queueBefore.items.length, 1, 'Exactly one durable queue item is required');
  const queuedItem = queueBefore.items[0];
  assert(queuedItem.route.kind === 'direct' && queuedItem.route.participant === 'both');
  assert(
    queuedItem.text.includes(`queued-text-${suffix}`) &&
      queuedItem.state === 'queued' &&
      !queuedItem.attempt
  );
  const queueEvidence: Record<string, unknown> = { before: queueItemProof(queuedItem) };
  receipt.queueObservation = queueEvidence;
  // Queued text survives the current target becoming a model with no media inputs.
  await stageRendererTarget(specs[3].model, project);
  const manualSend: Locator = {
    selector: 'section[aria-label="Queued messages"] button[aria-label="Send"]',
  };
  await cdp.waitFor(
    `Boolean(document.querySelector('section[aria-label="Queued messages"] button[aria-label="Send"]:not(:disabled)'))`,
    'manual queued text Send remains enabled'
  );
  await browserCall(cdp, 'queue-observe', [manualSend]);
  let claimedMessageId: string | undefined;
  try {
    // R13 proved the pointer hit target changed before mouseup. Focus first,
    // settle the focus-dependent footer, then activate this real button once by keyboard.
    assert(await browserCall(cdp, 'focus', [manualSend]));
    await cdp.evaluate(
      `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`
    );
    assert(await browserCall(cdp, 'focused', [manualSend]));
    for (const type of ['keyDown', 'keyUp'])
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        modifiers: 0,
        ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}),
      });
    const activation = await cdp.evaluate<
      Array<{ type: string; targetsQueueSend: boolean; isTrusted: boolean }>
    >('window.TEST_queueActivation.events');
    queueEvidence.activation = activation;
    assert.equal(
      activation.filter(
        (event) => event.type === 'click' && event.targetsQueueSend && event.isTrusted
      ).length,
      1,
      'Exactly one trusted Queue Send click must reach the captured button'
    );
    await bounded(
      'durable queue claim or persisted original message',
      async () => {
        const index = await readManualQueue(queueScope);
        queueEvidence.after = index.items.map(queueItemProof);
        const item = index.items.find(
          (candidate) => candidate.queueItemId === queuedItem.queueItemId
        );
        const persisted = (await rows(path.join(home, '.claude', 'teams', team), 'both')).find(
          (row) =>
            row.messageId &&
            !existingQueuedMessageIds.has(row.messageId) &&
            row.text.includes(`queued-text-${suffix}`)
        );
        if (persisted) return true;
        if (!item?.attempt) return false;
        queueEvidence.claim = queueItemProof(item);
        claimedMessageId = item.attempt.messageId;
        assert.equal(item.attempt.messageId, item.attempt.attemptId);
        assert(
          'member' in item.attempt.request && item.attempt.request.member === 'both',
          'Durable queue claim must preserve the original recipient'
        );
        return item;
      },
      10000
    );
  } finally {
    queueEvidence.activation = await cdp
      .evaluate('window.TEST_queueActivation?.events')
      .catch((error) => String(error));
    queueEvidence.after = await readManualQueue(queueScope).then(
      (index) => index.items.map(queueItemProof),
      (error) => String(error)
    );
    await cdp
      .evaluate('window.TEST_queueActivation?.stop();delete window.TEST_queueActivation')
      .catch(() => undefined);
    await writeFile(
      path.join(evidence, 'queue-activation.json'),
      JSON.stringify(queueEvidence, null, 2)
    );
    await save();
  }
  const queuedMessage = await bounded(
    'persisted manual queued text message',
    async () =>
      (await rows(path.join(home, '.claude', 'teams', team), 'both')).find(
        (row) =>
          row.messageId &&
          !existingQueuedMessageIds.has(row.messageId) &&
          row.text.includes(`queued-text-${suffix}`)
      ) ?? null
  );
  assert(queuedMessage.messageId);
  assert.equal(queuedMessage.to, 'both', 'Queued message must persist for the captured recipient');
  if (claimedMessageId) assert.equal(queuedMessage.messageId, claimedMessageId);
  await bounded('manual queued text delivered once', async () => {
    model.check();
    return (
      model.observations
        .slice(beforeRichQueue)
        .find(
          (row) =>
            row.purpose !== 'native-title' && row.messageIds.includes(queuedMessage.messageId!)
        ) ?? null
    );
  });
  await delay(800);
  const queuedProof = assertSingleOriginalDelivery(
    beforeRichQueue,
    queuedMessage.messageId,
    specs[2].id,
    []
  );
  await cdp.waitFor(`!${queueSection}`, 'accepted queue item removed');
  receipt.queue = {
    richDraftBlocked: true,
    preservedPreviews: 2,
    enqueueDispatched: false,
    textAfterModelSwitch: queuedProof.delivery,
    auxiliaryTitles: queuedProof.auxiliaryTitles,
    persistedMessageId: queuedMessage.messageId,
  };
  await cdp.evaluate(
    `(() => { window.__agentTeamsDevStore.setState({selectedTeamData:window.TEST_originalTeamData}); delete window.TEST_originalTeamData; return true; })()`
  );
  receipt.passed = caseFailures.length === 0;
  if (caseFailures.length > 0) process.exitCode = 1;
  await save();
} catch (error) {
  receipt.error = error instanceof Error ? error.stack : String(error);
  receipt.failureCapture = await captureUi('failure');
  if (cdp) receipt.body = await cdp.evaluate('document.body.innerText').catch(() => null);
  await save();
  process.exitCode = 1;
} finally {
  const cleanup: Record<string, unknown> = {};
  if (teamAttempted && cdp) {
    for (const method of ['stop', 'deleteTeam']) {
      try {
        cleanup[method] = await api(['teams', method], [team]);
      } catch (error) {
        cleanup[method] = String(error);
      }
    }
  }
  if (cdp)
    await cdp.close().catch((error) => {
      cleanup.cdp = String(error);
    });
  if (child) cleanup.app = await terminateOwnedApp(child);
  await model.close();
  const appTermination = cleanup.app as { terminated?: boolean } | undefined;
  if (
    appTermination?.terminated !== true ||
    cleanup.cdp ||
    ['stop', 'deleteTeam'].some((method) => typeof cleanup[method] === 'string')
  ) {
    receipt.passed = false;
    process.exitCode = 1;
  }
  receipt.cleanup = cleanup;
  await writeFile(path.join(evidence, 'app.log'), logs.join(''));
  await writeFile(
    path.join(evidence, 'model-observations.json'),
    JSON.stringify(model.observations, null, 2)
  );
  await save();
  console.log(
    JSON.stringify({ root, passed: receipt.passed, receipt: path.join(evidence, 'receipt.json') })
  );
}
