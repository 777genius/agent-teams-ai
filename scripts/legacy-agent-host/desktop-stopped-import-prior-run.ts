// Source preparation only. The existing desktop smoke owns all import/Launch acceptance.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  LEGACY_IMPORT_TEAM,
  CURRENT_LEGACY_SOURCE_PROMPT,
  CURRENT_LEGACY_SOURCE_REPLY,
  captureCurrentStoppedSourceInputs,
  readStoppedImportSourceDiagnostics,
  stoppedImportSourceBytes,
} from './desktop-stopped-import-fixture.ts';
import type { CurrentNativeStoppedImportSeed } from './desktop-stopped-import-fixture.ts';
import {
  connectCapturedDesktopApp,
  cleanupCapturedDesktopApp,
  captureDesktopNativeExecutable,
  selectedDesktopRuntime,
} from './desktop-captured-app.ts';
import type { DesktopCdpLibrary, DesktopCdpPort } from './desktop-captured-app.ts';
import {
  assertOwnedCdpListener,
  command,
  groupMembers,
  portOccupied,
  processTable,
  selectedCdpPort,
  compiledBundleHashes,
} from './desktop-backend-observations.ts';
import { createDesktopUiControls, desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import { openOriginalCreateForm } from './desktop-create-config-ui-smoke.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';

// These are existing Main owners, loaded by the installed tsx source loader only for fixture setup.
// Their aliases/Node sources are outside the standalone Host script compiler's public closure.
const mainModule = (path: string): Promise<Record<string, unknown>> =>
  import(pathToFileURL(join(import.meta.dirname, '../../src/main', path)).href);

type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const read = async (path: string) => row(JSON.parse(await readFile(path, 'utf8')));
const tick = () => new Promise<void>((done) => setTimeout(done, 100));

/** Reuse the stopped-import journey with genuine current UI records and its original Stop owner. */
export async function produceDesktopCurrentStoppedTeam(options: {
  repo: string;
  fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
  cdpLibrary: DesktopCdpLibrary;
  model: Awaited<ReturnType<typeof startNativeTeamModel>>;
  evidence: Row;
}): Promise<void> {
  const { fixture, model } = options;
  assert.equal(process.env.LEGACY_DESKTOP_STOPPED_IMPORT_LAUNCH, '1');
  assert.equal(process.env.LEGACY_DESKTOP_DONOR_SAVED_ONLY ?? '', '');
  const inputs = await captureCurrentStoppedSourceInputs(options.repo, fixture.node);
  assert.equal(await portOccupied(), false);
  assert.deepEqual(selectedDesktopRuntime(inputs.runtime.path), [], 'no earlier selected runtime');
  const team = join(fixture.root, 'claude/teams', LEGACY_IMPORT_TEAM);
  await assert.rejects(
    lstat(team),
    { code: 'ENOENT' },
    'source is created only by its original UI'
  );
  const bin = join(fixture.root, 'current-source-bin');
  await mkdir(bin, { mode: 0o700 });
  for (const name of ['pnpm', 'shell-env', 'codex', 'opencode', 'gemini', 'terminal-daemon']) {
    await copyFile(join(fixture.root, 'bin', name), join(bin, name));
    await chmod(join(bin, name), 0o700);
  }
  const env: NodeJS.ProcessEnv = {
    HOME: join(fixture.root, 'home'),
    CFFIXED_USER_HOME: join(fixture.root, 'home'),
    XDG_CONFIG_HOME: join(fixture.root, 'config'),
    XDG_DATA_HOME: join(fixture.root, 'data'),
    XDG_CACHE_HOME: join(fixture.root, 'cache'),
    TMPDIR: join(fixture.root, 'tmp'),
    MAC_CHROMIUM_TMPDIR: join(fixture.root, 'tmp'),
    PATH: [
      bin,
      dirname(fixture.node),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(':'),
    SHELL: join(bin, 'shell-env'),
    TERM: 'dumb',
    NO_COLOR: '1',
    NODE_ENV: 'development',
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: join(fixture.root, 'userData'),
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: join(fixture.root, 'claude'),
    CLAUDE_ROOT: join(fixture.root, 'claude'),
    CLAUDE_CONFIG_DIR: join(fixture.root, 'claude'),
    CODEX_HOME: join(fixture.root, 'config/codex'),
    OPENCODE_CONFIG_DIR: join(fixture.root, 'config/opencode'),
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: inputs.runtime.path,
    CLAUDE_DEV_RUNTIME_CACHE_ROOT: process.env.LEGACY_DESKTOP_CURRENT_RUNTIME_CACHE,
    CLAUDE_DEV_RUNTIME_DISABLE_GH: '1',
    NODE_BINARY: fixture.node,
    pnpm_config_verify_deps_before_run: 'warn',
    ANTHROPIC_BASE_URL: model.url,
    ANTHROPIC_API_KEY: 'TEST-current-legacy-only-key',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  assert.ok(!Object.keys(env).some((key) => key.includes('BACKEND_DESCRIPTOR')));
  const steps: Row[] = [],
    proof: Row = {
      status: 'INCOMPLETE',
      sourceKind: 'actual-current-native-solo',
      producer: inputs,
      steps,
      scope:
        'Current frontend creates solo Claude, one local text turn, original Stop, UI Task and ordinary Quit before Host import',
      excluded: [
        'donor4a native history',
        'vendor authentication',
        'multi-member prior-native import',
      ],
      hostDescriptorPresent: false,
    };
  options.evidence.currentStoppedProducer = proof;
  const receiptPath = join(fixture.root, 'stopped-import-prior-run.json');
  const log = createWriteStream(join(fixture.root, 'desktop-current-stopped-app.log'), {
    mode: 0o600,
  });
  const invocation = [
    fixture.node,
    fixture.packageManager.entry,
    'dev:mcp',
    '--remoteDebuggingPort',
    String(selectedCdpPort),
  ];
  const app = spawn(invocation[0]!, invocation.slice(1), {
    cwd: inputs.root,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const group = app.pid ?? 0;
  let spawnError = false,
    appIdentity = '',
    quitRequested = false;
  let cdp: DesktopCdpPort | undefined,
    seed: Omit<CurrentNativeStoppedImportSeed, 'priorRun'> | undefined;
  const native = captureDesktopNativeExecutable(inputs.runtime.path, group);
  app.once('error', () => {
    spawnError = true;
  });
  app.stdout.pipe(log, { end: false });
  app.stderr.pipe(log, { end: false });
  try {
    assert.ok(group > 0);
    appIdentity = execFileSync('/bin/ps', ['-p', String(group), '-o', 'lstart=,command='], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    proof.app = { pid: group, processGroup: group, identity: appIdentity, invocation };
    cdp = (
      await connectCapturedDesktopApp({
        app,
        group,
        spawnError: () => spawnError,
        packed: undefined,
        cdpLibrary: options.cdpLibrary,
        evidence: proof,
      })
    ).cdp;
    const renderer = cdp;
    assert.ok(
      groupMembers(group).some(
        (entry) =>
          command(entry.pid) === inputs.electron.path ||
          command(entry.pid).startsWith(inputs.electron.path + ' ')
      ),
      'selected original Electron'
    );
    proof.bundles = await compiledBundleHashes(join(inputs.root, 'dist-electron'));
    const assertOriginal = () => {
      assertOwnedCdpListener(group);
      native.observe();
      assert.deepEqual(model.failures, []);
    };
    const ui = createDesktopUiControls(renderer, {
      assertOwnedRenderer: assertOriginal,
      step: (value) => steps.push(value),
    });
    await openOriginalCreateForm(renderer, ui, join(fixture.root, 'workspace'), LEGACY_IMPORT_TEAM);
    const page = '[data-testid="create-team-page"]';
    await ui.scrollTo(page + ' button[aria-label*=" provider,"]', 'current original lead model');
    await ui.click(page + ' button[aria-label*=" provider,"]', 'open current original lead model');
    const option =
      page + ' [data-testid="team-model-selector-model-option"][aria-label^="Sonnet 4.6"]';
    await ui.scrollTo(option, 'current Sonnet4.6');
    await ui.click(option, 'select current Sonnet4.6');
    await ui.scrollTo(page + ' button', 'current Low effort', 'Low');
    await ui.click(page + ' button', 'select current Low effort', 'Low');
    assert.equal(
      await renderer.evaluate(
        `document.querySelectorAll('${page} input[aria-label^="Member "]').length`
      ),
      0
    );
    const optional = row(
      await ui.waitRead(
        `(()=>{const b=[...document.querySelectorAll('${page} button[aria-controls]')].find(e=>e.textContent.includes('Optional launch settings'));return b?{id:b.getAttribute('aria-controls'),expanded:b.getAttribute('aria-expanded')}:null})()`,
        'current launch settings'
      )
    );
    if (optional.expanded !== 'true') {
      const selector = page + ' button[aria-controls=' + JSON.stringify(optional.id) + ']';
      await ui.scrollTo(selector, 'current launch settings');
      await ui.click(selector, 'expand current launch settings once');
    }
    await ui.scrollTo(page + ' #team-prompt', 'current original prompt');
    await ui.click(page + ' #team-prompt', 'type one current source input');
    await renderer.send('Input.insertText', { text: CURRENT_LEGACY_SOURCE_PROMPT });
    await ui.waitRead(
      `document.querySelector('${page} #team-prompt')?.value===${literal(CURRENT_LEGACY_SOURCE_PROMPT)}`,
      'one current prompt retained'
    );
    await ui.scrollTo(page + ' #create-skip-permissions', 'current original permissions');
    const skip = await renderer.evaluate(
      `document.querySelector('${page} #create-skip-permissions')?.getAttribute('data-state')`
    );
    assert.ok(skip === 'checked' || skip === 'unchecked');
    if (skip === 'checked')
      await ui.click(page + ' #create-skip-permissions', 'retain ordinary source permissions');
    await ui.waitRead(
      `document.querySelector('${page} #create-skip-permissions')?.getAttribute('data-state')==='unchecked'`,
      'ordinary source permission choice retained'
    );
    assert.equal(
      await renderer.evaluate(
        `document.querySelector('${page} #launch-team')?.getAttribute('data-state')`
      ),
      'checked'
    );
    await ui.scrollTo(page + ' button', 'current original Create', 'Create');
    await ui.click(page + ' button', 'create and launch one current solo Team', 'Create');
    await ui.waitRead(`!document.querySelector('${page}')`, 'current Create completes', 90_000);
    const poll = async <T>(
      observe: () => Promise<T>,
      accepts: (value: T) => boolean,
      label: string
    ) => {
      const deadline = Date.now() + 90_000;
      let value = await observe();
      while (!accepts(value) && Date.now() < deadline) {
        assertOriginal();
        await tick();
        value = await observe();
      }
      assert.ok(accepts(value), label);
      return value;
    };
    const launch = await poll(
      () =>
        read(join(team, 'launch-state.json')).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return row({});
          throw error;
        }),
      (state) =>
        state.version === 2 &&
        typeof state.leadSessionId === 'string' &&
        typeof state.publicationRunId === 'string',
      'actual source launch identity'
    );
    assert.equal(launch.teamName, LEGACY_IMPORT_TEAM);
    assert.deepEqual(launch.expectedMembers, []);
    assert.deepEqual(launch.members, {});
    const config = await read(join(team, 'config.json'));
    assert.deepEqual(
      (config.members as unknown[]).map((value) => row(value).name),
      ['team-lead']
    );
    assert.equal(config.leadSessionId, launch.leadSessionId);
    proof.sourceRunId = launch.publicationRunId;
    proof.sourceSessionId = launch.leadSessionId;
    await ui.click('button[aria-label^="lead,"]', 'open original current lead thread');
    await ui.waitRead(
      `document.body.innerText.includes(${literal(CURRENT_LEGACY_SOURCE_REPLY)})`,
      'actual current source reply visible',
      90_000
    );
    assert.equal(model.currentLegacyTurns?.length, 1);
    const shot = row(
      await renderer.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    );
    const screenshot = join(fixture.root, 'desktop-current-stopped-source.png');
    await writeFile(screenshot, Buffer.from(String(shot.data), 'base64'), {
      mode: 0o600,
      flag: 'wx',
    });
    proof.screenshot = { path: screenshot, sha256: await fileDigest(screenshot) };
    native.observe();
    const beforeStop = native.remaining();
    assert.ok(beforeStop.length >= 1, 'original source CLI still alive before Stop');
    await ui.click('button[aria-label="Stop"]', 'original current source Stop exactly once');
    const stopped = await poll(
      () =>
        read(join(team, 'launch-stopped.json')).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return row({});
          throw error;
        }),
      (state) => state.nativeRelease !== undefined,
      'original source Stop publishes its branded release'
    );
    const release = row(stopped.nativeRelease),
      target = row(release.target);
    assert.equal(target.teamName, LEGACY_IMPORT_TEAM);
    assert.equal(target.runId, launch.publicationRunId);
    assert.equal(target.sessionId, launch.leadSessionId);
    const sourceChild = beforeStop.find((child) => child.pid === target.rootPid);
    assert.ok(sourceChild, 'release identifies the original observed live child');
    assert.equal(sourceChild.pgid, target.rootPid);
    assert.equal(row(release.process).rootStartIdentity, 'ps:' + sourceChild.birth);
    await poll(
      async () => native.remaining(),
      (remaining) => remaining.length === 0,
      'all original source native children absent'
    );
    proof.proof = release;
    const taskRoot = join(fixture.root, 'claude/tasks', LEGACY_IMPORT_TEAM);
    const tasks = async () =>
      Promise.all(
        (
          await readdir(taskRoot).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
          })
        )
          .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
          .map((name) => read(join(taskRoot, name)))
      );
    assert.deepEqual(await tasks(), [], 'source text turn created no tasks');
    await ui.click('button', 'original source Create Task', 'Task');
    await ui.waitRead(
      `Boolean(document.querySelector('[role="dialog"] #task-subject'))`,
      'source Task dialog'
    );
    await ui.click('[role="dialog"] #task-subject', 'type source saved Task subject');
    const subject = 'TEST saved after original current Claude Stop';
    await renderer.send('Input.insertText', { text: subject });
    assert.equal(
      await renderer.evaluate(
        `document.querySelector('[role="dialog"] #task-start-immediately')?.getAttribute('data-state')??'unchecked'`
      ),
      'unchecked'
    );
    await ui.click(
      '[role="dialog"] button',
      'save one source Task without runtime input',
      'Create'
    );
    await ui.waitRead(
      `!document.querySelector('[role="dialog"] #task-subject')`,
      'source Task saved'
    );
    const created = await tasks();
    assert.equal(created.length, 1);
    const task = created[0]!;
    assert.equal(task.subject, subject);
    assert.equal(task.status, 'pending');
    assert.equal(typeof task.id, 'string');
    assert.equal(
      model.currentLegacyTurns?.length,
      1,
      'saving a stopped Task never submits another input'
    );
    const diagnostics = await readStoppedImportSourceDiagnostics(fixture.root, {
      node: fixture.node,
      electron: inputs.electron.path,
    });
    assert.equal(row(diagnostics.canonicalNodeRead).canonicalReleaseCurrent, true);
    assert.equal(row(diagnostics.canonicalNodeRead).proofParseable, true);
    proof.originalStopDiagnostics = diagnostics;
    proof.sourceTask = task;
    assert.ok(
      !groupMembers(group).some(
        (entry) => command(entry.pid) === fixture.node + ' ' + fixture.hostEntry
      )
    );
    quitRequested = true;
    await renderer.evaluate('window.electronAPI.windowControls.close()').catch(() => undefined);
    const deadline = Date.now() + 20_000;
    while (
      Date.now() < deadline &&
      (app.exitCode === null ||
        groupMembers(group).length ||
        native.remaining().length ||
        selectedDesktopRuntime(inputs.runtime.path).length)
    )
      await tick();
    assert.equal(app.exitCode, 0);
    assert.equal(app.signalCode, null);
    assert.deepEqual(groupMembers(group), []);
    assert.equal(
      processTable().some((entry) => entry.pid === group),
      false
    );
    assert.equal(await portOccupied(), false);
    assert.deepEqual(native.remaining(), []);
    assert.deepEqual(selectedDesktopRuntime(inputs.runtime.path), []);
    proof.nativeChildren = { captured: native.captured(), remaining: [], unmatched: [] };
    proof.ordinaryQuit = {
      requestedOnce: true,
      exitCode: app.exitCode,
      signalCode: app.signalCode,
      originalGroupAbsent: true,
      remaining: [],
      listenerAbsent: true,
    };
    assert.ok(model.finishCurrentLegacySource);
    const sourceModel = await model.finishCurrentLegacySource();
    assert.equal(sourceModel.turns[0]!.model, 'claude-sonnet-4-6');
    proof.model = sourceModel;
    proof.sourceNativeInputs = 1;
    assert.deepEqual(model.observations, []);
    assert.deepEqual(model.probes, []);
    assert.deepEqual(model.failures, []);
    const roots: string[] = [],
      absentRoots: string[] = [];
    for (const path of [
      team,
      taskRoot,
      join(fixture.root, 'userData/data/attachments', LEGACY_IMPORT_TEAM),
      join(fixture.root, 'userData/data/task-attachments', LEGACY_IMPORT_TEAM),
    ]) {
      try {
        const stat = await lstat(path);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
        roots.push(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        absentRoots.push(path);
      }
    }
    assert.ok(roots.includes(team) && roots.includes(taskRoot));
    const meta = await read(join(team, 'team.meta.json'));
    assert.equal(meta.cwd, join(fixture.root, 'workspace'));
    assert.equal(meta.prompt, CURRENT_LEGACY_SOURCE_PROMPT);
    assert.equal(meta.providerId, 'anthropic');
    assert.equal(meta.model, 'claude-sonnet-4-6');
    assert.equal(meta.effort, 'low');
    assert.equal(meta.skipPermissions, false);
    const savedSettings = Object.fromEntries(
      [
        'cwd',
        'providerId',
        'model',
        'effort',
        'fastMode',
        'prompt',
        'skipPermissions',
        'syncModelsWithLead',
        'limitContext',
      ]
        .filter((key) => meta[key] !== undefined)
        .map((key) => [key, meta[key]])
    );
    seed = {
      sourceKind: 'actual-current-native-solo',
      teamName: LEGACY_IMPORT_TEAM,
      displayName:
        typeof meta.displayName === 'string' && meta.displayName.trim()
          ? meta.displayName
          : LEGACY_IMPORT_TEAM,
      sourceCardLabel: LEGACY_IMPORT_TEAM,
      taskId: String(task.id),
      sourceTask: task,
      savedSettings: savedSettings as CurrentNativeStoppedImportSeed['savedSettings'],
      roots,
      absentRoots,
      before: await stoppedImportSourceBytes(fixture.root, roots),
    };
    proof.source = { roots, absentRoots, files: seed.before };
    proof.status = 'PASS';
  } catch (error) {
    proof.failure = error instanceof Error ? error.message.slice(0, 4000) : 'current source failed';
    throw error;
  } finally {
    if (cdp && !quitRequested && app.exitCode === null && app.signalCode === null) {
      quitRequested = true;
      try {
        assertOwnedCdpListener(group);
        await cdp.evaluate('window.electronAPI.windowControls.close()');
      } catch {
        /* Captured original cleanup follows. */
      }
    }
    if (cdp) await cdp.close().catch(() => undefined);
    const cleanup = await cleanupCapturedDesktopApp({
      app,
      group,
      fixture,
      evidence: proof,
      appIdentity,
      hostPid: undefined,
      packedRelaunchMode: false,
    });
    proof.cleanup = cleanup;
    proof.nativeChildrenAfterCleanup = {
      captured: native.captured(),
      remaining: native.remaining(),
      unmatched: selectedDesktopRuntime(inputs.runtime.path),
    };
    if (
      native.remaining().length ||
      selectedDesktopRuntime(inputs.runtime.path).length ||
      cleanup.cleanupFailure ||
      cleanup.remaining === null ||
      cleanup.remaining.length
    )
      proof.status = 'INCOMPLETE';
    try {
      assert.deepEqual(await captureCurrentStoppedSourceInputs(inputs.root, fixture.node), inputs);
      proof.sourceFrozen = true;
    } catch (error) {
      proof.status = 'INCOMPLETE';
      proof.freezeFailure =
        error instanceof Error ? error.message.slice(0, 4000) : 'source changed';
    }
    app.stdout.unpipe(log);
    app.stderr.unpipe(log);
    await new Promise<void>((done) => log.end(done));
    await writeFile(receiptPath, JSON.stringify(proof, null, 2), { mode: 0o600, flag: 'wx' });
    assert.equal(
      proof.status,
      'PASS',
      'current source finished original Stop, Quit, absence and frozen input'
    );
  }
  assert.ok(seed);
  await writeFile(
    join(fixture.root, 'stopped-import-ui-seed.json'),
    JSON.stringify(
      { ...seed, priorRun: { path: receiptPath, sha256: await fileDigest(receiptPath) } },
      null,
      2
    ),
    { mode: 0o600, flag: 'wx' }
  );
}

async function runControlledPriorRun(rootInput: string, readOnly: boolean): Promise<void> {
  const processOwner = await mainModule('utils/childProcess.ts');
  const stopOwner = await mainModule('services/team/provisioning/LegacyNativeStopRelease.ts');
  const pathOwner = await mainModule('utils/pathDecoder.ts');
  const launchOwner = await mainModule('services/team/TeamLaunchStateStore.ts');
  for (const [module, names] of [
    [processOwner, ['spawnCli', 'killProcessTreeAndWait']],
    [stopOwner, ['captureLegacyNativeStop', 'readLegacyNativeStopRelease']],
    [pathOwner, ['setClaudeBasePathOverride']],
    [launchOwner, ['TeamLaunchStateStore']],
  ] as const)
    for (const name of names) assert.equal(typeof module[name], 'function');
  const spawnCli = processOwner.spawnCli as (
    binary: string,
    args: string[],
    options: SpawnOptions
  ) => ChildProcess;
  const killProcessTreeAndWait = processOwner.killProcessTreeAndWait as (
    child: ChildProcess
  ) => Promise<void>;
  const setClaudeBasePathOverride = pathOwner.setClaudeBasePathOverride as (path: string) => void;
  const captureLegacyNativeStop = stopOwner.captureLegacyNativeStop as (
    root: string,
    run: {
      teamName: string;
      runId: string;
      detectedSessionId: string;
      child: ChildProcess;
      expectedMembers: never[];
      allEffectiveMembers: never[];
      mixedSecondaryLanes: never[];
      request: { providerId: string; members: never[] };
    },
    current: () => boolean
  ) => { complete(): Record<string, unknown> | null } | null;
  const readLegacyNativeStopRelease = stopOwner.readLegacyNativeStopRelease as (
    root: string,
    team: string
  ) => unknown;
  const TeamLaunchStateStore = launchOwner.TeamLaunchStateStore as new () => {
    beginStop(teamName: string): Promise<unknown>;
    markStopped(teamName: string, authority: unknown, proof: unknown): Promise<void>;
  };

  const root = resolve(rootInput);
  assert.match(basename(root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
  assert.equal(process.env.CLAUDE_ROOT, join(root, 'claude'));
  assert.equal(process.env.HOME, join(root, 'home'));
  setClaudeBasePathOverride(join(root, 'claude'));
  assert.notEqual(process.platform, 'win32');
  const team = join(root, 'claude/teams', LEGACY_IMPORT_TEAM);
  const identity = lstatSync(team);
  assert.ok(identity.isDirectory() && !identity.isSymbolicLink());
  const current = () => {
    const now = lstatSync(team);
    return now.dev === identity.dev && now.ino === identity.ino && !now.isSymbolicLink();
  };
  if (readOnly) {
    const marker = JSON.parse(readFileSync(join(team, 'launch-stopped.json'), 'utf8'));
    const censusOwner = await mainModule('services/team/provisioning/LegacyNativeStopCensus.ts');
    const parse = stopOwner.parseLegacyNativeStopRelease as (
      value: unknown
    ) => Record<string, unknown> | null;
    const census = censusOwner.readLegacyNativeCensus as (
      directory: string,
      target: unknown
    ) => unknown;
    const parsed = parse(marker.nativeRelease);
    let currentCensus: unknown;
    try {
      currentCensus = parsed ? census(team, parsed.target) : { error: 'unparseable-proof' };
    } catch (error) {
      currentCensus = { error: error instanceof Error ? error.message : String(error) };
    }
    process.stdout.write(
      JSON.stringify({
        nodeVersion: process.versions.node,
        canonicalReleaseCurrent: readLegacyNativeStopRelease(team, LEGACY_IMPORT_TEAM) !== null,
        proofParseable: parsed !== null,
        proofCensus: parsed?.census,
        currentCensus,
      })
    );
  } else {
    const write = (file: string, value: unknown) =>
      writeFileSync(join(team, file), JSON.stringify(value), { mode: 0o600 });
    const meta = JSON.parse(readFileSync(join(team, 'team.meta.json'), 'utf8'));
    const backupIdentityId = randomUUID();
    const sourceRunId = `TEST-prior-run-${randomUUID()}`;
    const sourceSessionId = `TEST-synthetic-source-session-${randomUUID()}`;
    write('config.json', {
      name: LEGACY_IMPORT_TEAM,
      _backupIdentityId: backupIdentityId,
      leadAgentId: `team-lead@${LEGACY_IMPORT_TEAM}`,
      leadSessionId: sourceSessionId,
      members: [{ name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic' }],
    });
    const configBeforeStopSha256 = createHash('sha256')
      .update(readFileSync(join(team, 'config.json')))
      .digest('hex');
    write('members.meta.json', { version: 1, members: [] });
    write('launch-state.json', {
      version: 2,
      teamName: LEGACY_IMPORT_TEAM,
      publicationRunId: sourceRunId,
      leadSessionId: sourceSessionId,
      expectedMembers: [],
      members: {},
    });
    write('launch-freshness.json', {
      version: 1,
      teamName: LEGACY_IMPORT_TEAM,
      kind: 'launch',
      runId: sourceRunId,
    });
    // A real source-owned child supplies custody proof. No source provider inference or native history is fabricated.
    const child = spawnCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: root,
      env: { HOME: process.env.HOME, PATH: process.env.PATH },
      detached: true,
      stdio: 'ignore',
    });
    let stopped = false;
    try {
      const captured = captureLegacyNativeStop(
        join(root, 'claude/teams'),
        {
          teamName: LEGACY_IMPORT_TEAM,
          runId: sourceRunId,
          detectedSessionId: sourceSessionId,
          child,
          expectedMembers: [],
          allEffectiveMembers: [],
          mixedSecondaryLanes: [],
          request: { providerId: 'anthropic', members: [] },
        },
        current
      );
      assert.ok(captured, 'existing source owner captures the actual child identity before Stop');
      assert.equal(captured.complete(), null, 'a live captured child is not a release witness');
      const store = new TeamLaunchStateStore();
      const authority = await store.beginStop(LEGACY_IMPORT_TEAM);
      await killProcessTreeAndWait(child);
      stopped = true;
      const proof = captured.complete();
      assert.ok(proof, 'existing process owner confirms physical exit before publication');
      await store.markStopped(LEGACY_IMPORT_TEAM, authority, proof);
      assert.deepEqual(readLegacyNativeStopRelease(team, LEGACY_IMPORT_TEAM), proof);
      assert.equal(
        JSON.parse(readFileSync(join(team, 'config.json'), 'utf8'))._backupIdentityId,
        backupIdentityId
      );
      assert.equal(
        createHash('sha256')
          .update(readFileSync(join(team, 'config.json')))
          .digest('hex'),
        configBeforeStopSha256
      );
      const evidence = {
        scope:
          'Synthetic solo legacy product/run records with an actual source-owned TEST Node child and existing captured Stop publication; no old provider inference',
        sourceRunId,
        sourceSessionId,
        sourceNativeInputs: 0,
        backupIdentityId,
        configBeforeStopSha256,
        savedSettings: meta,
        proof,
        childExit: { exitCode: child.exitCode, signalCode: child.signalCode },
      };
      writeFileSync(
        join(root, 'stopped-import-prior-run.json'),
        JSON.stringify(evidence, null, 2),
        {
          mode: 0o600,
          flag: 'wx',
        }
      );
    } finally {
      if (!stopped) await killProcessTreeAndWait(child);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)
  await runControlledPriorRun(process.argv[2]!, process.argv[3] === '--read-only');
