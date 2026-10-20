#!/usr/bin/env node
// Real packaged app -> bundled released status -> inherited UI -> native save ->
// saved-model inference. No team is launched; every provider request is localhost.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  configuredDefault,
  diagnosticModel,
  firstCatalogModel,
  probePrompt,
  startDefaultModelGateway,
} from './default-model-gateway.ts';
import { defaultArtifact, qualifyDefaultArtifact } from './packaged-default-artifact.ts';
import { PackagedDefaultCdp, pause } from './packaged-default-cdp.ts';
import {
  nativeDiagnosticProgress,
  type DiagnosticRequirement,
  type PreflightEvent,
} from './packaged-default-preflight.ts';
import {
  DefaultProcessLedger,
  stopUnregisteredApp,
  type ProcessIdentity,
} from './packaged-default-processes.ts';
// @ts-expect-error Existing shared JavaScript packaged helpers have no declarations.
import * as packaged from '../opencode-diagnostics/packaged.mjs';
// @ts-expect-error Existing shared JavaScript process/profile helpers have no declarations.
import * as platform from '../opencode-diagnostics/platform.mjs';

const {
  fingerprint,
  packagedTarget,
  prepareExistingProject,
  preparePackagedProfile,
  runtimeProvenance,
} = packaged;
const { assertPortAvailable, isolatedEnvironment, listeners, ownedTree, processes } = platform;

interface ProviderStatus {
  providerId: string;
  supported: boolean;
  authenticated: boolean;
  verificationState: string;
  statusCheckOutcome: string;
  effectiveDefaultModel?: string | null;
  defaultModel?: string | null;
  modelCatalogRefreshState?: string;
  backend?: { kind: string };
  modelCatalog?: {
    source: string;
    status: string;
    defaultLaunchModel?: string;
    models: { launchModel: string }[];
  };
}
interface SavedRequest {
  model?: string;
  providerId?: string;
  limitContext?: boolean;
  cwd?: string;
}
interface ConnectionPreference {
  authMode: string;
  compatibleEndpointEnabled: boolean;
  compatibleEndpointBaseUrl: string;
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
assert.equal(args.length, 4, 'Expected --packaged-executable <path> --runtime-archive <path>');
assert.equal(args[0], '--packaged-executable');
assert.equal(args[2], '--runtime-archive');
assert(path.isAbsolute(args[1]!) && path.isAbsolute(args[3]!));
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'anthropic-default-state-')));
const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), 'anthropic-default-e2e-'));
const data = {
  root,
  home: path.join(root, 'home'),
  userData: path.join(root, 'user-data'),
  temp: path.join(root, 'tmp'),
  project: path.join(root, 'test-project'),
  artifact: await defaultArtifact(args[1]!),
};
const evidence: Record<string, unknown> = {
  passed: false,
  boundary:
    'real packaged app and released bundled runtime; config-only save and saved-model inference; no team lifecycle',
  appSourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim(),
  artifact: data.artifact,
  steps: [],
};
const ledger = new DefaultProcessLedger();
const log: string[] = [];
let app: ChildProcess | undefined;
let appIdentity: ProcessIdentity | undefined;
let cdp: PackagedDefaultCdp | undefined;
let gateway: Awaited<ReturnType<typeof startDefaultModelGateway>> | undefined;
let scenarioComplete = false;
const record = (step: string, detail: Record<string, unknown> = {}) =>
  (evidence.steps as unknown[]).push({ step, at: new Date().toISOString(), ...detail });
const redact = (value: unknown) => String(value).replaceAll(gateway?.token ?? '\0', '[REDACTED]');
const dialog = 'document.querySelector("[role=dialog]")';
const leadTrigger = `${dialog}.querySelector('[data-role="lead-row"] button[aria-label^="Anthropic provider,"]')`;
const preflightPath = path.join(data.temp, 'claude-team-preflight-debug.log');

async function preflightEvents(): Promise<PreflightEvent[]> {
  try {
    return (await readFile(preflightPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PreflightEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function scopedPreflightCount() {
  return (await preflightEvents()).filter(
    (e) => e.providerId === 'anthropic' && e.cwd === data.project
  ).length;
}
async function assertEnvironmentOnlyConnection(label: string) {
  assert(cdp);
  const preference =
    await cdp.evaluate<ConnectionPreference>(`window.electronAPI.config.get().then(c => ({
    authMode:c.providerConnections.anthropic.authMode,
    compatibleEndpointEnabled:c.providerConnections.anthropic.compatibleEndpoint.enabled,
    compatibleEndpointBaseUrl:c.providerConnections.anthropic.compatibleEndpoint.baseUrl
  }))`);
  assert.equal(preference.authMode, 'auto', 'Environment inheritance requires untouched Auto auth');
  assert.equal(
    preference.compatibleEndpointEnabled,
    false,
    'This scenario must not enable a stored endpoint'
  );
  assert.equal(
    preference.compatibleEndpointBaseUrl,
    '',
    'This scenario must not save an endpoint URL'
  );
  evidence[label] = preference;
}
async function waitSettled(
  label: string,
  priorCount: number,
  requirement: DiagnosticRequirement,
  requireReadyUi = true
) {
  assert(cdp && gateway);
  const deadline = Date.now() + 90_000;
  let quietSince = 0;
  let previousEventCount = -1;
  while (Date.now() < deadline) {
    const events = (await preflightEvents()).filter(
      (e) => e.providerId === 'anthropic' && e.cwd === data.project
    );
    const progress = nativeDiagnosticProgress(events, priorCount, requirement);
    assert(progress.allSucceeded, 'A real native diagnostic failed');
    if (events.length !== previousEventCount) quietSince = 0;
    previousEventCount = events.length;
    const ready =
      !requireReadyUi ||
      (await cdp.evaluate<boolean>(`(() => {
      const d=${dialog}; return !!d && /All selected providers are ready|Selected providers ready/.test(d.innerText)
        && !/Checking selected providers|Checking provider readiness/.test(d.innerText);
    })()`));
    const children = await ledger.runtimeQuiet(data.artifact.app.path);
    if (ready && progress.ready && gateway.inFlight() === 0 && children.length === 0) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= 1000) {
        record(label, {
          requirement,
          ...progress,
          noNewNativeEvents: events.length === priorCount,
          requireReadyUi,
          quietDurationMs: Date.now() - quietSince,
          activeNativeChildren: children,
          httpInFlight: gateway.inFlight(),
        });
        return;
      }
    } else quietSince = 0;
    await pause(300);
  }
  evidence.unsettledPreflight = await preflightEvents();
  evidence.unsettledChildren = await ledger.runtimeQuiet(data.artifact.app.path);
  throw new Error(`Native revalidation did not settle: ${label}`);
}

try {
  evidence.runtimeDelivery = await qualifyDefaultArtifact(data.artifact, args[3]!, root, repoRoot);
  const delivery = evidence.runtimeDelivery as Awaited<ReturnType<typeof qualifyDefaultArtifact>>;
  let env: NodeJS.ProcessEnv;
  if (process.platform === 'win32') env = (await preparePackagedProfile(data)) as NodeJS.ProcessEnv;
  else {
    // Linux local qualification uses the same allowlisted disposable profile,
    // with every fixture/developer CLI override discarded before app startup.
    env = isolatedEnvironment({
      ...data,
      bin: '',
      node: '',
      orchestrator: '',
      opencode: '',
    }) as NodeJS.ProcessEnv;
    for (const key of Object.keys(env))
      if (
        /^(CLAUDE_CLI_PATH|CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH|CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH|OPENCODE_BIN_PATH|NODE_BINARY)$/.test(
          key
        )
      )
        delete env[key];
    env.PATH = '/usr/bin:/bin';
    for (const key of [
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'TMP',
      'TEMP',
      'TMPDIR',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
      'AGENT_TEAMS_ELECTRON_USER_DATA_DIR',
      'AGENT_TEAMS_ELECTRON_CLAUDE_ROOT',
    ]) {
      assert(env[key]?.startsWith(root + path.sep), `Disposable profile escaped root: ${key}`);
      await mkdir(env[key]!, { recursive: true });
    }
  }
  if (process.platform === 'win32') {
    // The isolated PATH intentionally omits Git. Inference still initializes
    // the Windows shell with tools disabled, so supply verified OS plumbing
    // once to the app launch environment, without substituting any CLI.
    const candidates = [
      ...new Set(
        [process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files'].filter(Boolean)
      ),
    ].map((base) => path.join(base!, 'Git/bin/bash.exe'));
    let gitBash: string | undefined;
    for (const candidate of candidates) {
      if (
        await lstat(candidate)
          .then((info) => info.isFile())
          .catch(() => false)
      ) {
        gitBash = await realpath(candidate);
        break;
      }
    }
    assert(gitBash, 'Installed runner Git Bash is required for real Windows inference');
    env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
    evidence.gitBash = await fingerprint(gitBash);
  }
  const sentinel = (await prepareExistingProject(data)) as string;
  gateway = await startDefaultModelGateway();
  // These are fixture launch inputs. The app's normal provider/settings paths
  // construct all native child environments; no child launcher is substituted.
  Object.assign(env, {
    ANTHROPIC_MODEL: configuredDefault,
    ANTHROPIC_SMALL_FAST_MODEL: diagnosticModel,
    ANTHROPIC_BASE_URL: gateway.baseUrl,
    ANTHROPIC_AUTH_TOKEN: gateway.token,
    CLAUDE_CODE_SIMPLE: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CONFIG_DIR: path.join(data.home, '.claude'),
  });
  await mkdir(env.CLAUDE_CONFIG_DIR!, { recursive: true });
  assert.deepEqual(
    Object.keys(env)
      .filter((key) => key.startsWith('ANTHROPIC_'))
      .sort(),
    ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'],
    "The app must receive exactly the user's four provider environment inputs"
  );
  assert(
    !Object.keys(env).some((key) =>
      /^(CLAUDE_CLI_PATH|CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH|NODE_BINARY|AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE|CLAUDE_CODE_ENTRY_PROVIDER|CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)$/.test(
        key
      )
    )
  );
  evidence.suppliedEnvironment = {
    model: env.ANTHROPIC_MODEL,
    diagnosticModel: env.ANTHROPIC_SMALL_FAST_MODEL,
    connectionMode: 'normal app Auto configuration; no host routing flags supplied',
    endpoint: gateway.baseUrl,
    credentialSource: 'local fixture only; value redacted',
    runtimeOverride: false,
  };
  await assertPortAvailable();
  ledger.start();
  // The public executable and its bundled Bun must both be runnable identities.
  evidence.cliVersion = await ledger.command(
    data.artifact.orchestrator.path,
    ['--version'],
    env,
    data.project,
    10_000
  );
  assert.equal(
    (evidence.cliVersion as { stdout: string }).stdout.trim().split(/\s/)[0],
    delivery.lock.cliVersion
  );
  evidence.bunVersion = await ledger.command(
    delivery.bun.path,
    ['--version'],
    env,
    data.project,
    10_000
  );
  assert.equal(
    (evidence.bunVersion as { stdout: string }).stdout.trim(),
    process.platform === 'win32' ? '1.4.3' : '1.3.11'
  );
  app = spawn(
    data.artifact.app.path,
    [
      '--remote-debugging-port=9222',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${data.userData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  for (const stream of [app.stdout, app.stderr])
    stream?.on('data', (chunk) => {
      if (log.join('').length < 2_097_152) log.push(String(chunk));
    });
  await new Promise<void>((resolve, reject) => {
    app!.once('spawn', () => resolve());
    app!.once('error', reject);
  });
  appIdentity = await ledger.register(app);
  const until = Date.now() + 120_000;
  let target: { webSocketDebuggerUrl: string } | undefined;
  while (Date.now() < until && !target) {
    assert(app.exitCode === null, 'Packaged app exited during startup');
    const owned = ownedTree(processes(), appIdentity) as ProcessIdentity[];
    const ports = listeners() as number[];
    if (ports.length && ports.every((pid) => owned.some((p) => p.pid === pid))) {
      const targets = await fetch('http://127.0.0.1:9222/json/list', {
        signal: AbortSignal.timeout(5000),
      })
        .then((r) => r.json())
        .catch(() => []);
      try {
        target = packagedTarget(targets, data.artifact.renderer, true, path) as typeof target;
      } catch {
        /* wait for exact file renderer */
      }
    }
    if (!target) await pause(300);
  }
  assert(target, 'Ownership-checked packaged renderer not found');
  cdp = await PackagedDefaultCdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.wait(
    'Boolean(window.electronAPI?.startup?.getStatus && document.body)',
    'packaged preload'
  );
  const startup = await cdp.wait<{ ready: boolean; error?: string }>(
    'window.electronAPI.startup.getStatus().then(s => (s.ready || s.error) && s)',
    'native services'
  );
  assert(startup.ready && !startup.error, redact(startup.error));
  const discovery = await cdp.evaluate<{ installed: boolean; launchError?: string }>(
    'window.electronAPI.cliInstaller.getStatus({providerStatusMode:"defer"})'
  );
  evidence.resolvedRuntime = await runtimeProvenance(discovery, data, 'orchestrator');
  assert(discovery.installed && !discovery.launchError);
  // ENV-only is essential here: saving the same endpoint in Settings would
  // mask a broken inherited route. The separate issue-684 test covers Settings.
  await assertEnvironmentOnlyConnection('nativeConnectionBeforeStatus');
  await cdp.evaluate(
    `window.electronAPI.config.addCustomProjectPath(${JSON.stringify(data.project)})`
  );
  const provider = await cdp.evaluate<ProviderStatus>(
    `window.electronAPI.cliInstaller.getProviderStatus('anthropic',{projectPath:${JSON.stringify(data.project)},checkReason:'launch_preflight'})`
  );
  evidence.nativeProviderStatus = provider;
  assert(
    Object.hasOwn(provider, 'effectiveDefaultModel'),
    'RUNTIME_DEFAULT_CONTRACT_MISSING: released bundled status omits effectiveDefaultModel'
  );
  assert.equal(provider.effectiveDefaultModel, configuredDefault);
  assert(provider.supported && provider.authenticated);
  assert.equal(provider.verificationState, 'verified');
  assert.equal(provider.statusCheckOutcome, 'authoritative');
  assert.equal(provider.backend?.kind, 'anthropic-compatible');
  assert.equal(provider.modelCatalog?.status, 'ready');
  assert.equal(provider.modelCatalogRefreshState, 'ready');
  assert.equal(
    provider.modelCatalog?.defaultLaunchModel,
    firstCatalogModel,
    'Catalog recommendation must deliberately differ from configured default'
  );
  assert(provider.modelCatalog.models.some((m) => m.launchModel === configuredDefault));
  record('environment-only-native-status-confirmed-without-frontend-credentials');
  const beforeDialog = await scopedPreflightCount();
  await cdp.click('[aria-label="More actions"]');
  await cdp.clickText('Teams');
  await cdp.clickText('Create Team');
  await cdp.clickText('Custom path', dialog);
  await cdp.fill('[role=dialog] input[aria-label="Custom working directory"]', data.project);
  await cdp.fill('#team-name', 'packaged-default-model-test');
  if (
    !(await cdp.evaluate<boolean>(
      'document.querySelector("#solo-team")?.getAttribute("aria-checked") === "true"'
    ))
  )
    await cdp.click('#solo-team');
  await waitSettled(
    'initial-create-dialog-native-revalidation-settled',
    beforeDialog,
    'fresh-diagnostic'
  );
  const label = `Default - ${configuredDefault}`;
  const selections = [];
  for (const limitContext of [false, true]) {
    const before = await scopedPreflightCount();
    // Context controls live inside the expanded model selector. Each prior
    // iteration collapses it; an initial provider notice may start it open.
    if (!(await cdp.evaluate<boolean>('Boolean(document.querySelector("#lead-limit-context"))')))
      await cdp.clickElement(leadTrigger);
    await cdp.wait(
      'Boolean(document.querySelector("#lead-limit-context"))',
      'expanded lead model controls'
    );
    const contextChanged =
      (await cdp.evaluate<boolean>(
        'document.querySelector("#lead-limit-context")?.getAttribute("aria-checked") === "true"'
      )) !== limitContext;
    if (contextChanged) await cdp.click('#lead-limit-context');
    await cdp.wait(
      `document.querySelector('#lead-limit-context')?.getAttribute('aria-checked') === '${limitContext}'`,
      'context state'
    );
    await cdp.wait(
      `Boolean([...document.querySelectorAll('[data-testid=team-model-selector-model-option]')].find(e => e.textContent.trim() === ${JSON.stringify(label)}))`,
      'exact inherited Default option'
    );
    const option: { text: string; aria: string; pressed: string } = await cdp.evaluate(
      `(() => { const e=[...document.querySelectorAll('[data-testid=team-model-selector-model-option]')].find(e => e.textContent.trim() === ${JSON.stringify(label)}); return {text:e.textContent.trim(),aria:e.getAttribute('aria-label'),pressed:e.getAttribute('aria-pressed')}; })()`
    );
    assert.equal(option.text, label);
    assert.equal(option.pressed, 'true', 'Inherited Default must remain the selected value');
    assert(option.aria.includes(label));
    await cdp.clickElement(leadTrigger);
    await cdp.wait(
      '!document.querySelector("#lead-limit-context")',
      'collapsed lead model controls'
    );
    await cdp.wait(
      `${leadTrigger}?.getAttribute('aria-label')?.includes(${JSON.stringify(label)})`,
      'collapsed inherited accessible name'
    );
    const trigger: { text: string; aria: string } = await cdp.evaluate(
      `(() => { const e=${leadTrigger}; return {text:e.textContent.trim(),aria:e.getAttribute('aria-label')}; })()`
    );
    assert.equal(trigger.text, `${configuredDefault} · Default`);
    assert.equal(trigger.aria, `Anthropic provider, ${label}`);
    await waitSettled(
      `context-${limitContext}-native-${contextChanged ? 'revalidation' : 'drain'}-settled`,
      before,
      contextChanged ? 'fresh-diagnostic' : 'quiet-drain'
    );
    selections.push({ limitContext, contextChanged, option, trigger });
    await cdp.screenshot(path.join(evidenceRoot, `default-context-${limitContext}.png`));
  }
  evidence.selections = selections;
  await cdp.fill('#team-name', 'packaged-default-model-test');
  await waitSettled(
    'before-config-only-toggle-drained',
    await scopedPreflightCount(),
    'quiet-drain'
  );
  if (
    await cdp.evaluate<boolean>(
      'document.querySelector("#launch-team")?.getAttribute("aria-checked") === "true"'
    )
  )
    await cdp.click('#launch-team');
  await cdp.wait(
    'document.querySelector("#launch-team")?.getAttribute("aria-checked") === "false"',
    'config-only save selected'
  );
  // Config-only mode hides the provider readiness section and resets its UI
  // state. Drain native work without requiring that intentionally hidden text.
  await waitSettled(
    'before-config-only-create-drained',
    await scopedPreflightCount(),
    'quiet-drain',
    false
  );
  await cdp.clickText('Create', dialog);
  await cdp.wait(`!${dialog}`, 'native config-only creation');
  const saved = await cdp.wait<SavedRequest>(
    'window.electronAPI.teams.getSavedRequest("packaged-default-model-test")',
    'native saved request'
  );
  const metadataText = await readFile(
    path.join(data.home, '.claude/teams/packaged-default-model-test/team.meta.json'),
    'utf8'
  );
  const metadata = JSON.parse(metadataText) as SavedRequest;
  for (const value of [saved, metadata]) {
    assert.equal(value.model, configuredDefault);
    assert.equal(value.providerId, 'anthropic');
    assert.equal(await realpath(value.cwd!), await realpath(data.project));
    assert.equal(value.limitContext, true);
  }
  evidence.nativeSavedRequest = saved;
  await assertEnvironmentOnlyConnection('nativeConnectionAfterConfigOnlySave');
  await writeFile(path.join(evidenceRoot, 'team.meta.json'), metadataText);
  const requestFloor = gateway.requests.length;
  // Deliberately separate from generic native fast diagnostics: argv uses the
  // exact concrete model recovered from the actual native saved configuration.
  const inference = await ledger.command(
    data.artifact.orchestrator.path,
    [
      '-p',
      probePrompt,
      '--output-format',
      'text',
      '--model',
      metadata.model!,
      '--max-turns',
      '1',
      '--tools',
      '',
      '--no-session-persistence',
    ],
    env,
    metadata.cwd!,
    45_000
  );
  assert.equal(inference.stdout.trim(), 'PONG');
  const selectedRequests = gateway.requests
    .slice(requestFloor)
    .filter((r) => r.path === '/v1/messages');
  assert.equal(
    selectedRequests.length,
    1,
    'Exactly one bounded saved-model Messages request is expected'
  );
  assert(
    selectedRequests.every(
      (r) => r.model === metadata.model && r.authorized && r.allowed && r.completed
    )
  );
  evidence.savedModelInference = {
    ...inference,
    modelFromNativeMetadata: metadata.model,
    requests: selectedRequests,
    scope:
      'native saved model -> exact bundled released executable -> local Messages PONG; fixture launch endpoint credentials supplied directly',
  };
  // The direct command's close event does not settle app-owned native children.
  // Await their natural completion before the final success snapshots.
  await waitSettled(
    'after-saved-model-inference-native-work-drained',
    await scopedPreflightCount(),
    'quiet-drain',
    false
  );
  const finalEvents = await preflightEvents();
  const starts = finalEvents.filter(
    (e) => e.event === 'provider_one_shot_diagnostic_start' && e.cwd === data.project
  );
  const complete = finalEvents.filter(
    (e) => e.event === 'provider_one_shot_diagnostic_complete' && e.cwd === data.project
  );
  assert(starts.length > 0 && starts.length === complete.length && complete.every((e) => e.ok));
  assert(
    starts.every((e) => e.args?.[e.args.indexOf('--model') + 1] === diagnosticModel),
    'Native compatible diagnostic must use the supplied legacy fast model'
  );
  assert(
    gateway.requests.some(
      (r) => r.kind === 'generic-fast-diagnostic' && r.model === diagnosticModel && r.completed
    )
  );
  assert(gateway.requests.every((r) => r.allowed && r.completed));
  assert.equal(gateway.inFlight(), 0);
  assert.deepEqual(
    await ledger.runtimeQuiet(data.artifact.app.path),
    [],
    'No unfinished native runtime child is permitted at success'
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve-existing-project\n');
  record('saved-model-inference-and-native-children-complete', {
    diagnosticCount: complete.length,
  });
  scenarioComplete = true;
} catch (error) {
  evidence.error = redact(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
  if (cdp) {
    evidence.failureUi = await cdp
      .evaluate('document.querySelector("[role=dialog]")?.innerText ?? document.body.innerText')
      .catch(() => 'renderer unavailable');
  }
} finally {
  // Preserve transport evidence even if ownership verification/cleanup fails.
  if (gateway) evidence.requests = gateway.requests;
  if (cdp) {
    await cdp.screenshot(path.join(evidenceRoot, 'final-state.png')).catch(() => undefined);
    cdp.close();
  }
  try {
    try {
      if (app && !appIdentity) await stopUnregisteredApp(app);
    } finally {
      evidence.cleanup = await ledger.stop();
    }
    const events = await preflightEvents();
    await writeFile(
      path.join(evidenceRoot, 'preflight.ndjson'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n'
    );
    const starts = events.filter(
      (e) =>
        e.event === 'provider_one_shot_diagnostic_start' &&
        e.providerId === 'anthropic' &&
        e.cwd === data.project
    );
    const completions = events.filter(
      (e) =>
        e.event === 'provider_one_shot_diagnostic_complete' &&
        e.providerId === 'anthropic' &&
        e.cwd === data.project
    );
    if (scenarioComplete) {
      assert.equal(
        starts.length,
        completions.length,
        'Shutdown interrupted a new native revalidation'
      );
      assert(
        completions.every((e) => e.ok === true),
        'Shutdown must not convert an interrupted diagnostic into a counted success'
      );
    }
    if (gateway) {
      evidence.requests = gateway.requests;
      if (scenarioComplete) assert(gateway.requests.every((r) => r.allowed && r.completed));
      await gateway.close();
    }
    await rm(root, { recursive: true, force: true });
    evidence.passed = scenarioComplete;
  } catch (error) {
    evidence.cleanupError = redact(error instanceof Error ? error.stack : error);
    evidence.passed = false;
    process.exitCode = 1;
    if (gateway) await gateway.close().catch(() => undefined);
  }
  await writeFile(path.join(evidenceRoot, 'desktop.log'), redact(log.join('')));
  await writeFile(
    path.join(evidenceRoot, 'evidence.json'),
    redact(JSON.stringify(evidence, null, 2)) + '\n'
  );
  console.log(`Packaged default-model evidence: ${evidenceRoot}`);
}
assert.equal(
  evidence.passed,
  true,
  'Packaged default-model qualification failed; inspect retained evidence'
);
