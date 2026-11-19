import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { command } from './desktop-backend-observations.ts';
import { readFiniteSourceBirth } from './desktop-finite-stopped-import-producer.ts';
import { finiteImportRecords } from './desktop-finite-stopped-import-ui.ts';
import { finiteImportJson as json, finiteImportRow as row } from './desktop-finite-stopped-import-fixture.ts';
import { readDesktopEmulatedRuntimeEffects, verifyDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral as literal, type UiCdpPort } from './desktop-ui-controls.ts';
import { RETAINED_ORIGINAL_KIND, RETAINED_ORIGINAL_MODE, RETAINED_ORIGINAL_TEAM,
  RETAINED_ORIGINAL_PROMPT, RETAINED_ORIGINAL_REPLY, readRetainedOriginalEffects,
  type RetainedOriginalFixture } from './desktop-retained-original-fixture.ts';
export { prepareDesktopRetainedOriginalFixture, closeDesktopRetainedOriginalCatalog, isDesktopRetainedOriginalFixture } from './desktop-retained-original-fixture.ts';

type Row = Record<string, unknown>;
const table = () => execFileSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,pgid=,command='],
  { encoding: 'utf8', timeout: 3000 }).trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line); assert.ok(match);
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4]! };
  });

/** Observe only the exact admitted bootstrap child; missing original birth remains cleanup debt. */
function observeOriginal(fixture: RetainedOriginalFixture, proof: Row, group: number) {
  const prefix = fixture.node + ' ' + fixture.retainedOriginal.executable.path + ' ';
  const processes = table(), matches = processes.filter(value => value.command.startsWith(prefix) && value.command.includes('--team-bootstrap-spec'));
  assert.ok(matches.length <= 1);
  for (const child of matches) {
    const birth = readFiniteSourceBirth(child.pid); assert.ok(birth);
    const ancestry: number[] = []; let parent = child.ppid;
    while (parent !== group && ancestry.length < 64) {
      ancestry.push(parent); const found = processes.find(value => value.pid === parent); assert.ok(found); parent = found.ppid;
    }
    assert.equal(parent, group); ancestry.push(group); assert.equal(child.pgid, child.pid);
    assert.equal(readFiniteSourceBirth(child.pid), birth);
    const captured = proof.liveOriginalChild ? row(proof.liveOriginalChild) : undefined;
    if (captured) { assert.equal(captured.pid, child.pid); assert.equal(captured.startIdentity, birth); }
    else proof.liveOriginalChild = { ...child, startIdentity: birth, ancestry };
  }
}

function originalAbsent(fixture: RetainedOriginalFixture, proof: Row): boolean {
  const prefix = fixture.node + ' ' + fixture.retainedOriginal.executable.path + ' ';
  const captured = proof.liveOriginalChild ? row(proof.liveOriginalChild) : undefined;
  return proof.sourceIdentityObservationFailed !== true &&
    (!captured || readFiniteSourceBirth(Number(captured.pid)) !== captured.startIdentity) &&
    !table().some(value => value.command.startsWith(prefix));
}

/** Existing visible choice, captured private status/catalog, one original Launch and one original Stop. */
export async function runDesktopRetainedOriginalUi(cdp: UiCdpPort, options: {
  fixture: RetainedOriginalFixture; evidence: Row; group: number; electron: string; assertOwnedRenderer(): void;
}) {
  const { fixture } = options, { seed, catalog, executable } = fixture.retainedOriginal;
  assert.equal(process.env.LEGACY_DESKTOP_PROOF_MODE, RETAINED_ORIGINAL_MODE);
  const steps: Row[] = [], proof: Row = { status: 'INCOMPLETE', sourceKind: RETAINED_ORIGINAL_KIND,
    execution: 'finite-legacy-launch-protocol', hostDescriptorPresent: true, steps,
    seedSha256: fixture.retainedOriginal.seedSha256, executable,
    scope: 'Explicit original runtime choice with Host selected, original account/model readiness, solo finite Launch, visible reply, original Main Stop and physical cleanup',
    excluded: ['genuine historical donor frontend', 'vendor CLI/inference/auth qualification', 'multi-member or Windows source release', 'native source session adoption'],
    capturedAppGroup: options.group };
  options.evidence.retainedOriginalUiProof = proof;
  const team = join(fixture.root, 'claude/teams', RETAINED_ORIGINAL_TEAM);
  const assertOriginal = () => {
    options.assertOwnedRenderer(); assert.deepEqual(catalog.failures, []); observeOriginal(fixture, proof, options.group);
  };
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: assertOriginal, step: value => steps.push(value) });
  const poll = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string) => {
    const deadline = Date.now() + 90_000;
    for (;;) { assertOriginal(); const value = await read(); assertOriginal();
      assert.ok(Date.now() < deadline, label + '; original action is never repeated'); if (accepts(value)) return value;
      await new Promise<void>(done => setTimeout(done, 100)); }
  };
  const optionalJson = (path: string) => json(path).catch((error: NodeJS.ErrnoException): Row => {
    if (error.code === 'ENOENT') return {}; throw error;
  });
  const screenshot = async (name: string) => {
    const value = row(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
    const path = join(fixture.root, name); await writeFile(path, Buffer.from(String(value.data), 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  const assertNoHostLaunch = async () => {
    assert.deepEqual(await finiteImportRecords(join(fixture.root, 'hoststore/.host-team-registry/imports'), true), []);
    assert.deepEqual((await readDesktopEmulatedRuntimeEffects(fixture)).filter(value => value.event === 'input'), []);
  };
  for (const record of seed.before) assert.equal(await fileDigest(record.path), record.sha256);
  for (const name of seed.absent) await assert.rejects(lstat(join(team, name)), { code: 'ENOENT' });
  await assertNoHostLaunch();
  await ui.observeInput();
  await ui.click('button[aria-label="More actions"]', 'open original More menu');
  await ui.click('button', 'open original Teams', 'Teams');
  const card = '.team-row-zebra-card[data-team-name=' + literal(RETAINED_ORIGINAL_TEAM) + ']';
  await ui.scrollTo(card, 'explicit TEST legacy archive card'); await ui.click(card, 'open explicit TEST legacy archive');
  await ui.waitRead(`Boolean(document.querySelector('button[aria-label="Edit team"]'))`, 'original stopped Team detail');
  await ui.scrollTo('button', 'original detail Launch', 'Launch'); await ui.click('button', 'open original detail Launch once', 'Launch');
  await ui.waitRead(`document.body.innerText.includes('Use the original runtime?')`, 'visible explicit original runtime choice');
  proof.choiceScreenshot = await screenshot('ui-retained-original-choice.png');
  assert.equal((await readRetainedOriginalEffects(fixture.root)).filter(value => value.event === 'bootstrap').length, 0);
  for (const name of seed.absent) await assert.rejects(lstat(join(team, name)), { code: 'ENOENT' });
  await assertNoHostLaunch();
  await ui.click('button', 'choose original runtime explicitly once', 'Use original runtime for this team');
  await ui.waitRead(`document.querySelector('[data-testid="original-runtime-project"]')?.innerText.includes('Original runtime for this team')`, 'captured original runtime banner');
  await ui.waitRead(`document.querySelector('[data-testid="original-runtime-project"]')?.innerText.includes(${literal(seed.workspace)})`, 'captured original project');
  const optional = row(await ui.waitRead(`(()=>{const e=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')].find(e=>e.textContent.includes('Optional launch settings'));return e?{id:e.getAttribute('aria-controls'),expanded:e.getAttribute('aria-expanded')}:null})()`, 'original launch settings'));
  if (optional.expanded !== 'true') await ui.click('[role="dialog"] button[aria-controls=' + literal(optional.id) + ']', 'expand original launch settings');
  await ui.waitRead(`document.querySelector('[role="dialog"] #dialog-prompt')?.value===${literal(RETAINED_ORIGINAL_PROMPT)}`, 'saved original prompt');
  await ui.waitRead(`document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')==='unchecked'`, 'original permissions');
  await ui.waitRead(`[...document.querySelectorAll('[role="dialog"] button[aria-label*=" provider,"]')].some(e=>e.textContent.trim()==='Sonnet 4.6')`, 'original private model');
  await ui.waitRead(`document.querySelector('[role="dialog"]')?.innerText.includes('All selected providers are ready')`, 'original private account and provider readiness', 90_000);
  const reads = await readRetainedOriginalEffects(fixture.root);
  assert.ok(reads.some(value => value.event === 'metadata-control' && value.operation === 'runtime'));
  assert.ok(reads.some(value => value.event === 'metadata-control' && value.operation === 'model'));
  assert.ok(reads.every(value => value.event !== 'bootstrap' && value.event !== 'turn-completed'));
  proof.originalReadEffects = reads; proof.readyScreenshot = await screenshot('ui-retained-original-ready.png');
  await assertNoHostLaunch();
  await ui.scrollTo('[role="dialog"] button', 'original scoped Launch', 'Launch team');
  await ui.click('[role="dialog"] button', 'submit original scoped Launch exactly once', 'Launch team');
  await ui.waitRead(`!document.querySelector('[role="dialog"] #dialog-prompt')`, 'original scoped Launch accepted', 90_000);
  const launch = await poll(() => optionalJson(join(team, 'launch-state.json')),
    value => value.version === 2 && typeof value.publicationRunId === 'string' && typeof value.leadSessionId === 'string', 'original Main publication');
  const effects = await poll(() => readRetainedOriginalEffects(fixture.root), values => values.some(value => value.event === 'turn-completed'), 'finite original reply');
  const starts = effects.filter(value => value.event === 'bootstrap'), turns = effects.filter(value => value.event === 'turn-completed');
  assert.equal(starts.length, 1); assert.equal(turns.length, 1);
  const bootstrap = starts[0]!, child = row(proof.liveOriginalChild);
  assert.equal(bootstrap.pid, child.pid); assert.equal(bootstrap.parentPid, child.ppid); assert.equal(bootstrap.mainOwnerPid, child.ppid);
  const main = command(Number(child.ppid)); assert.ok((main === options.electron || main.startsWith(options.electron + ' ')) && !main.includes('--type='));
  assert.equal(bootstrap.runId, launch.publicationRunId); assert.equal(bootstrap.sessionId, launch.leadSessionId);
  assert.equal(bootstrap.previousSessionId, seed.config.leadSessionId); assert.notEqual(bootstrap.sessionId, seed.config.leadSessionId);
  assert.equal(turns[0]!.prompt, RETAINED_ORIGINAL_PROMPT); assert.equal(turns[0]!.reply, RETAINED_ORIGINAL_REPLY);
  await ui.click('button[aria-label^="lead,"]', 'open original lead conversation');
  await ui.waitRead(`document.body.innerText.includes(${literal(RETAINED_ORIGINAL_REPLY)})`, 'finite original reply visible', 90_000);
  proof.replyScreenshot = await screenshot('ui-retained-original-reply.png');
  assert.equal(readFiniteSourceBirth(Number(child.pid)), child.startIdentity, 'original peer remains alive until Main Stop');
  await ui.click('button[aria-label="Stop"]', 'original Main Stop exactly once');
  const stopped = await poll(() => optionalJson(join(team, 'launch-stopped.json')), value => value.nativeRelease !== undefined, 'original Main Stop release');
  const release = row(stopped.nativeRelease), target = row(release.target);
  assert.equal(target.teamName, RETAINED_ORIGINAL_TEAM); assert.equal(target.runId, launch.publicationRunId);
  assert.equal(target.sessionId, launch.leadSessionId); assert.equal(target.rootPid, child.pid);
  assert.equal(row(release.process).rootStartIdentity, child.startIdentity);
  await poll(async () => originalAbsent(fixture, proof), value => value, 'original peer physically absent');
  await assertNoHostLaunch();
  proof.stoppedScreenshot = await screenshot('ui-retained-original-stopped.png');
  Object.assign(proof, { status: 'PASS', originalLaunch: launch, originalStopped: stopped,
    bootstrap, turn: turns[0], catalogRequests: catalog.requests,
    stop: { peerAbsent: true, releasedBeforeQuit: true }, hostBusinessInputs: 0, hostImports: 0 });
}

/** Runs after the existing app cleanup, retaining unknown birth/disposal rather than inventing absence. */
export async function finishDesktopRetainedOriginalCleanup(repo: string, fixture: RetainedOriginalFixture, evidence: Row) {
  const proof = evidence.retainedOriginalUiProof ? row(evidence.retainedOriginalUiProof) : { status: 'INCOMPLETE' };
  evidence.retainedOriginalUiProof = proof;
  try {
    const effects = await readRetainedOriginalEffects(fixture.root), starts = effects.filter(value => value.event === 'bootstrap');
    assert.ok(starts.length <= 1);
    if (starts.length) assert.equal(starts[0]!.pid, row(proof.liveOriginalChild).pid, 'original child birth must have been observed');
    assert.equal(originalAbsent(fixture, proof), true);
    const input = fixture.retainedOriginal;
    for (const [path, sha256] of [[input.seedPath, input.seedSha256], [input.executable.path, input.executable.sha256], [input.executable.source, input.executable.sourceSha256]])
      assert.equal(await fileDigest(path!), sha256);
    const { verifyFiniteLegacyCandidates } = await import('./desktop-finite-stopped-import-fixture.ts');
    assert.deepEqual(await verifyFiniteLegacyCandidates(repo, fixture), input.candidates);
    assert.deepEqual(input.catalog.failures, []);
    Object.assign(proof, { sourceEffects: effects, peerAbsentAfterCleanup: true, inputsFrozen: true,
      fixturePins: await verifyDesktopEmulatedRuntimeFixture(fixture) });
  } catch (error) {
    proof.status = 'INCOMPLETE'; evidence.status = 'INCOMPLETE'; proof.sourceIdentityObservationFailed = true;
    proof.cleanupFailure = error instanceof Error ? error.message : 'original cleanup unknown';
  }
}
