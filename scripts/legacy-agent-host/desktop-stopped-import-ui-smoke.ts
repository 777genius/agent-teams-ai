import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileDigest } from './desktop-backend-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import {
  readDesktopStoppedImportSeed,
  readStoppedImportSourceDiagnostics,
  stoppedImportSourceBytes,
} from './desktop-stopped-import-fixture.ts';
import {
  readStoppedImportAttachmentOwner,
  runDesktopStoppedImportAttachmentUi,
} from './desktop-stopped-import-attachments-ui.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import { runStoppedImportLaunchUi } from './desktop-stopped-import-launch-ui.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const json = async (path: string) => record(JSON.parse(await readFile(path, 'utf8')));
async function records(path: string): Promise<Record<string, unknown>[]> {
  const names = (await readdir(path)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  assert.ok(names.length <= 64);
  return Promise.all(names.map((name) => json(join(path, name))));
}

/** Exact no-tools model checks are permitted; Team/native inputs remain forbidden. */
export function assertStoppedImportModelChecks(
  receipts: Record<string, unknown>[],
  model: Pick<
    Awaited<ReturnType<typeof startNativeTeamModel>>,
    'probes' | 'observations' | 'failures' | 'unexpectedNoToolsRequests'
  >,
  selected: { model: unknown; effort: unknown }
): void {
  assert.ok(receipts.length >= 1 && receipts.length <= 8, 'finite canonical model check count');
  assert.equal(new Set(receipts.map((row) => row.commandId)).size, receipts.length);
  for (const row of receipts) {
    assert.equal(row.kind, 'model.probe');
    assert.equal(row.modelId, selected.model);
    assert.equal(row.effort, selected.effort);
    assert.equal(row.phase, 'completed');
    assert.equal(row.ok, true);
    assert.equal(row.resourceHeld, false);
  }
  assert.equal(
    model.probes.length,
    receipts.length,
    'one exact no-tools request per retained model check'
  );
  for (const probe of model.probes) {
    assert.equal(probe.requestedModel, selected.model);
    assert.equal(probe.requestedEffort, selected.effort);
  }
  assert.deepEqual(model.unexpectedNoToolsRequests, []);
  assert.deepEqual(model.observations, [], 'zero Team agent prompts or tool inputs');
  assert.deepEqual(model.failures, []);
}

/** Original legacy Detail Launch imports saved data only; the dialog is closed without Submit. */
export async function runDesktopStoppedImportUiSmoke(
  cdp: UiCdpPort,
  options: {
    fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
    evidence: Record<string, unknown>;
    model: Awaited<ReturnType<typeof startNativeTeamModel>>;
    electron: string;
    assertOwnedRenderer(): void;
    observeOwnedHost(): void;
  }
): Promise<void> {
  const { fixture, model } = options;
  const seed = await readDesktopStoppedImportSeed(fixture.root);
  const launchContinuation = process.env.LEGACY_DESKTOP_STOPPED_IMPORT_LAUNCH === '1';
  assert.equal(launchContinuation, seed.sourceKind === 'captured-stopped-solo');
  const steps: Record<string, unknown>[] = [];
  const step = (value: Record<string, unknown>) => {
    steps.push({ monotonicMs: Math.round(performance.now()), ...value });
  };
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    sourceKind: seed.sourceKind ?? 'never-launched-draft',
    steps,
    scope: launchContinuation
      ? 'Original captured-stopped solo legacy Team import/readback followed by original native Launch/Stop/reload; source records synthetic, actual source process Stop and target SDK/CLI'
      : 'Original never-launched legacy Team Detail Launch → Main import → canonical Host dialog target; saved data, close without Submit, renderer reload and original import lookup',
    excluded: [
      ...(launchContinuation
        ? ['old provider inference/history qualification', 'multi-member/OpenCode prior-run import']
        : [
            'Previously launched/cold Claude or OpenCode import (HOLD; M16 remains open)',
            'Team Launch Submit',
            'native agent input',
          ]),
      'native session adoption',
      'real vendor inference/credentials',
      'full Stage1',
    ],
    seedSha256: await fileDigest(join(fixture.root, 'stopped-import-ui-seed.json')),
    sourceSha256: await fileDigest(import.meta.filename),
    fixtureSourceSha256: await fileDigest(
      join(import.meta.dirname, 'desktop-stopped-import-fixture.ts')
    ),
    sourceBefore: seed.before,
    preflightObservations: [],
  };
  options.evidence.stoppedImportUiProof = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step,
  });
  const dialogTarget = async () =>
    record(
      await cdp.evaluate(`(() => {
    const node=document.querySelector('[role="dialog"]');if(!node)return null;
    const key=Object.keys(node).find(key=>key.startsWith('__reactFiber$'));
    let fiber=key?node[key]:null;
    for(let depth=0;fiber&&depth<128;depth++,fiber=fiber.return){
      const name=fiber.type?.name??fiber.type?.displayName??fiber.elementType?.name;
      if(name==='LaunchTeamDialog')return {teamName:fiber.memoizedProps.teamName,mode:fiber.memoizedProps.mode,
        cwd:fiber.memoizedProps.defaultProjectPath,members:fiber.memoizedProps.members.map(member=>member.name)};
    }return null;
  })()`)
    );
  const openTeams = async () => {
    await ui.waitRead(
      `Boolean(document.querySelector('button[aria-label="More actions"]'))`,
      'original application menu',
      90_000
    );
    await ui.click('button[aria-label="More actions"]', 'open original menu');
    await ui.click('button', 'open original Teams list', 'Teams');
  };
  await ui.observeInput();
  const navigateOriginalTeam = async () => {
    await openTeams();
    const point = record(
      await ui.waitRead(
        `(() => {
      const cards=[...document.querySelectorAll('.team-row-zebra-card')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.getAttribute('data-team-name')===${desktopJsLiteral(seed.teamName)}&&e.querySelector('h3')?.textContent.trim()===${desktopJsLiteral(seed.sourceCardLabel)};});
      if(cards.length!==1)return null;const e=cards[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
      const hit=document.elementFromPoint(x,y);return r.width&&r.height&&hit&&e.contains(hit)?{x,y}:null;
    })()`,
        'unique visible original legacy Team identity and saved display label',
        90_000
      )
    );
    options.assertOwnedRenderer();
    step({
      action: 'mouseClick',
      label: 'original legacy Team card',
      target: point,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    await ui.waitRead(
      launchContinuation
        ? `Boolean(document.querySelector('button[aria-label="Edit team"]'))`
        : `document.body.innerText.includes('This is a draft team -')`,
      'original saved metadata-only draft Detail'
    );
  };
  await navigateOriginalTeam();

  const openDialog = async () => {
    await ui.scrollTo('button', 'original stopped Detail Launch', 'Launch');
    await ui.click('button', 'original stopped Detail Launch once', 'Launch');
    const section = record(
      await ui.waitRead(
        `(() => {
      const rows=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')].filter(e=>e.textContent.includes('Optional launch settings'));
      return rows.length===1?{id:rows[0].getAttribute('aria-controls'),expanded:rows[0].getAttribute('aria-expanded')}:null;
    })()`,
        'same original LaunchTeamDialog opens after import',
        60_000
      )
    );
    options.observeOwnedHost();
    if (section.expanded !== 'true') {
      const selector = `[role="dialog"] button[aria-controls=${JSON.stringify(section.id)}]`;
      await ui.scrollTo(selector, 'original saved optional settings');
      await ui.click(selector, 'expand saved optional settings');
    }
    try {
      await ui.waitRead(
        `document.querySelector('[role="dialog"] #dialog-prompt')?.value===${desktopJsLiteral(seed.savedSettings.prompt)}`,
        'saved launch prompt hydrates'
      );
      await ui.waitRead(
        `document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')==='unchecked'`,
        'saved manual permission approval hydrates'
      );
      await ui.waitRead(
        `[...document.querySelectorAll('[role="dialog"] button[aria-label*=" provider,"]')].some(e=>e.textContent.trim()==='Sonnet 4.6')`,
        'saved Sonnet model hydrates'
      );
      if (!launchContinuation)
        await ui.waitRead(
          `[...document.querySelectorAll('[role="dialog"] input[aria-label]')].some(e=>e.value==='alice')`,
          'saved teammate input value hydrates'
        );
      await ui.waitRead(
        `(() => {const node=document.querySelector('[role="dialog"]');return node&&
          node.innerText.includes('All selected providers are ready')&&
          !node.innerText.includes('Runtime environment unavailable')&&
          !node.innerText.includes('Runtime environment not available');})()`,
        'original saved-model preflight becomes ready without Runtime allocation',
        60_000
      );
      const receipts = await records(join(fixture.root, 'hoststore/management-commands'));
      assertStoppedImportModelChecks(receipts, model, seed.savedSettings);
      (proof.preflightObservations as unknown[]).push({
        receipts,
        observedExactProbeRequests: model.probes.length,
        dialogText: await cdp.evaluate(
          `document.querySelector('[role="dialog"]')?.innerText.slice(-6000)`
        ),
      });
    } catch (error) {
      proof.hydrationFailureDiagnostics = await cdp.evaluate(`(() => {
        const node=document.querySelector('[role="dialog"]');return {text:node?.innerText.slice(-6000),
          inputs:[...node?.querySelectorAll('input,textarea')??[]].map(e=>({id:e.id,label:e.getAttribute('aria-label'),value:e.value})),
          providers:[...node?.querySelectorAll('button[aria-label*=" provider,"]')??[]].map(e=>({label:e.getAttribute('aria-label'),text:e.textContent.trim()})),
          permissions:node?.querySelector('#dialog-skip-permissions')?.getAttribute('data-state')};
      })()`);
      throw error;
    }
  };
  const closeDialog = async () => {
    await ui.scrollTo('[role="dialog"] button', 'original Close without Launch Submit', 'Close');
    await ui.click(
      '[role="dialog"] button',
      'close original Launch dialog without Submit',
      'Close'
    );
    await ui.waitRead(
      `!document.querySelector('[role="dialog"] #dialog-prompt')`,
      'Launch dialog closed without submit'
    );
  };
  if (launchContinuation)
    proof.sourceBeforeLaunchDiagnostics = await readStoppedImportSourceDiagnostics(fixture.root, {
      node: fixture.node,
      electron: options.electron,
    });
  await openDialog().catch(async (error) => {
    if (launchContinuation)
      proof.sourceFailureDiagnostics = await readStoppedImportSourceDiagnostics(fixture.root, {
        node: fixture.node,
        electron: options.electron,
      });
    throw error;
  });
  const lookupRequest = { teamName: seed.teamName, action: 'lookup' };
  const lookup = record(
    await cdp.evaluate(
      `window.electronAPI.agentBackend.stoppedImport(${desktopJsLiteral(lookupRequest)})`
    )
  );
  assert.equal(lookup.ok, true);
  assert.match(String(lookup.selection), /^host-team:/);
  const target = await dialogTarget();
  assert.equal(
    target.teamName,
    lookup.selection,
    'existing dialog receives canonical Host selection'
  );
  assert.equal(target.mode, 'launch');
  assert.equal(target.cwd, seed.savedSettings.cwd);
  assert.deepEqual(target.members, launchContinuation ? ['team-lead'] : ['team-lead', 'alice']);
  proof.dialogTarget = target;
  const importsPath = join(fixture.root, 'hoststore/.host-team-registry/imports');
  const imported = await records(importsPath);
  assert.equal(imported.length, 1, 'one original import publication');
  assert.equal(imported[0]!.phase, 'published');
  const importedRecord = record(imported[0]!.record);
  assert.equal(importedRecord.teamName, seed.teamName);
  const handle = { handleId: record(importedRecord.binding).handleId };
  const snapshotRequest = {
    handle,
    commandId: randomUUID(),
    operation: 'team.snapshot',
    payload: {},
  };
  const snapshotResult = record(
    await cdp.evaluate(
      `window.electronAPI.agentBackend.invoke(${desktopJsLiteral(snapshotRequest)})`
    )
  );
  assert.equal(snapshotResult.ok, true);
  const snapshot = record(snapshotResult.value);
  const task = (snapshot.tasks as unknown[]).map(record).find((row) => row.id === seed.taskId);
  assert.ok(task);
  assert.equal((task.comments as unknown[]).map(record)[0]!.id, 'TEST-legacy-comment');
  const refs = (task.descriptionTaskRefs as unknown[]).map(record);
  assert.equal(refs.find((ref) => ref.taskId === seed.linkedTaskId)!.teamName, seed.teamName);
  assert.match(
    String(refs.find((ref) => ref.taskId === seed.externalTaskId)!.teamName),
    /^legacy-archive:[a-f0-9]{64}$/
  );
  assert.match(
    String(refs.find((ref) => ref.taskId === seed.missingTaskId)!.teamName),
    /^legacy-gap:[a-f0-9]{64}$/
  );
  const teamRoot = join(fixture.root, 'hoststore/teams', seed.teamName);
  const productTask = await json(
    join(fixture.root, 'hoststore/tasks', seed.teamName, seed.taskId + '.json')
  );
  assert.equal((productTask.attachments as unknown[]).map(record)[0]!.id, 'TEST-task-blob');
  const importedBlob = String(record((productTask.attachments as unknown[])[0]).filePath);
  assert.ok(importedBlob.startsWith(fixture.root + '/hoststore/'));
  assert.equal(
    await fileDigest(importedBlob),
    await fileDigest(seed.blobPath),
    'imported attachment retains exact original bytes'
  );
  const owner = await json(join(teamRoot, '.host-owner/state.json'));
  for (const [key, value] of Object.entries(seed.savedSettings))
    assert.equal(record(owner.savedSettings)[key], value);
  assert.deepEqual(owner.runtimeCaptures ?? [], []);
  const origin = await json(join(teamRoot, '.host-owner/import/source.json'));
  const originRefs = (origin.references as unknown[]).map(record);
  assert.ok(
    originRefs.some(
      (ref) =>
        ref.taskId === seed.linkedTaskId &&
        record(ref.target).kind === 'destination' &&
        record(ref.target).handleId === handle.handleId
    )
  );
  assert.ok(
    originRefs.some(
      (ref) => ref.taskId === seed.externalTaskId && record(ref.target).kind === 'archive'
    )
  );
  assert.ok(
    originRefs.some((ref) => ref.taskId === seed.missingTaskId && record(ref.target).kind === 'gap')
  );
  const screenshot = async (name: string) => {
    const value = record(
      await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
      })
    );
    const path = join(fixture.root, name);
    await writeFile(path, Buffer.from(String(value.data), 'base64'), {
      mode: 0o600,
      flag: 'wx',
    });
    return { path, sha256: await fileDigest(path) };
  };
  proof.importedDialogScreenshot = await screenshot('ui-original-stopped-import-dialog.png');
  proof.importRecord = imported[0];
  proof.lookup = lookup;
  proof.snapshot = snapshot;
  proof.origin = origin;
  proof.importedTask = productTask;
  proof.importedBlobSha256 = await fileDigest(importedBlob);
  await closeDialog();
  const timeOrigin = await cdp.evaluate('performance.timeOrigin');
  step({ action: 'Page.reload', ignoreCache: false });
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(
    `performance.timeOrigin!==${desktopJsLiteral(timeOrigin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'reloaded renderer document'
  );
  await ui.observeInput();
  await navigateOriginalTeam();
  await openDialog();
  assert.deepEqual(
    await dialogTarget(),
    target,
    'reloaded original dialog remains bound to the same canonical Team'
  );
  const afterLookup = record(
    await cdp.evaluate(
      `window.electronAPI.agentBackend.stoppedImport(${desktopJsLiteral(lookupRequest)})`
    )
  );
  assert.deepEqual(afterLookup, lookup, 'reopen queries the original canonical import');
  assert.deepEqual(
    await records(importsPath),
    imported,
    'renderer reload never creates another import intent'
  );
  assert.deepEqual(
    await json(join(teamRoot, '.host-owner/state.json')),
    owner,
    'opening saved dialog never submits Launch or changes saved configuration'
  );
  proof.reloadedDialogScreenshot = await screenshot('ui-original-stopped-import-reloaded.png');
  await closeDialog();
  proof.attachmentsUi = await runDesktopStoppedImportAttachmentUi(cdp, {
    fixtureRoot: fixture.root,
    seed,
    evidence: proof,
    selection: String(lookup.selection),
    handleId: String(handle.handleId),
    snapshotTask: task,
    openTeams,
    screenshot,
    step,
    assertOwnedRenderer: options.assertOwnedRenderer,
  });
  const navigation: Record<string, unknown>[] = [];
  proof.taskReferenceNavigation = navigation;
  for (const [kind, id] of [
    ['destination', seed.linkedTaskId],
    ['archive', seed.externalTaskId],
    ['gap', seed.missingTaskId],
  ] as const) {
    const ref = refs.find((ref) => ref.taskId === id)!;
    const expectedOwner =
      kind === 'destination'
        ? String(lookup.selection)
        : `${String(lookup.selection)}:source-${kind}:${encodeURIComponent(String(ref.teamName))}`;
    await openTeams();
    const team = `.team-row-zebra-card[data-team-name=${JSON.stringify(lookup.selection)}]`;
    await ui.scrollTo(team, 'captured imported TaskRef Team');
    await ui.click(team, 'open captured imported TaskRef Team');
    const taskCard = `.kanban-task-card[data-task-id=${JSON.stringify(seed.taskId)}] h5`;
    await ui.scrollTo(taskCard, 'original imported Task description');
    await ui.click(taskCard, 'open original imported Task description');
    // The seeded description is the paragraph containing all three original refs.
    const paragraph = `[role="dialog"] p:has(a[href^="task://${seed.externalTaskId}?"])`;
    const link = `${paragraph} a[href^="task://${id}?"]`;
    const renderedOwner = await ui.waitRead(
      `(() => {const a=document.querySelector(${desktopJsLiteral(link)});if(!a)return null;return new URL(a.href).searchParams.get('team')??'';})()`,
      'rendered TaskRef owner'
    );
    assert.equal(renderedOwner, expectedOwner);
    await ui.scrollTo(link, 'original owner-qualified TaskRef');
    await ui.click(link, `navigate original ${kind} TaskRef once`);
    if (kind === 'destination') {
      await ui.waitRead(
        `!document.querySelector('[role="dialog"]')&&Boolean(document.querySelector('[data-task-id="${id}"].kanban-card-focus-pulse'))`,
        'internal TaskRef reveals its imported destination'
      );
      const owner = record(
        await ui.waitRead(
          `(() => {const node=document.querySelector('.kanban-task-card[data-task-id="${id}"]');if(!node)return null;const key=Object.keys(node).find(key=>key.startsWith('__reactFiber$'));return (${readStoppedImportAttachmentOwner.toString()})(key?node[key]:null,${desktopJsLiteral(id)});})()`,
          'internal TaskRef destination owner'
        )
      );
      assert.deepEqual(owner, { teamName: expectedOwner, taskId: id, reference: null });
      navigation.push({ kind, requestedTaskId: id, ...owner });
    } else {
      const owner = record(
        await ui.waitRead(
          `(() => {const node=document.querySelector('[role="dialog"]');if(!node||!node.getClientRects().length||!node.querySelector('[role="alert"],[role="status"]'))return null;const key=Object.keys(node).find(key=>key.startsWith('__reactFiber$'));let fiber=key?node[key]:null;let phase=null;for(let depth=0;fiber&&depth<128;depth++,fiber=fiber.return){const p=fiber.memoizedProps;if(p?.open===true&&(p.phase==='unavailable'||p.phase==='missing'))phase=p.phase;if(p?.open===true&&p.teamName===${desktopJsLiteral(expectedOwner)}&&p.sessionController?.identity?.taskId===${desktopJsLiteral(id)}&&p.sessionController.identity.teamName===${desktopJsLiteral(expectedOwner)}&&'task' in p&&'taskMap' in p&&!p.loading&&p.task===null&&(phase==='unavailable'||phase==='missing'))return {teamName:p.teamName,taskId:null};}return null;})()`,
          'original captured source owner remains unavailable without local fallback'
        )
      );
      assert.deepEqual(owner, { teamName: expectedOwner, taskId: null });
      navigation.push({
        kind,
        requestedTaskId: id,
        ...owner,
        outcome: 'unavailable at captured source owner',
      });
      await ui.click('[role="dialog"] > button', 'close source-owner Task result', 'Close');
      await ui.waitRead(
        `!document.querySelector('[role="dialog"]')`,
        'source-owner Task result closed'
      );
    }
  }
  const after = await stoppedImportSourceBytes(fixture.root, seed.roots);
  assert.deepEqual(after, seed.before, 'all original legacy file bytes remain unchanged');
  const probeReceipts = await records(join(fixture.root, 'hoststore/management-commands'));
  assertStoppedImportModelChecks(probeReceipts, model, seed.savedSettings);
  const sessions = await readDesktopNativeStopSessions(fixture.root).catch(
    (error: NodeJS.ErrnoException) => {
      if (
        error.code === 'ENOENT' &&
        error.path === join(fixture.root, 'hoststore/runtime-sessions')
      )
        return [];
      throw error;
    }
  );
  assert.deepEqual(sessions, [], 'no Runtime session or outbox input allocation');
  proof.modelPreflightReceipts = probeReceipts;
  if (launchContinuation) proof.runtimeSessionsBeforeLaunch = sessions;
  else proof.runtimeSessions = sessions;
  proof.sourceAfter = after;
  proof.noLaunchSubmit = true;
  proof.sameOriginalImportAfterReload = true;
  proof.probes = model.probes;
  if (launchContinuation) {
    await runStoppedImportLaunchUi(cdp, {
      fixture,
      seed,
      selection: String(lookup.selection),
      handleId: String(handle.handleId),
      model,
      evidence: proof,
      importedTask: productTask,
      openTeams,
      openSourceDialog: async () => {
        await navigateOriginalTeam();
        await openDialog();
      },
      assertOwnedRenderer: options.assertOwnedRenderer,
      step,
    });
    assert.deepEqual(
      await records(importsPath),
      imported,
      'native Launch and reload retain the original single import publication'
    );
    proof.noLaunchSubmit = false;
  }
  proof.status = 'PASS';
}
