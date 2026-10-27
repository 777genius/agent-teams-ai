import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { digest, fileDigest } from './desktop-backend-fixture.ts';
import {
  assertOwnedCdpListener,
  command,
  compiledBundleHashes,
  portOccupied,
  processTable,
  readRendererBackendConnections,
} from './desktop-backend-observations.ts';
import { bounded } from './desktop-proof-bounds.ts';
import { connectCapturedDesktopApp } from './desktop-captured-app.ts';
import { openOriginalCreateForm } from './desktop-create-config-ui-smoke.ts';
import {
  ownerRoutingJson as json,
  ownerRoutingRow as row,
  prepareDesktopOwnerRoutingContinuation,
} from './desktop-owner-routing-fixture.ts';
import { verifyDesktopSourceFreeze } from './desktop-source-freeze.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import { finishDesktopOwnerRoutingEpoch } from './desktop-owner-routing-epoch.ts';

import type { DesktopCdpLibrary, DesktopCdpPort } from './desktop-captured-app.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { OwnerRoutingRow as Row } from './desktop-owner-routing-fixture.ts';

type Fixture = Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
export interface DesktopOwnerRoutingContinuation {
  fixture: Fixture;
  repo: string;
  invocation: string[];
  cdpLibrary: DesktopCdpLibrary;
  evidence: Row;
  receiptPath: string;
  frozenSources: readonly string[];
  selectedSourceHashes: readonly { path: string; sha256: string }[];
}
const teamA = 'test-desktop-backend';
const teamB = 'test-owner-routing-b';
const pause = () => new Promise<void>((done) => setTimeout(done, 100));

/** Three finite cold epochs after the original Taskboard epoch has fully cleaned up. */
export async function runDesktopOwnerRoutingContinuation(
  context: DesktopOwnerRoutingContinuation
): Promise<void> {
  const { fixture, evidence, receiptPath } = context;
  assert.equal(evidence.mode, 'task-board-cross-team-ui');
  assert.equal(evidence.status, 'PASS');
  const originalReceipt = await readFile(receiptPath);
  const proof: Row = { status: 'INCOMPLETE', epochs: [] };
  evidence.ownerDefaultRoutingProof = proof;
  evidence.status = 'INCOMPLETE';
  const save = () => writeFile(receiptPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  await save();
  assert.deepEqual(row(evidence.cleanup).remaining, []);
  assert.equal(await portOccupied(), false);
  assert.ok(context.invocation.length >= 2);
  const prepared = await prepareDesktopOwnerRoutingContinuation(fixture);
  const { proofRoot, bRoot } = prepared;
  await writeFile(join(proofRoot, 'original-epoch-receipt.json'), originalReceipt, {
    flag: 'wx',
    mode: 0o600,
  });
  const sourceDiscovery = row(evidence.discovery);
  const aPublic = row(
    (sourceDiscovery.bindings as unknown[]).find(
      (value) => row(row(value).handle).handleId === fixture.handleId
    )
  );
  const aHandle = structuredClone(row(aPublic.handle));
  assert.deepEqual(aHandle, { handleId: fixture.handleId });
  const bindingDirectory = join(fixture.root, 'userData/agent-backend/bindings');
  const aBindingPath = join(bindingDirectory, digest(fixture.handleId) + '.json');
  const aBindingBytes = await readFile(aBindingPath);
  const aBinding = row(JSON.parse(aBindingBytes.toString('utf8')));
  assert.equal(aBinding.handleId, fixture.handleId);
  const epochs = proof.epochs as Row[];
  Object.assign(proof, {
    status: 'INCOMPLETE',
    scope:
      'Original A epoch, clean default/creation B configuration, original A Task Create and unbound save-only B Create, original A handle refusal with its real profile path unavailable, clean rollback preserving both published handles',
    originalReceipt: {
      path: join(proofRoot, 'original-epoch-receipt.json'),
      sha256: digest(originalReceipt),
    },
    aPublicBinding: aPublic,
    aStoredBinding: { path: aBindingPath, sha256: digest(aBindingBytes), value: aBinding },
    bRoot,
    originalDescriptor: {
      path: join(proofRoot, 'original-descriptor.json'),
      sha256: digest(prepared.originalDescriptorBytes),
    },
    originalAProfile: {
      path: join(proofRoot, 'original-owner-a-profile.json'),
      sha256: fixture.pins.profileSha256,
    },
    bProfile: {
      path: prepared.bProfilePath,
      retainedPath: join(proofRoot, 'owner-b-profile.json'),
      sha256: prepared.bProfileSha256,
    },
    selectionBoundary:
      'Cold trusted descriptor changes both defaultOwner and explicit creation.owner; neither an in-process switch nor a claim that defaultOwner alone chooses unbound creation. The original model Default control is separate.',
    epochs,
    budgetMs: 12 * 60_000,
    budgetScope:
      'nonrenewable continuation bound within the unchanged 45-minute existing job; original cold startup/action bounds are not increased',
    excluded: [
      'in-process preference setter',
      'native allocation or inference',
      'provider authentication',
      'original UNKNOWN debt release',
      'full F08/M18/Stage1',
    ],
  });
  await save();
  const initialSentinel = await readFile(fixture.sentinelLog, 'utf8');
  const sentinel = async (label: string) => {
    const bytes = await readFile(fixture.sentinelLog, 'utf8');
    assert.ok(bytes.startsWith(initialSentinel), 'original sentinel evidence is retained');
    const rows = bytes
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => row(JSON.parse(line)));
    assert.ok(rows.length <= 1024);
    assert.ok(
      rows.every((entry) => entry.allowed === true),
      'no legacy agent/control invocation in owner continuation'
    );
    const path = join(proofRoot, label + '-sentinel.ndjson');
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return { path, sha256: digest(bytes), invocations: rows };
  };
  const deadline = Date.now() + 12 * 60_000;
  const assertBudget = () =>
    assert.ok(
      Date.now() < deadline,
      'finite owner-routing continuation exhausted; no action retry'
    );
  const assertSources = async () => {
    await verifyDesktopSourceFreeze(
      context.repo,
      context.frozenSources,
      context.selectedSourceHashes,
      evidence
    );
    assert.equal(evidence.sourceFreezeFailure, undefined);
    assert.equal(await fileDigest(fixture.node), fixture.pins.nodeSha256);
    assert.equal(await fileDigest(fixture.hostEntry), fixture.pins.hostEntrySha256);
    assert.equal(await fileDigest(prepared.bProfilePath), prepared.bProfileSha256);
  };
  const absent = async (path: string) => {
    try {
      await lstat(path);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  };
  const assertLeasesReleased = async () => {
    for (const root of [fixture.root, bRoot])
      assert.equal(
        await absent(join(root, 'hoststore/.legacy-agent-host-writer.lock')),
        true,
        'original owner writer released before next configuration epoch'
      );
  };
  const snapshot = async (label: string, root: string) => {
    const source = join(root, 'hoststore');
    const destination = join(proofRoot, label);
    await mkdir(destination, { mode: 0o700 });
    const entries = await readdir(source, { recursive: true, withFileTypes: true });
    assert.ok(entries.length <= 2048, 'bounded offline owner product census');
    const files: { path: string; sha256: string; sizeBytes: number }[] = [];
    for (const entry of entries) {
      assert.ok(!entry.isSymbolicLink());
      if (!entry.isFile() || entry.name === '.legacy-agent-host-writer.lock') continue;
      const path = join(entry.parentPath, entry.name);
      assert.ok(path.startsWith(source + '/'));
      const relative = path.slice(source.length + 1);
      const bytes = await readFile(path);
      assert.ok(bytes.length <= 1024 * 1024);
      const target = join(destination, relative);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      files.push({ path: relative, sha256: digest(bytes), sizeBytes: bytes.length });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const manifestPath = join(proofRoot, label + '.json');
    await writeFile(manifestPath, JSON.stringify(files, null, 2), { flag: 'wx', mode: 0o600 });
    return { directory: destination, manifestPath, sha256: await fileDigest(manifestPath), files };
  };
  const bindingSnapshot = async (label: string) => {
    assert.deepEqual(
      await readFile(aBindingPath),
      aBindingBytes,
      'original A binding bytes are never rebound'
    );
    const directory = join(proofRoot, label + '-bindings');
    await mkdir(directory, { mode: 0o700 });
    const names = (await readdir(bindingDirectory))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort();
    assert.ok(names.length <= 16);
    const files = [];
    for (const name of names) {
      const bytes = await readFile(join(bindingDirectory, name));
      await writeFile(join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
      files.push({ name, sha256: digest(bytes) });
    }
    return { directory, files };
  };
  const receipts = async (root: string, team: string) => {
    const directory = join(root, 'hoststore/teams', team, '.host-owner/commands');
    if (await absent(directory)) return [];
    const names = (await readdir(directory))
      .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
      .sort();
    assert.ok(names.length <= 256);
    return Promise.all(
      names.map(async (name) => ({
        name,
        bytes: await readFile(join(directory, name)),
        value: await json(join(directory, name)),
      }))
    );
  };
  const originalCommands = await receipts(fixture.root, teamA);
  const unchangedOriginalCommands = async () => {
    const after = await receipts(fixture.root, teamA);
    for (const original of originalCommands)
      assert.deepEqual(
        after.find((entry) => entry.name === original.name)?.bytes,
        original.bytes,
        'all earlier original Taskboard command bytes retained'
      );
  };
  proof.originalAProduct = await snapshot('original-a-product', fixture.root);
  proof.originalBindings = await bindingSnapshot('original');
  let bHandle: Row | undefined;
  let bPublic: Row | undefined;
  let bBindingBytes: Buffer | undefined;
  let bBindingPath: string | undefined;
  let publishedB: Row | undefined;
  const withheld = join(proofRoot, 'owner-a-withheld-profile.json');
  try {
    await assertLeasesReleased();
    for (const phase of ['default-b', 'unavailable-a', 'rollback-a'] as const) {
      assertBudget();
      assert.ok(
        deadline - Date.now() >= 180_000,
        'remaining budget must cover the existing cold startup bound'
      );
      await assertLeasesReleased();
      assert.equal(await portOccupied(), false);
      await assertSources();
      if (phase === 'unavailable-a') {
        assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
        await rename(fixture.profilePath, withheld);
        assert.equal(await absent(fixture.profilePath), true);
      }
      if (phase === 'rollback-a') {
        assert.equal(await absent(fixture.profilePath), true);
        assert.equal(await fileDigest(withheld), fixture.pins.profileSha256);
        await rename(withheld, fixture.profilePath);
        assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
      }
      let descriptor: Row = prepared.switched;
      if (phase === 'rollback-a') {
        assert.ok(publishedB && bHandle && bBindingBytes && bBindingPath);
        const record = row(publishedB.record);
        descriptor = {
          ...prepared.switched,
          defaultOwner: structuredClone(prepared.descriptor.defaultOwner),
          creation: structuredClone(prepared.descriptor.creation),
          handles: [
            ...(prepared.descriptor.handles as unknown[]),
            {
              handleId: row(record.binding).handleId,
              owner: { ownerId: prepared.bOwner.ownerId, revision: prepared.bOwner.revision },
              contextId: record.contextId,
              label: record.displayName || record.teamName,
              members: record.members,
              scope: row(record.binding).scope,
            },
          ],
        };
      }
      const generation = await prepared.install(phase, descriptor);
      const epoch: Row = {
        phase,
        status: 'INCOMPLETE',
        descriptor: { path: generation.path, sha256: generation.sha256 },
        startedAtMs: Date.now(),
        aProfile: {
          path: fixture.profilePath,
          present: (await absent(fixture.profilePath)) === false,
          ...(phase === 'unavailable-a'
            ? { withheldPath: withheld, withheldSha256: await fileDigest(withheld) }
            : { sha256: await fileDigest(fixture.profilePath) }),
        },
        bProfile: { path: prepared.bProfilePath, sha256: await fileDigest(prepared.bProfilePath) },
      };
      epochs.push(epoch);
      await save();
      const logPath = join(fixture.root, 'owner-routing-' + phase + '.log');
      const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
      const app = spawn(context.invocation[0]!, context.invocation.slice(1), {
        cwd: context.repo,
        env: generation.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      const group = app.pid ?? 0;
      let spawnError = false;
      app.once('error', () => {
        spawnError = true;
      });
      app.stdout.pipe(log, { end: false });
      app.stderr.pipe(log, { end: false });
      let appIdentity = '';
      let cdp: DesktopCdpPort | undefined;
      let active = true;
      let flowSucceeded = false;
      const assertOwned = () => {
        assert.ok(active);
        assertOwnedCdpListener(group);
      };
      const assertCurrent = () => {
        assertBudget();
        assertOwned();
      };
      try {
        epoch.app = {
          pid: app.pid,
          processGroup: group,
          identity: null,
          invocation: context.invocation,
          logPath,
        };
        assert.ok(group > 0);
        appIdentity = execFileSync('/bin/ps', ['-p', String(group), '-o', 'lstart=,command='], {
          encoding: 'utf8',
          timeout: 3000,
        }).trim();
        row(epoch.app).identity = appIdentity;
        const connected = await connectCapturedDesktopApp({
          app,
          group,
          spawnError: () => spawnError,
          packed: undefined,
          cdpLibrary: context.cdpLibrary,
          evidence: epoch,
        });
        cdp = connected.cdp;
        assertCurrent();
        epoch.compiledBundleHashes = await compiledBundleHashes(
          join(context.repo, 'dist-electron')
        );
        const steps: Row[] = [];
        epoch.steps = steps;
        const ui = createDesktopUiControls(cdp, {
          assertOwnedRenderer: assertCurrent,
          step: (value) => steps.push({ monotonicMs: Math.round(performance.now()), ...value }),
        });
        await ui.observeInput();
        const discoveryDeadline = Math.min(deadline, Date.now() + 60_000);
        let discovery: Row | undefined;
        for (;;) {
          assertCurrent();
          assert.ok(Date.now() < discoveryDeadline, 'initial original backend handler observation');
          try {
            const observed = await readRendererBackendConnections(
              cdp,
              discoveryDeadline - Date.now()
            );
            if (observed.kind === 'pending') {
              await pause();
              continue;
            }
            discovery = row(observed.value);
            break;
          } catch (error) {
            assert.equal(phase, 'unavailable-a');
            epoch.discoveryLimitation = {
              unavailable: true,
              message: error instanceof Error ? error.message.slice(0, 1000) : 'unavailable',
            };
            break;
          }
        }
        epoch.discovery = discovery;
        if (phase !== 'unavailable-a') {
          assert.equal(discovery?.state, 'ready');
          const bindings = discovery!.bindings as unknown[];
          assert.deepEqual(
            row(bindings.find((value) => row(row(value).handle).handleId === fixture.handleId)),
            aPublic
          );
          if (phase === 'rollback-a') {
            assert.deepEqual(
              row(
                bindings.find((value) => row(row(value).handle).handleId === row(bHandle).handleId)
              ),
              bPublic
            );
            assert.deepEqual(await readFile(bBindingPath!), bBindingBytes);
          }
        }
        const select = async (handle: Row) => {
          const selection = hostTeamSelectionKey(String(handle.handleId));
          await ui.click('button[aria-label="More actions"]', 'open original application menu');
          await ui.click('button', 'open original Teams list', 'Teams');
          const selector = '[data-team-name=' + JSON.stringify(selection) + ']';
          await ui.scrollTo(selector, 'original owner-qualified Team card');
          await ui.click(selector, 'open exact original Team card');
          await ui.waitRead(
            'window.__agentTeamsDevStore?.getState().selectedTeamName===' +
              desktopJsLiteral(selection) +
              '&&!window.__agentTeamsDevStore?.getState().selectedTeamLoading',
            'original selected owner-qualified Team'
          );
        };
        const createTask = async (handle: Row, root: string, team: string, subject: string) => {
          const before = await receipts(root, team);
          await select(handle);
          await ui.click('button', 'original Create Task control', 'Task');
          await ui.waitRead(
            `Boolean(document.querySelector('[role="dialog"] #task-subject'))`,
            'original Create Task form'
          );
          await ui.click('[role="dialog"] #task-subject', 'original Task subject');
          await cdp!.send('Input.insertText', { text: subject });
          await ui.waitRead(
            `document.querySelector('[role="dialog"] #task-subject')?.value===` +
              desktopJsLiteral(subject),
            'original Task subject retained'
          );
          await ui.click('[role="dialog"] button', 'original Task Create exactly once', 'Create');
          await ui.waitRead(
            `!document.querySelector('[role="dialog"] #task-subject')`,
            'original Task Create completed'
          );
          const after = await receipts(root, team);
          for (const original of before)
            assert.deepEqual(
              after.find((entry) => entry.name === original.name)?.bytes,
              original.bytes
            );
          const added = after.filter(
            (entry) => !before.some((entryBefore) => entryBefore.name === entry.name)
          );
          assert.equal(added.length, 1, 'one original Task command/effect');
          const receipt = added[0]!.value;
          assert.equal(receipt.phase, 'completed');
          assert.equal(receipt.principalId, 'TEST-human');
          assert.equal(row(receipt.command).operation, 'task.create');
          assert.equal(row(row(receipt.command).payload).subject, subject);
          const taskId = String(row(receipt.effects).taskId);
          const task = await json(join(root, 'hoststore/tasks', team, taskId + '.json'));
          assert.equal(task.id, taskId);
          assert.equal(task.subject, subject);
          assert.equal(task.status, 'pending');
          assert.equal(row(receipt.result).id, taskId);
          return { handle: structuredClone(handle), receipt, task };
        };
        if (phase === 'default-b') {
          const bBefore = await snapshot('default-b-before-a-mutation', bRoot);
          epoch.aMutation = await createTask(
            aHandle,
            fixture.root,
            teamA,
            'TEST A Task under default B'
          );
          const bAfter = await snapshot('default-b-after-a-mutation', bRoot);
          assert.deepEqual(bAfter.files, bBefore.files, 'new original A mutation cannot affect B');
          const aBeforeBCreate = await snapshot('default-b-before-b-create-a', fixture.root);
          await openOriginalCreateForm(cdp, ui, join(fixture.root, 'workspace'), teamB);
          await ui.scrollTo('[role="dialog"] #launch-team', 'original save-only selection');
          assert.equal(
            await cdp.evaluate(
              `document.querySelector('[role="dialog"] #launch-team')?.getAttribute('data-state')`
            ),
            'checked'
          );
          await ui.click('[role="dialog"] #launch-team', 'disable original Run after Create');
          await ui.waitRead(
            `document.querySelector('[role="dialog"] #launch-team')?.getAttribute('data-state')==='unchecked'`,
            'original save-only retained'
          );
          const provider = '[role="dialog"] button[aria-label*=" provider,"]';
          await ui.scrollTo(provider, 'original Anthropic model selector');
          if (
            !(await cdp.evaluate(
              `Boolean(document.querySelector('[role="dialog"] [data-testid="team-model-selector-model-option"]'))`
            ))
          )
            await ui.click(provider, 'expand original model selector');
          const defaultOption =
            '[role="dialog"] [data-testid="team-model-selector-model-option"][aria-label^="Default"]';
          await ui.scrollTo(defaultOption, 'original inherited Default model');
          await ui.click(defaultOption, 'save original Default without native readiness');
          await ui.scrollTo('[role="dialog"] button', 'original save-only Create', 'Create');
          await ui.click('[role="dialog"] button', 'original unbound Team Create once', 'Create');
          await ui.waitRead(
            `!document.querySelector('[role="dialog"] #team-name')`,
            'original save-only Create completed'
          );
          const directory = join(bRoot, 'hoststore/.host-team-registry/records');
          const names = (await readdir(directory)).filter((name) =>
            /^[a-f0-9]{64}\.json$/.test(name)
          );
          assert.equal(names.length, 1);
          publishedB = await json(join(directory, names[0]!));
          assert.equal(publishedB.phase, 'published');
          assert.equal(row(publishedB.record).teamName, teamB);
          const actual = row(row(publishedB.record).binding);
          const discovered = row(
            await cdp.evaluate('window.electronAPI.agentBackend.getConnections()')
          );
          assert.equal(discovered.state, 'ready');
          bPublic = row(
            (discovered.bindings as unknown[]).find(
              (value) => row(row(value).handle).handleId === actual.handleId
            )
          );
          bHandle = structuredClone(row(bPublic.handle));
          assert.equal(
            bHandle.handleId,
            actual.handleId,
            'reuse the actual published/publicly returned B handle'
          );
          assert.notEqual(bPublic.ownerResourceRef, aPublic.ownerResourceRef);
          bBindingPath = join(bindingDirectory, digest(String(bHandle.handleId)) + '.json');
          bBindingBytes = await readFile(bBindingPath);
          const storedB = row(JSON.parse(bBindingBytes.toString('utf8')));
          assert.deepEqual(storedB.scope, actual.scope);
          assert.equal(row(storedB.owner).storageRoot, join(bRoot, 'hoststore'));
          assert.equal(row(storedB.owner).ownerId, prepared.bOwner.ownerId);
          assert.deepEqual(await readFile(aBindingPath), aBindingBytes);
          const aAfterBCreate = await snapshot('default-b-after-b-create-a', fixture.root);
          assert.deepEqual(
            aAfterBCreate.files,
            aBeforeBCreate.files,
            'original unbound B Create cannot affect A'
          );
          epoch.aPreservedThroughBCreate = { before: aBeforeBCreate, after: aAfterBCreate };
          epoch.bCreation = {
            rawRegistryPath: join(directory, names[0]!),
            published: publishedB,
            publicBinding: bPublic,
            storedBindingPath: bBindingPath,
            storedBindingSha256: digest(bBindingBytes),
            storedBinding: storedB,
          };
          proof.publishedB = epoch.bCreation;
          assert.equal(
            await absent(join(fixture.root, 'hoststore/teams', teamB)),
            true,
            'B Create has no A Team namespace'
          );
        } else if (phase === 'unavailable-a') {
          assert.ok(bHandle && bBindingBytes && bBindingPath);
          assert.equal(await absent(fixture.profilePath), true);
          const beforeA = await snapshot('unavailable-a-before-a', fixture.root);
          const beforeB = await snapshot('unavailable-a-before-b', bRoot);
          const commandId = 'TEST-unavailable-a-' + randomUUID();
          const request = {
            handle: aHandle,
            commandId,
            operation: 'task.create',
            payload: { subject: 'TEST unavailable original A command must not reach B' },
          };
          assertCurrent();
          const result = row(
            await cdp.evaluate(
              'window.electronAPI.agentBackend.invoke(' + desktopJsLiteral(request) + ')'
            )
          );
          assert.equal(result.ok, false);
          assert.ok(
            ['unavailable', 'hold'].includes(String(result.code)),
            'actual original-owner startup refusal, not malformed/unauthorized request'
          );
          assert.ok(['not-dispatched', 'unknown'].includes(String(result.outcome)));
          const afterA = await snapshot('unavailable-a-after-a', fixture.root);
          const afterB = await snapshot('unavailable-a-after-b', bRoot);
          assert.deepEqual(afterA.files, beforeA.files);
          assert.deepEqual(
            afterB.files,
            beforeB.files,
            'B receives no effect or command for unavailable A'
          );
          assert.deepEqual(await readFile(bBindingPath), bBindingBytes);
          epoch.originalHandleRefusal = {
            request,
            result,
            beforeA,
            afterA,
            beforeB,
            afterB,
            noRetry: true,
          };
        } else {
          assert.ok(bHandle && bBindingBytes && bBindingPath);
          const bBefore = await snapshot('rollback-before-a-mutation-b', bRoot);
          epoch.aMutation = await createTask(
            aHandle,
            fixture.root,
            teamA,
            'TEST A Task after owner rollback'
          );
          const bAfter = await snapshot('rollback-after-a-mutation-b', bRoot);
          assert.deepEqual(bAfter.files, bBefore.files);
          const aBefore = await snapshot('rollback-before-b-mutation-a', fixture.root);
          epoch.bMutation = await createTask(
            bHandle,
            bRoot,
            teamB,
            'TEST B Task after owner rollback'
          );
          const aAfter = await snapshot('rollback-after-b-mutation-a', fixture.root);
          assert.deepEqual(aAfter.files, aBefore.files);
          epoch.otherOwnerPreserved = { bBefore, bAfter, aBefore, aAfter };
          assert.deepEqual(
            await readFile(bBindingPath),
            bBindingBytes,
            'rollback preserves original B bytes without reconstruction'
          );
        }
        await unchangedOriginalCommands();
        epoch.bindings = await bindingSnapshot(phase);
        epoch.aProduct = await snapshot(phase + '-a-product', fixture.root);
        epoch.bProduct = await snapshot(phase + '-b-product', bRoot);
        const table = processTable();
        const hosts = table.filter(
          (entry) =>
            entry.pgid === group && command(entry.pid) === fixture.node + ' ' + fixture.hostEntry
        );
        assert.equal(
          hosts.length,
          phase === 'unavailable-a' ? 1 : 2,
          'exact separate captured offline Hosts in this epoch'
        );
        for (const host of hosts)
          assert.equal(
            table.filter((entry) => entry.ppid === host.pid).length,
            0,
            'offline owners allocate no native child'
          );
        epoch.hostsBeforeQuit = hosts;
        epoch.preQuitSentinel = await sentinel(phase + '-before-quit');
        flowSucceeded = true;
      } catch (error) {
        epoch.failure =
          error instanceof Error ? error.message.slice(0, 4000) : 'original epoch failure';
        if (cdp) {
          try {
            assertOwned();
            const image = row(
              await bounded(
                cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
                5000,
                'original owner epoch failure screenshot'
              )
            );
            assert.equal(typeof image.data, 'string');
            const path = join(fixture.root, 'owner-routing-' + phase + '-failure.png');
            await writeFile(path, Buffer.from(String(image.data), 'base64'), {
              flag: 'wx',
              mode: 0o600,
            });
            epoch.failureScreenshot = { path, sha256: await fileDigest(path) };
          } catch {
            epoch.failureScreenshotUnavailable = true;
          }
        }
        throw error;
      } finally {
        try {
          const retainedHosts =
            (epoch.hostsBeforeQuit as { pid: number }[] | undefined) ??
            processTable().filter(
              (entry) =>
                entry.pgid === group &&
                command(entry.pid) === fixture.node + ' ' + fixture.hostEntry
            );
          await finishDesktopOwnerRoutingEpoch({
            app,
            group,
            appIdentity,
            cdp,
            hosts: retainedHosts,
            epoch,
            assertOwned,
          });
          active = false;
          await assertLeasesReleased();
          epoch.finalSentinel = await sentinel(phase + '-after-quit');
          if (flowSucceeded) epoch.status = 'PASS';
        } finally {
          active = false;
          app.stdout.unpipe(log);
          app.stderr.unpipe(log);
          app.stdout.resume();
          app.stderr.resume();
          await bounded(
            new Promise<void>((done) => log.end(done)),
            3000,
            'close owner-routing epoch log'
          );
          try {
            await assertSources();
          } finally {
            await save();
          }
        }
      }
      assert.equal(epoch.status, 'PASS');
    }
    assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
    assert.ok(bBindingPath && bBindingBytes);
    assert.deepEqual(await readFile(aBindingPath), aBindingBytes);
    assert.deepEqual(await readFile(bBindingPath), bBindingBytes);
    await unchangedOriginalCommands();
    await assertSources();
    proof.status = 'PASS';
    evidence.status = 'PASS';
  } catch (error) {
    proof.failure =
      error instanceof Error ? error.message.slice(0, 4000) : 'owner continuation unavailable';
    throw error;
  } finally {
    try {
      await assertSources();
    } catch (error) {
      proof.status = 'INCOMPLETE';
      evidence.status = 'INCOMPLETE';
      proof.sourceFreezeFailure =
        error instanceof Error ? error.message : 'source or captured input changed';
      throw error;
    } finally {
      await save();
    }
  }
}
