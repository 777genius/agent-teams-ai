import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { lstat, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { assertOwnedCdpListener, command, compiledBundleHashes, groupMembers, portOccupied,
  processTable, selectedCdpPort } from './desktop-backend-observations.ts';
import { cleanupCapturedDesktopApp, connectCapturedDesktopApp, captureDesktopRendererFailure,
  type DesktopCdpLibrary, type DesktopCdpPort } from './desktop-captured-app.ts';
import { openOriginalCreateForm } from './desktop-create-config-ui-smoke.ts';
import { readStoppedImportSourceDiagnostics, stoppedImportSourceBytes } from './desktop-stopped-import-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import { FINITE_IMPORT_MODE, FINITE_SOURCE_PROMPT, FINITE_SOURCE_REPLY, FINITE_SOURCE_TEAM,
  finiteImportJson as json, finiteImportRow as row, prepareFiniteLegacyExecutable, readFiniteLegacyEffects,
  startFiniteLegacyCatalog, verifyFiniteLegacyCandidates, type FiniteImportFixture, type FiniteImportRow } from './desktop-finite-stopped-import-fixture.ts';

const tick = () => new Promise<void>(done => setTimeout(done, 100));
export function readFiniteSourceBirth(pid: number): string | null {
  if (!processTable().some(value => value.pid === pid)) return null;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
      assert.match(fields[19] ?? '', /^\d+$/u); return 'proc:' + fields[19];
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  return 'ps:' + execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000 }).trim();
}

/** Actual legacy frontend writes and original Main Stop; finite protocol runtime, never a vendor CLI. */
export async function produceDesktopFiniteStoppedTeam(options: {
  repo: string; fixture: FiniteImportFixture; cdpLibrary: DesktopCdpLibrary;
  electron: string; evidence: FiniteImportRow;
}) {
  const { repo, fixture } = options;
  assert.equal(process.env.LEGACY_DESKTOP_PROOF_MODE, FINITE_IMPORT_MODE);
  assert.equal(process.env.LEGACY_DESKTOP_EMULATED_ONLY, '1');
  assert.equal(process.env.LEGACY_DESKTOP_STOPPED_IMPORT_LAUNCH, undefined);
  assert.equal(process.env.LEGACY_DESKTOP_DONOR_SAVED_ONLY, undefined);
  assert.notEqual(process.platform, 'win32');
  assert.equal(await portOccupied(), false);
  const team = join(fixture.root, 'claude/teams', FINITE_SOURCE_TEAM);
  await assert.rejects(lstat(team), { code: 'ENOENT' }, 'no source records before original Create');
  const candidates = await verifyFiniteLegacyCandidates(repo, fixture);
  const executable = await prepareFiniteLegacyExecutable(repo, fixture), catalog = await startFiniteLegacyCatalog();
  const env: Record<string, string> = { ...fixture.appEnvironment };
  delete env.AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH; delete env.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256;
  Object.assign(env, {
    PATH: [join(fixture.root, 'bin'), dirname(fixture.node), '/usr/bin', '/bin'].join(':'),
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: executable.path, CLAUDE_CLI_PATH: executable.path,
    TEST_LEGACY_BOOTSTRAP: 'current-solo-v1', TEST_LEGACY_BOOTSTRAP_ROOT: fixture.root,
    TEST_LEGACY_BOOTSTRAP_REPO: repo,
    TEST_LEGACY_BOOTSTRAP_VERSION: executable.version,
    ANTHROPIC_BASE_URL: catalog.url, ANTHROPIC_API_KEY: 'TEST-finite-legacy-catalog',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  assert.ok(!Object.keys(env).some(key => key.includes('BACKEND_DESCRIPTOR')));
  const steps: FiniteImportRow[] = [];
  const proof: FiniteImportRow = { status: 'INCOMPLETE', sourceKind: 'actual-current-finite-solo',
    execution: 'finite-legacy-bootstrap-protocol', scope: 'Current frontend Create/Launch, visible finite reply, original Main Stop/release, UI Task and ordinary Quit',
    excluded: ['genuine historical donor frontend', 'vendor CLI/inference/auth qualification', 'multi-member or Windows source release', 'native session adoption'],
    hostDescriptorPresent: false, candidates, executable, steps };
  options.evidence.finiteStoppedProducer = proof;
  const receiptPath = join(fixture.root, 'finite-stopped-import-producer.json');
  const log = createWriteStream(join(fixture.root, 'finite-stopped-import-source-app.log'), { mode: 0o600 });
  const invocation = [fixture.node, fixture.packageManager.entry, 'dev:mcp', '--remoteDebuggingPort',
    String(selectedCdpPort), ...(process.platform === 'linux' ? ['--noSandbox'] : [])];
  const app = spawn(invocation[0]!, invocation.slice(1), { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const group = app.pid ?? 0;
  let spawnError = false, appIdentity = '', quitRequested = false, phase = 'connect';
  let cdp: DesktopCdpPort | undefined, sourcePid: number | undefined, sourceBirth: string | undefined;
  let sourceIdentityUnknown = false;
  let seed: FiniteImportRow | undefined;
  app.once('error', () => { spawnError = true; }); app.stdout.pipe(log, { end: false }); app.stderr.pipe(log, { end: false });
  const peerCommand = fixture.node + ' ' + executable.path + ' ';
  const sourceTable = () => execFileSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,pgid=,command='],
    { encoding: 'utf8', timeout: 3000 }).trim().split('\n').map(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line); assert.ok(match);
      return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4]! };
    });
  const observeSource = () => {
    const table = sourceTable();
    const matches = table.filter(value => value.command.startsWith(peerCommand) && value.command.includes('--team-bootstrap-spec'));
    assert.ok(matches.length <= 1, 'one original finite bootstrap process');
    for (const child of matches) {
      const birth = readFiniteSourceBirth(child.pid); assert.ok(birth);
      const ancestry: number[] = []; let parent = child.ppid;
      while (parent !== group && ancestry.length < 64) {
        ancestry.push(parent); const found = table.find(value => value.pid === parent); assert.ok(found); parent = found.ppid;
      }
      assert.equal(parent, group); ancestry.push(group); assert.equal(child.pgid, child.pid);
      assert.equal(readFiniteSourceBirth(child.pid), birth);
      if (sourcePid !== undefined) { assert.equal(sourcePid, child.pid); assert.equal(sourceBirth, birth); }
      else { sourcePid = child.pid; sourceBirth = birth; proof.liveSourceChild = { ...child, startIdentity: birth, ancestry }; }
    }
  };
  const sourceAbsent = () => !sourceIdentityUnknown &&
    (sourcePid === undefined || readFiniteSourceBirth(sourcePid) !== sourceBirth) &&
    !sourceTable().some(value => value.command.startsWith(peerCommand));
  try {
    assert.ok(group > 0);
    appIdentity = execFileSync('/bin/ps', ['-p', String(group), '-o', 'lstart=,command='], { encoding: 'utf8', timeout: 3000 }).trim();
    proof.app = { pid: group, processGroup: group, identity: appIdentity, invocation };
    cdp = (await connectCapturedDesktopApp({ app, group, spawnError: () => spawnError, packed: undefined,
      cdpLibrary: options.cdpLibrary, evidence: proof })).cdp;
    const renderer = cdp;
    assert.ok(groupMembers(group).some(entry => command(entry.pid) === options.electron || command(entry.pid).startsWith(options.electron + ' ')));
    proof.bundles = await compiledBundleHashes(join(repo, 'dist-electron'));
    const assertOriginal = () => {
      assertOwnedCdpListener(group); assert.deepEqual(catalog.failures, []);
      observeSource();
      assert.ok(!groupMembers(group).some(entry => command(entry.pid) === fixture.node + ' ' + fixture.hostEntry));
    };
    const ui = createDesktopUiControls(renderer, { assertOwnedRenderer: assertOriginal,
      step: value => steps.push({ ...value, producerPhase: phase }) });
    const poll = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string, timeout = 90_000) => {
      const deadline = Date.now() + timeout;
      for (;;) { const value = await read(); if (accepts(value)) return value;
        assert.ok(Date.now() < deadline, label + '; original action is never repeated'); assertOriginal(); await tick(); }
    };
    const screenshot = async (name: string) => {
      const image = row(await renderer.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
      const path = join(fixture.root, name); await writeFile(path, Buffer.from(String(image.data), 'base64'), { mode: 0o600, flag: 'wx' });
      return { path, sha256: await fileDigest(path) };
    };
    phase = 'create';
    await ui.observeInput();
    await openOriginalCreateForm(renderer, ui, join(fixture.root, 'workspace'), FINITE_SOURCE_TEAM);
    const page = '[data-testid="create-team-page"]';
    await ui.scrollTo(page + ' button[aria-label*=" provider,"]', 'original source model');
    await ui.click(page + ' button[aria-label*=" provider,"]', 'open original source model');
    const option = page + ' [data-testid="team-model-selector-model-option"][aria-label^="Sonnet 4.6"]';
    await ui.scrollTo(option, 'finite source Sonnet selection'); await ui.click(option, 'select original source Sonnet');
    assert.equal(await renderer.evaluate(`document.querySelectorAll('${page} input[aria-label^="Member "]').length`), 0);
    const optional = row(await ui.waitRead(`(()=>{const b=[...document.querySelectorAll('${page} button[aria-controls]')].find(e=>e.textContent.includes('Optional launch settings'));return b?{id:b.getAttribute('aria-controls'),expanded:b.getAttribute('aria-expanded')}:null})()`, 'source optional settings'));
    if (optional.expanded !== 'true') {
      const selector = page + ' button[aria-controls=' + literal(optional.id) + ']';
      await ui.scrollTo(selector, 'original source options'); await ui.click(selector, 'expand original source options');
    }
    // This import source uses the legacy shared team identity, not a per-project execution name.
    const historyMode = page + ' #team-project-context-mode', sharedHistory = 'Shared across projects';
    await ui.scrollTo(historyMode, 'original source history mode');
    await ui.click(historyMode, 'open original source history mode');
    await ui.scrollTo('[role="listbox"] [role="option"]', 'original shared source history option', sharedHistory);
    await ui.click('[role="listbox"] [role="option"]', 'select original shared source history', sharedHistory);
    await ui.waitRead(`document.querySelector(${literal(historyMode)})?.textContent?.trim()===${literal(sharedHistory)}`, 'original source shared history selected');
    await ui.scrollTo(page + ' #team-prompt', 'original source prompt'); await ui.click(page + ' #team-prompt', 'type source input');
    await renderer.send('Input.insertText', { text: FINITE_SOURCE_PROMPT });
    await ui.waitRead(`document.querySelector('${page} #team-prompt')?.value===${literal(FINITE_SOURCE_PROMPT)}`, 'exact source prompt');
    await ui.scrollTo(page + ' #create-skip-permissions', 'original source permissions');
    const skip = await renderer.evaluate(`document.querySelector('${page} #create-skip-permissions')?.getAttribute('data-state')`);
    assert.ok(skip === 'checked' || skip === 'unchecked');
    if (skip === 'checked') await ui.click(page + ' #create-skip-permissions', 'retain ordinary source permissions');
    assert.equal(await renderer.evaluate(`document.querySelector('${page} #launch-team')?.getAttribute('data-state')`), 'checked');
    await ui.scrollTo(page + ' button', 'original Create and Launch', 'Create');
    await ui.click(page + ' button', 'Create and Launch original solo source exactly once', 'Create');
    await ui.waitRead(`!document.querySelector('${page}')`, 'original Create completes', 90_000);
    phase = 'reply';
    const launch = await poll(() => json(join(team, 'launch-state.json')).catch((error: NodeJS.ErrnoException): FiniteImportRow => {
      if (error.code === 'ENOENT') return {}; throw error;
    }), value => value.version === 2 && typeof value.publicationRunId === 'string' && typeof value.leadSessionId === 'string', 'original Main launch publication');
    assert.equal(launch.teamName, FINITE_SOURCE_TEAM); assert.deepEqual(launch.expectedMembers, []); assert.deepEqual(launch.members, {});
    const effects = await poll(() => readFiniteLegacyEffects(fixture.root), values => values.some(value => value.event === 'turn-completed'), 'one actual finite source turn');
    const bootstraps = effects.filter(value => value.event === 'bootstrap'), turns = effects.filter(value => value.event === 'turn-completed');
    assert.equal(bootstraps.length, 1); assert.equal(turns.length, 1);
    const bootstrap = bootstraps[0]!;
    assert.equal(bootstrap.runId, launch.publicationRunId); assert.equal(bootstrap.sessionId, launch.leadSessionId);
    assert.equal(turns[0]!.prompt, FINITE_SOURCE_PROMPT); assert.equal(turns[0]!.reply, FINITE_SOURCE_REPLY);
    const config = await json(join(team, 'config.json'));
    assert.equal(config.leadSessionId, launch.leadSessionId);
    assert.deepEqual((config.members as unknown[]).map(value => row(value).name), ['team-lead']);
    await ui.click('button[aria-label^="lead,"]', 'open original source lead conversation');
    await ui.waitRead(`document.body.innerText.includes(${literal(FINITE_SOURCE_REPLY)})`, 'source reply visible', 90_000);
    proof.sourceScreenshot = await screenshot('ui-finite-import-source.png');
    observeSource(); assert.equal(sourcePid, bootstrap.pid);
    assert.ok(sourceBirth, 'finite source remains physically alive until original Main Stop');
    const child = row(proof.liveSourceChild);
    assert.equal(bootstrap.parentPid, child.ppid); assert.equal(bootstrap.mainOwnerPid, child.ppid);
    assert.ok((child.ancestry as number[]).includes(Number(bootstrap.mainOwnerPid)));
    const mainCommand = command(Number(bootstrap.mainOwnerPid));
    assert.ok((mainCommand === options.electron || mainCommand.startsWith(options.electron + ' ')) && !mainCommand.includes('--type='));
    assert.equal(readFiniteSourceBirth(Number(sourcePid)), sourceBirth);
    phase = 'stop';
    await ui.click('button[aria-label="Stop"]', 'original Main source Stop exactly once');
    const stopped = await poll(() => json(join(team, 'launch-stopped.json')).catch((error: NodeJS.ErrnoException): FiniteImportRow => {
      if (error.code === 'ENOENT') return {}; throw error;
    }), value => value.nativeRelease !== undefined, 'original Main Stop release');
    const release = row(stopped.nativeRelease), target = row(release.target);
    assert.equal(target.teamName, FINITE_SOURCE_TEAM); assert.equal(target.runId, launch.publicationRunId);
    assert.equal(target.sessionId, launch.leadSessionId); assert.equal(target.rootPid, sourcePid);
    assert.equal(row(release.process).rootStartIdentity, sourceBirth);
    await poll(async () => sourceAbsent(), value => value, 'original source child physically absent');
    proof.sourceRunId = launch.publicationRunId; proof.sourceSessionId = launch.leadSessionId;
    proof.sourceRelease = release; proof.sourceStopped = stopped;
    phase = 'task';
    const taskRoot = join(fixture.root, 'claude/tasks', FINITE_SOURCE_TEAM);
    const tasks = async () => Promise.all((await readdir(taskRoot)).filter(name => /^[A-Za-z0-9_-]+\.json$/u.test(name)).map(name => json(join(taskRoot, name))));
    assert.deepEqual(await tasks(), []);
    await ui.click('button', 'original stopped source Create Task', 'Task');
    await ui.waitRead(`Boolean(document.querySelector('[role="dialog"] #task-subject'))`, 'source Task dialog');
    await ui.click('[role="dialog"] #task-subject', 'source Task subject');
    await renderer.send('Input.insertText', { text: 'TEST task saved after original finite source Stop' });
    assert.equal(await renderer.evaluate(`document.querySelector('[role="dialog"] #task-start-immediately')?.getAttribute('data-state')??'unchecked'`), 'unchecked');
    await ui.click('[role="dialog"] button', 'save stopped source Task once', 'Create');
    await ui.waitRead(`!document.querySelector('[role="dialog"] #task-subject')`, 'source Task saved');
    const created = await tasks(); assert.equal(created.length, 1);
    const task = created[0]!; assert.equal(task.status, 'pending'); assert.equal(typeof task.id, 'string');
    assert.equal(task.subject, 'TEST task saved after original finite source Stop');
    const diagnostics = await readStoppedImportSourceDiagnostics(fixture.root, { node: fixture.node, electron: options.electron });
    proof.originalStopDiagnostics = diagnostics; proof.sourceTask = task;
    assert.equal(row(diagnostics.canonicalNodeRead).canonicalReleaseCurrent, true);
    assert.equal(row(diagnostics.canonicalNodeRead).proofParseable, true);
    phase = 'quit'; quitRequested = true; proof.quitRequested = true;
    await renderer.evaluate('window.electronAPI.windowControls.close()').catch(() => undefined);
    const quitDeadline = Date.now() + 30_000;
    while (Date.now() < quitDeadline && (app.exitCode === null || groupMembers(group).length || !sourceAbsent())) await tick();
    assert.equal(app.exitCode, 0); assert.equal(app.signalCode, null); assert.deepEqual(groupMembers(group), []);
    assert.equal(sourceAbsent(), true); assert.equal(await portOccupied(), false);
    proof.ordinaryQuit = { requestedOnce: true, exitCode: 0, signalCode: null, originalGroupAbsent: true, listenerAbsent: true, sourcePeerAbsent: true };
    phase = 'freeze';
    const sourceEffects = await readFiniteLegacyEffects(fixture.root);
    assert.equal(sourceEffects.filter(value => value.event === 'bootstrap').length, 1);
    assert.equal(sourceEffects.filter(value => value.event === 'turn-completed').length, 1);
    assert.deepEqual(catalog.failures, []); assert.ok(catalog.requests <= 8);
    proof.sourceEffects = sourceEffects; proof.catalogRequests = catalog.requests;
    const roots = [team, taskRoot, dirname(String(bootstrap.transcriptPath))];
    const absentRoots = [join(fixture.root, 'userData/data/attachments', FINITE_SOURCE_TEAM), join(fixture.root, 'userData/data/task-attachments', FINITE_SOURCE_TEAM)];
    for (const path of absentRoots) await assert.rejects(lstat(path), { code: 'ENOENT' });
    const meta = await json(join(team, 'team.meta.json'));
    const savedSettings = Object.fromEntries(['cwd', 'providerId', 'model', 'effort', 'fastMode', 'prompt', 'skipPermissions', 'syncModelsWithLead', 'limitContext'].filter(key => meta[key] !== undefined).map(key => [key, meta[key]]));
    assert.equal(savedSettings.prompt, FINITE_SOURCE_PROMPT); assert.equal(savedSettings.model, 'claude-sonnet-4-6');
    seed = { sourceKind: 'actual-current-finite-solo', teamName: FINITE_SOURCE_TEAM, sourceTask: task, savedSettings,
      roots, absentRoots, before: await stoppedImportSourceBytes(fixture.root, roots),
      sourceRunId: launch.publicationRunId, sourceSessionId: launch.leadSessionId,
      transcriptPath: bootstrap.transcriptPath };
    proof.source = seed; proof.status = 'PASS';
  } catch (error) {
    proof.failure = error instanceof Error ? error.message.slice(0, 4000) : 'finite source failed'; proof.failurePhase = phase;
    if (cdp) await captureDesktopRendererFailure(cdp, { group, root: fixture.root, screenshotName: 'ui-finite-import-source-failure.png', evidence: proof });
    throw error;
  } finally {
    try {
      observeSource();
      const bootstraps = (await readFiniteLegacyEffects(fixture.root)).filter(value => value.event === 'bootstrap');
      assert.ok(bootstraps.length <= 1);
      if (bootstraps.length) assert.equal(bootstraps[0]!.pid, sourcePid, 'source birth observed before child exit');
    } catch { sourceIdentityUnknown = true; proof.sourceIdentityObservationFailed = true; proof.status = 'INCOMPLETE'; }
    if (cdp && !quitRequested && app.exitCode === null && app.signalCode === null) {
      quitRequested = true; proof.quitRequested = true;
      try { assertOwnedCdpListener(group); await cdp.evaluate('window.electronAPI.windowControls.close()'); } catch { /* Original captured cleanup follows. */ }
    }
    if (cdp) await cdp.close().catch(() => undefined);
    proof.cleanup = await cleanupCapturedDesktopApp({ app, group, fixture, evidence: proof, appIdentity, hostPid: undefined, packedRelaunchMode: false });
    const cleanup = row(proof.cleanup);
    if (cleanup.cleanupFailure || !Array.isArray(cleanup.remaining) || cleanup.remaining.length || !sourceAbsent()) proof.status = 'INCOMPLETE';
    proof.sourcePeerAbsentAfterCleanup = sourceAbsent();
    try {
      assert.equal(await fileDigest(executable.path), executable.sha256);
      assert.equal(await fileDigest(executable.source), executable.sourceSha256);
      assert.deepEqual(await verifyFiniteLegacyCandidates(repo, fixture), candidates);
      assert.deepEqual(catalog.failures, []); proof.inputsFrozen = true;
    } catch (error) { proof.status = 'INCOMPLETE'; proof.freezeFailure = error instanceof Error ? error.message : 'finite source changed'; }
    await catalog.close(); app.stdout.unpipe(log); app.stderr.unpipe(log);
    await new Promise<void>(done => log.end(done));
    await writeFile(receiptPath, JSON.stringify(proof, null, 2), { mode: 0o600, flag: 'wx' });
    assert.equal(proof.status, 'PASS', 'authentic finite producer must finish Stop/Quit and frozen cleanup: ' + JSON.stringify({ phase, failure: proof.failure, freezeFailure: proof.freezeFailure }));
  }
  assert.ok(seed);
  await writeFile(join(fixture.root, 'finite-stopped-import-seed.json'), JSON.stringify({ ...seed,
    producer: { path: receiptPath, sha256: await fileDigest(receiptPath) } }, null, 2), { mode: 0o600, flag: 'wx' });
}
