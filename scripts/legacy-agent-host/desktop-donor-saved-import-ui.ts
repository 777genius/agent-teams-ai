import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileDigest } from './desktop-backend-fixture.ts';
import {
  readDonorSavedSeed,
  captureDonorSavedCorpus,
  donorRow,
  readDonorJson,
} from './desktop-donor-saved-fixture.ts';
import type { DonorRow } from './desktop-donor-saved-fixture.ts';
import { assertStoppedImportModelChecks } from './desktop-stopped-import-ui-smoke.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';

async function records(path: string): Promise<DonorRow[]> {
  const names = (await readdir(path)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
  assert.ok(names.length <= 64);
  return Promise.all(names.map((name) => readDonorJson(join(path, name))));
}

/** Existing Detail Launch/import/reload using untouched actual donor files and IDs. */
export async function runDesktopDonorSavedImportUi(
  cdp: UiCdpPort,
  options: {
    fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
    model: Awaited<ReturnType<typeof startNativeTeamModel>>;
    evidence: DonorRow;
    assertOwnedRenderer(): void;
    observeOwnedHost(): void;
  }
): Promise<void> {
  const { fixture, model } = options;
  const seed = await readDonorSavedSeed(fixture.root);
  const producer = await readDonorJson(join(fixture.root, 'desktop-donor-saved-producer.json'));
  assert.equal(producer.status, 'PASS');
  assert.equal(donorRow(producer.ordinaryQuit).originalGroupAbsent, true);
  assert.equal(donorRow(producer.ordinaryQuit).requestedOnce, true);
  const donorProbes = model.donorSavedProbes;
  assert.ok(donorProbes, 'explicit donor oracle phase');
  assert.equal(donorProbes.length, seed.producerProbeCount);
  assert.deepEqual(donorProbes, producer.modelProbes);
  const steps: DonorRow[] = [];
  const proof: DonorRow = {
    status: 'INCOMPLETE',
    sourceKind: seed.sourceKind,
    producerCommit: seed.producer.commit,
    producerReceiptSha256: await fileDigest(
      join(fixture.root, 'desktop-donor-saved-producer.json')
    ),
    sourceBefore: seed.source,
    steps,
    scope:
      'Actual donor saved settings/roster → existing Detail Launch/import → close → renderer reload and original lookup',
    excluded: [
      'donor native history/Review',
      'donor tasks/attachments',
      'native Team input',
      'prior-native import',
    ],
  };
  options.evidence.donorSavedImportUiProof = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (value) => steps.push({ elapsedMs: Math.round(performance.now()), ...value }),
  });
  const dialogTarget = async () =>
    donorRow(
      await cdp.evaluate(
        '(() => { const node=document.querySelector(\'[role="dialog"]\');if(!node)return null;' +
          'const key=Object.keys(node).find(key=>key.startsWith("__reactFiber$"));let fiber=key?node[key]:null;' +
          'for(let n=0;fiber&&n<128;n++,fiber=fiber.return){const name=fiber.type?.name??fiber.type?.displayName??fiber.elementType?.name;' +
          'if(name==="LaunchTeamDialog")return {teamName:fiber.memoizedProps.teamName,mode:fiber.memoizedProps.mode,' +
          'cwd:fiber.memoizedProps.defaultProjectPath,members:fiber.memoizedProps.members.map(member=>member.name)};}return null;})()'
      )
    );
  const navigateOriginalTeam = async () => {
    await ui.waitRead(
      'Boolean(document.querySelector(\'button[aria-label="More actions"]\'))',
      'consumer original application menu',
      90_000
    );
    await ui.click('button[aria-label="More actions"]', 'open consumer menu');
    await ui.click('button', 'open original Team list', 'Teams');
    const selector = '.team-row-zebra-card[data-team-name=' + JSON.stringify(seed.teamName) + ']';
    await ui.waitRead(
      'document.querySelector(' +
        literal(selector) +
        ')?.querySelector("h3")?.textContent.trim()===' +
        literal(seed.displayName),
      'genuine donor Team label'
    );
    await ui.scrollTo(selector, 'genuine donor Team card');
    await ui.click(selector, 'open genuine donor Team once');
    await ui.waitRead(
      'document.body.innerText.includes("This is a draft team -")',
      'actual saved-only donor Detail'
    );
  };
  const checkPreflight = async () => {
    const receipts = await records(join(fixture.root, 'hoststore/management-commands'));
    assert.deepEqual(
      donorProbes,
      producer.modelProbes,
      'original settled donor checks never change during consumer'
    );
    assertStoppedImportModelChecks(
      receipts,
      {
        probes: model.probes,
        observations: model.observations,
        failures: model.failures,
        unexpectedNoToolsRequests: model.unexpectedNoToolsRequests,
      },
      { model: seed.source.meta.model, effort: seed.source.meta.effort }
    );
    return receipts;
  };
  const openDialog = async () => {
    await ui.scrollTo('button', 'genuine donor Detail Launch', 'Launch');
    await ui.click('button', 'original import through Detail Launch once', 'Launch');
    const section = donorRow(
      await ui.waitRead(
        '(() => {const b=[...document.querySelectorAll(\'[role="dialog"] button[aria-controls]\')].find(e=>e.textContent.includes("Optional launch settings"));' +
          'return b?{id:b.getAttribute("aria-controls"),expanded:b.getAttribute("aria-expanded")}:null;})()',
        'existing Host Launch dialog',
        60_000
      )
    );
    options.observeOwnedHost();
    if (section.expanded !== 'true') {
      const selector = '[role="dialog"] button[aria-controls=' + JSON.stringify(section.id) + ']';
      await ui.scrollTo(selector, 'imported optional settings');
      await ui.click(selector, 'expand imported optional settings once');
    }
    await ui.waitRead(
      'document.querySelector(\'[role="dialog"] #dialog-prompt\')?.value===' +
        literal(seed.source.meta.prompt ?? ''),
      'actual donor prompt retained'
    );
    await ui.waitRead(
      '[...document.querySelectorAll(\'[role="dialog"] input[aria-label]\')].some(e=>e.value===' +
        literal('donor-peer') +
        ')',
      'actual donor peer retained'
    );
    await ui.waitRead(
      '(() => {const node=document.querySelector(\'[role="dialog"]\');return node&&node.innerText.includes("All selected providers are ready")' +
        '&&!node.innerText.includes("Runtime environment unavailable")&&!node.innerText.includes("Runtime environment not available");})()',
      'original consumer no-tools model preflight',
      60_000
    );
    return checkPreflight();
  };
  const closeDialog = async () => {
    await ui.scrollTo('[role="dialog"] button', 'close without native Launch', 'Close');
    await ui.click('[role="dialog"] button', 'close original dialog once', 'Close');
    await ui.waitRead(
      '!document.querySelector(\'[role="dialog"] #dialog-prompt\')',
      'Launch dialog closed'
    );
  };
  const screenshot = async (name: string) => {
    const image = donorRow(
      await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    );
    const path = join(fixture.root, name);
    await writeFile(path, Buffer.from(String(image.data), 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  await ui.observeInput();
  await navigateOriginalTeam();
  proof.firstPreflight = await openDialog();
  const lookupRequest = { teamName: seed.teamName, action: 'lookup' };
  const lookup = donorRow(
    await cdp.evaluate(
      'window.electronAPI.agentBackend.stoppedImport(' + literal(lookupRequest) + ')'
    )
  );
  assert.equal(lookup.ok, true);
  assert.match(String(lookup.selection), /^host-team:/);
  const target = await dialogTarget();
  assert.equal(target.teamName, lookup.selection);
  assert.equal(target.mode, 'launch');
  assert.equal(target.cwd, seed.source.meta.cwd);
  const savedMembers = (seed.source.roster.members as unknown[]).map(donorRow);
  assert.deepEqual(target.members, ['team-lead', ...savedMembers.map((member) => member.name)]);
  const importsPath = join(fixture.root, 'hoststore/.host-team-registry/imports');
  const imported = await records(importsPath);
  assert.equal(imported.length, 1, 'one genuine original import publication');
  assert.equal(imported[0]!.phase, 'published');
  const importedRecord = donorRow(imported[0]!.record);
  assert.equal(importedRecord.teamName, seed.teamName);
  const ownerPath = join(fixture.root, 'hoststore/teams', seed.teamName, '.host-owner/state.json');
  const owner = await readDonorJson(ownerPath);
  assert.equal(Object.hasOwn(donorRow(owner.savedSettings), 'effort'), false,
    'import preserves omitted donor effort');
  for (const [key, value] of Object.entries(seed.source.meta)) {
    if (key !== 'version' && key !== 'createdAt')
      assert.deepEqual(donorRow(owner.savedSettings)[key], value, 'actual saved setting: ' + key);
  }
  const members = (owner.members as unknown[]).map(donorRow);
  assert.deepEqual(
    members.map((member) => [member.name, member.role]),
    [['team-lead', 'lead'], ...savedMembers.map((member) => [member.name, 'member'])]
  );
  for (const original of savedMembers) {
    const member = members.find((value) => value.name === original.name)!;
    for (const key of [
      'role',
      'workflow',
      'isolation',
      'cwd',
      'providerId',
      'providerBackendId',
      'model',
      'effort',
      'fastMode',
      'mcpPolicy',
    ])
      if (Object.hasOwn(original, key))
        assert.deepEqual(
          donorRow(member.settings)[key],
          original[key],
          'actual member setting: ' + key
        );
  }
  assert.deepEqual(owner.runtimeCaptures ?? [], []);
  const snapshot = donorRow(
    await cdp.evaluate(
      'window.electronAPI.agentBackend.invoke(' +
        literal({
          handle: { handleId: donorRow(importedRecord.binding).handleId },
          commandId: randomUUID(),
          operation: 'team.snapshot',
          payload: {},
        }) +
        ')'
    )
  );
  assert.equal(snapshot.ok, true);
  assert.deepEqual(
    donorRow(snapshot.value).tasks,
    [],
    'saved-only donor has no synthetic task history'
  );
  proof.importedDialogScreenshot = await screenshot('desktop-donor-saved-imported.png');
  proof.importRecord = imported[0];
  proof.dialogTarget = target;
  await closeDialog();
  const timeOrigin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(
    'performance.timeOrigin!==' +
      literal(timeOrigin) +
      '&&Boolean(window.electronAPI)&&!document.getElementById("splash")',
    'new renderer document'
  );
  await ui.observeInput();
  await navigateOriginalTeam();
  proof.secondPreflight = await openDialog();
  assert.deepEqual(await dialogTarget(), target, 'reload retains the original imported Team');
  assert.deepEqual(
    await cdp.evaluate(
      'window.electronAPI.agentBackend.stoppedImport(' + literal(lookupRequest) + ')'
    ),
    lookup
  );
  assert.deepEqual(
    await records(importsPath),
    imported,
    'reload does not create another import intent'
  );
  assert.deepEqual(
    await readDonorJson(ownerPath),
    owner,
    'read-only dialog never changes saved configuration'
  );
  proof.reloadedDialogScreenshot = await screenshot('desktop-donor-saved-reloaded.png');
  await closeDialog();
  const sourceAfter = await captureDonorSavedCorpus(fixture.root, seed.teamName);
  assert.deepEqual(sourceAfter, seed.source, 'consumer preserves every original donor output file');
  assert.deepEqual(
    await readDesktopNativeStopSessions(fixture.root),
    [],
    'no Runtime allocation or outbox input'
  );
  assert.deepEqual(model.observations, []);
  assert.deepEqual(model.failures, []);
  assert.deepEqual(model.unexpectedNoToolsRequests, []);
  proof.sourceAfter = sourceAfter;
  proof.originalImportAfterReload = true;
  proof.noLaunchSubmit = true;
  proof.nativeBusinessInputs = 0;
  proof.producerProbeCount = seed.producerProbeCount;
  proof.consumerProbeCount = model.probes.length;
  proof.sourceSha256 = await fileDigest(import.meta.filename);
  proof.seedSha256 = await fileDigest(join(fixture.root, 'desktop-donor-saved-seed.json'));
  assert.equal(proof.seedSha256, producer.seedSha256);
  proof.status = 'PASS';
}
