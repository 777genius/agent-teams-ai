import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { hostTeamRunId } from '../../src/features/agent-backend/contracts/teamRunSelection.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { processTable } from './desktop-backend-observations.ts';
import { openOriginalCreateForm } from './desktop-create-config-ui-smoke.ts';
import { openDesktopEmulatedBootChat } from './desktop-emulated-boot-chat.ts';
import { readDesktopEmulatedRuntimeEffects, verifyDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import { readDesktopEmulatedCodexInstallerLog, readDesktopEmulatedCodexInstallation } from './desktop-emulated-codex-installer-fixture.ts';
import { readDesktopEmulatedCodexInstallerSettingsUi, runDesktopEmulatedCodexInstallerUi } from './desktop-emulated-codex-installer-ui.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { json, jsonDigest, record, rows } from './desktop-resume-records.ts';
import { createDesktopUiControls, desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import type { prepareDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
const array = (value: unknown): Row[] => { assert.ok(Array.isArray(value)); return value.map(record); };

/** Original Create/Launch/Composer/Stop controls; two finite native threads retain their own selections. */
export async function runDesktopEmulatedSelectionUi(cdp: UiCdpPort & { evaluate(expression: string, timeoutMs?: number): Promise<unknown> }, options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>;
  evidence: Row;
  assertOwnedRenderer(): void;
}) {
  const { fixture } = options, steps: Row[] = [], observations: Row[] = [];
  assert.equal(fixture.emulatedRuntime.provider, 'codex');
  assert.ok(fixture.emulatedRuntime.variant === 'selection' || fixture.emulatedRuntime.variant === 'installer');
  const installer = fixture.emulatedRuntime.installer;
  assert.equal(Boolean(installer), fixture.emulatedRuntime.variant === 'installer');
  const proof: Row = { status: 'INCOMPLETE', steps, observations,
    scope: `${installer ? 'Original stock Codex Update, ' : ''}save-only model/effort selection, renderer reload, next launch and scoped Team Stop while the prior captured runtime remains alive`,
    excluded: ['vendor model compatibility', 'native provider qualification', 'replacement of existing provider conversation journeys'] };
  options.evidence.emulatedSelectionUiProof = proof;
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step: value => steps.push(value) });
  const effects = () => readDesktopEmulatedRuntimeEffects(fixture);
  const poll = async <T>(read: (deadline: number) => Promise<T>, accept: (value: T) => boolean, label: string) => {
    const deadline = Date.now() + 75_000;
    for (;;) {
      await effects(); const value = await read(deadline); if (accept(value)) return value;
      assert.ok(Date.now() < deadline, label + '; original action is never repeated');
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  };
  const visible = (text: string) => ui.waitRead(`document.body.innerText.includes(${literal(text)})`, 'original visible reply ' + text, 60_000);
  const screenshot = async (name: string) => {
    const image = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
    assert.equal(typeof image.data, 'string'); const path = join(fixture.root, `ui-emulated-selection-${name}.png`);
    await writeFile(path, Buffer.from(String(image.data), 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  const fill = async (selector: string, value: string) => {
    await ui.scrollTo(selector, 'original input'); await ui.click(selector, 'focus original input');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA',
      modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
    await cdp.send('Input.insertText', { text: value });
    await ui.waitRead(`document.querySelector(${literal(selector)})?.value===${literal(value)}`, 'exact original input');
  };
  const team = (name: string, handleId: string, model: string, effort: 'low' | 'high') => {
    const root = join(fixture.root, 'hoststore/teams', name);
    return { name, handleId, model, effort, root, owner: () => json(join(root, '.host-owner/state.json')),
      commands: () => rows(join(root, '.host-owner/commands')) };
  };
  type Team = ReturnType<typeof team>;
  const a = team('test-desktop-backend', fixture.handleId, 'TEST-model', 'low');
  const openTeam = async (selected: Team) => {
    await ui.click('button[aria-label="More actions"]', 'open original application menu');
    await ui.click('button', 'open original Teams list', 'Teams');
    const key = hostTeamSelectionKey(selected.handleId), selector = `[data-team-name=${literal(key)}]`;
    await ui.scrollTo(selector, 'original captured Team card'); await ui.click(selector, 'open original captured Team');
    await ui.waitRead(`window.__agentTeamsDevStore?.getState().selectedTeamName===${literal(key)}`, 'original selected Team identity');
  };
  const openLaunch = async (selected: Team, chooseLow = false) => {
    await ui.click('button', 'open original saved Team Launch', 'Launch');
    let previousSettings = '', stableSettings = 0;
    const settings = record(await ui.waitRead(`(()=>{const rows=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')]
      .filter(e=>e.textContent.includes('Optional launch settings')&&e.textContent.includes(${literal(selected.model)}));
      if(rows.length!==1)return null;
      const button=rows[0],dialog=button.closest('[role="dialog"]');
      if(!dialog)return null;
      const rect=button.getBoundingClientRect();
      const id=button.getAttribute('aria-controls'),expanded=button.getAttribute('aria-expanded');
      if(typeof id!=='string'||!id.length||!['true','false'].includes(expanded)||
        ![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite)||rect.width<=0||rect.height<=0||
        dialog.getAnimations().some(animation=>animation.pending||
          animation.playState==='running'||animation.playState==='paused'))return null;
      return {id,expanded,x:rect.x,y:rect.y,width:rect.width,height:rect.height}})()`,
    'saved model hydrates original Launch', 30_000, value => {
      const key = value ? JSON.stringify(value) ?? '' : '';
      stableSettings = key ? key === previousSettings ? Math.min(3, stableSettings + 1) : 1 : 0;
      previousSettings = key;
      return stableSettings === 3;
    }));
    if (settings.expanded !== 'true') await ui.click(`[role="dialog"] button[aria-controls=${literal(settings.id)}]`, 'expand original saved launch settings');
    const lead = '[role="dialog"] [data-role="lead-row"]';
    // Launch shares the expandable lead row with Create. #dialog-effort belongs
    // to schedule mode; opening the original lead row does not change its choices.
    if (!(await cdp.evaluate(`Boolean(document.querySelector('${lead} #lead-effort'))`))) {
      const modelButton = `${lead} button[aria-label^="Codex provider,"]`;
      await ui.scrollTo(modelButton, 'original captured lead model');
      await ui.click(modelButton, 'expand original captured lead model');
    }
    if (chooseLow) {
      await ui.scrollTo(`${lead} #lead-effort`, 'original captured effort');
      await ui.click(`${lead} div:has(> #lead-effort) > button`, 'select original Low effort', 'Low');
    }
    await ui.waitRead(`document.querySelector('${lead} #lead-effort')?.textContent.trim()===${literal(selected.effort === 'low' ? 'Low' : 'High')}`, 'saved effort hydrates original Launch');
    await fill('[role="dialog"] #dialog-prompt', 'TEST_UI_BOOT');
    assert.equal(await cdp.evaluate(`document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')`), 'unchecked');
    await ui.scrollTo('[role="dialog"] button', 'original Launch team', 'Launch team');
    await ui.waitRead(`[...document.querySelectorAll('[role="dialog"] button')].some(e=>e.textContent.trim()==='Launch team'&&!e.disabled)&&
      (!${Boolean(installer)}||document.querySelector('[role="dialog"] [data-testid="provider-activity-status-codex"]')?.getAttribute('data-tone')==='checked')`, 'original selected model preflight', 90_000);
    assert.deepEqual((await selected.owner()).runtimeCaptures ?? [], []);
  };
  const launch = async (selected: Team) => {
    await ui.click('[role="dialog"] button', 'launch original selection once', 'Launch team');
    await ui.waitRead(`!document.querySelector('[role="dialog"] #dialog-prompt')`, 'original Launch closes', 60_000);
    const owner = await poll(selected.owner, value => array(value.runtimeCaptures ?? []).length === 1, 'one original Team launch capture');
    const capture = array(owner.runtimeCaptures)[0]!;
    const launched = await json(join(selected.root, '.host-owner/launches', jsonDigest(capture.launchId) + '.json'));
    const definition = structuredClone(record(launched.definition)); assert.equal(definition.launchId, capture.launchId);
    const source = record(definition.capture), settings = record(source.savedSettings), members = array(source.members);
    assert.equal(members.length, 1); assert.equal(members[0]!.role, 'lead');
    assert.equal(settings.providerId, 'codex'); assert.equal(settings.model, selected.model); assert.equal(settings.effort, selected.effort);
    assert.equal(settings.skipPermissions, false);
    const pendingSession = async () => {
      const all = (await readDesktopNativeStopSessions(fixture.root)).filter(row => record(row.binding).runId === capture.launchId);
      assert.ok(all.length <= 1, 'one session per original launch');
      if (all.length === 0) return undefined;
      assert.equal(record(all[0]!.binding).memberId, members[0]!.memberId); return all[0]!;
    };
    const initial = await poll(pendingSession, value => value !== undefined && array(value.inputs).length === 1 && array(value.inputs)[0]!.terminal === 'succeeded', 'original BOOT completes once');
    assert.ok(initial);
    const session = async () => { const value = await pendingSession(); assert.ok(value, 'original live session is retained'); return value; };
    const native = (await effects()).filter(row => row.event === 'thread-selection' && row.runtimeMcp === true && row.model === selected.model);
    assert.equal(native.length, 1); const thread = native[0]!;
    assert.equal(thread.effort, selected.effort); assert.equal(thread.role, 'runtime');
    assert.equal((await effects()).filter(row => row.pid === thread.pid && row.event === 'input' && row.marker === 'TEST_UI_BOOT').length, 1);
    return { ...selected, capture, definition, session, initial: structuredClone(initial), thread,
      memberName: String(members[0]!.name) };
  };
  type Live = Awaited<ReturnType<typeof launch>>;
  const leadSelector = (live: Live) => {
    const name = live.memberName === 'team-lead' ? 'lead' : live.memberName;
    return `button[aria-label^=${literal(name + ',')}]`;
  };
  const openChat = async (live: Live, controls = ui, expectedReply?: string) => {
    const selector = leadSelector(live);
    await controls.scrollTo(selector, 'original lead conversation');
    await controls.click(selector, 'open original lead conversation', undefined, expectedReply);
  };
  const openInitialChat = (live: Live) => openDesktopEmulatedBootChat(cdp, {
    selector: leadSelector(live), timeoutMs: 60_000, replyLabel: 'original visible reply TEST boot ready',
    assertOwnedRenderer: options.assertOwnedRenderer, step: value => steps.push(value),
    open: controls => openChat(live, controls),
  });
  const assertSameLive = async (live: Live, phase: string, originalInputs: boolean) => {
    assert.deepEqual(array((await live.owner()).runtimeCaptures), [live.capture]);
    const stored = await json(join(live.root, '.host-owner/launches', jsonDigest(live.capture.launchId) + '.json'));
    assert.deepEqual(record(stored.definition), live.definition);
    const current = await live.session();
    assert.deepEqual(current.binding, live.initial.binding); assert.deepEqual(current.config, live.initial.config);
    assert.equal(current.sessionRef, live.initial.sessionRef); assert.equal(current.hostIncarnation, live.initial.hostIncarnation);
    assert.equal(current.nativeReady, true); assert.equal(current.custody, 'owned'); assert.equal(current.sealed, false);
    if (originalInputs) assert.deepEqual(current.inputs, live.initial.inputs);
    assert.ok(processTable().some(row => row.pid === live.thread.pid));
    const journal = await effects();
    assert.deepEqual(journal.filter(row => row.event === 'thread-selection' && row.runtimeMcp === true && row.model === live.model), [live.thread]);
    assert.equal(journal.some(row => row.pid === live.thread.pid && row.event === 'exit'), false);
    observations.push({ phase, binding: current.binding, sessionRef: current.sessionRef,
      thread: live.thread, nativeReady: true, originalInputsUnchanged: originalInputs });
    return current;
  };
  const stop = async (live: Live, observeStoppedUi = false) => {
    await ui.scrollTo('button[aria-label="Stop"]', 'original Team Stop');
    await ui.click('button[aria-label="Stop"]', 'stop original selected Team once', 'Stop');
    const stopped = await poll(live.session, value => value.phase === 'closed' && value.custody === 'released', 'original selected custody released');
    await poll(async deadline => {
      const table = processTable();
      if (table.some(row => row.pid === live.thread.pid)) return false;
      if (!observeStoppedUi) return true;
      const key = hostTeamSelectionKey(live.handleId), runId = hostTeamRunId(live.handleId,
        live.definition.launchId as string, live.definition.rosterRevision as string);
      options.assertOwnedRenderer();
      const remaining = deadline - Date.now();
      assert.ok(remaining > 0, 'original stopped UI observation; original action is never repeated');
      const ready = await cdp.evaluate(`(() => {
        const key = ${literal(key)}, runId = ${literal(runId)}, state = window.__agentTeamsDevStore?.getState();
        if (state?.selectedTeamName !== key || state.currentProvisioningRunIdByTeam?.[key] !== runId ||
          state.currentRuntimeRunIdByTeam?.[key] !== runId) return false;
        const progress = state.provisioningRuns?.[runId];
        if (progress?.runId !== runId || progress.teamName !== key || progress.state !== 'disconnected') return false;
        const visible = e => { const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility === 'visible'; };
        const teams = [...document.querySelectorAll('[data-team-name]')].filter(e =>
          e.getAttribute('data-team-name') === key && e.querySelector('[data-section-id="team"]') && visible(e));
        if (teams.length !== 1) return false;
        const banners = [...teams[0].querySelectorAll(':scope > [role="status"]')];
        if (banners.length !== 1) return false;
        const banner = banners[0], wrapper = banner.nextElementSibling;
        const launches = [...banner.querySelectorAll('button')].filter(e => e.textContent.trim() === 'Launch');
        return visible(banner) && [...banner.querySelectorAll(':scope > span')].some(e =>
          e.textContent.trim() === 'Team is offline') && launches.length === 1 &&
          !launches[0].disabled && visible(launches[0]) && wrapper?.tagName === 'DIV' && wrapper.childElementCount === 0;
      })()`, Math.min(30_000, remaining));
      assert.ok(Date.now() < deadline, 'original stopped UI observation; original action is never repeated');
      return ready === true;
    }, value => value === true, observeStoppedUi ? 'original selected peer absent and captured stopped Team UI converged' : 'original selected peer absent');
    assert.deepEqual(stopped.binding, live.initial.binding);
    return { binding: stopped.binding, phase: stopped.phase, custody: stopped.custody, originalPid: live.thread.pid, absent: true };
  };

  await ui.observeInput(); await ui.clickSidebar(fixture.uiSeed.subject);
  await openLaunch(a, true); const liveA = await launch(a);
  await openInitialChat(liveA);
  proof.aLaunchScreenshot = await screenshot('a-launch'); proof.a = { capture: liveA.capture, definition: liveA.definition, thread: liveA.thread };
  if (installer) {
    const originalInvocation = (await readDesktopEmulatedCodexInstallerLog(installer.invocationLog)).filter(row => row.pid === liveA.thread.pid && row.kind === 'app-server');
    assert.equal(originalInvocation.length, 1); assert.equal(originalInvocation[0]!.executable, installer.executable.path);
    assert.equal(originalInvocation[0]!.version, installer.binaryVersionA); proof.aInvocation = originalInvocation[0];
  }
  await assertSameLive(liveA, 'before-create', true);

  const bName = 'test-selection-next-team', page = '[data-testid="create-team-page"]';
  await openOriginalCreateForm(cdp, ui, join(fixture.root, 'workspace'), bName);
  const optionalLaunch = record(await ui.waitRead(`(()=>{const rows=[...document.querySelectorAll('${page} button[aria-controls]')]
    .filter(e=>e.textContent.includes('Optional launch settings'));
    return rows.length===1?{id:rows[0].getAttribute('aria-controls'),expanded:rows[0].getAttribute('aria-expanded')}:null})()`, 'original Create launch settings'));
  if (optionalLaunch.expanded !== 'true') {
    const toggle = `${page} button[aria-controls=${literal(optionalLaunch.id)}]`;
    await ui.scrollTo(toggle, 'original Create launch settings');
    await ui.click(toggle, 'expand original Create launch settings');
  }
  await ui.waitRead(`(() => {
    const rows=[...document.querySelectorAll('${page} .optional-settings-content')]
      .filter(e=>e.id===${literal(optionalLaunch.id)});
    if(rows.length!==1)return false;
    const content=rows[0], rect=content.getBoundingClientRect();
    return content.getAttribute('data-state')==='open' && rect.width>0 && rect.height>0 &&
      content.getAnimations().every(animation=>!animation.pending &&
        (animation.playState==='finished'||animation.playState==='idle'));
  })()`, 'original expanded Create settings settle');
  const permissions = `${page} #create-skip-permissions`;
  const permissionState = await ui.waitRead(`document.querySelector(${literal(permissions)})?.getAttribute('data-state')`, 'original Create approval choice');
  assert.ok(permissionState === 'checked' || permissionState === 'unchecked');
  if (permissionState === 'checked') {
    await ui.scrollTo(permissions, 'original Create approval choice');
    await ui.click(permissions, 'retain tool confirmations for saved Team');
  }
  await ui.waitRead(`document.querySelector(${literal(permissions)})?.getAttribute('data-state')==='unchecked'`, 'original saved Team approval choice');
  await ui.scrollTo(`${page} #launch-team`, 'original immediate-launch checkbox', undefined, 12, { requireCenterHit: true });
  assert.equal(await cdp.evaluate(`document.querySelector('${page} #launch-team')?.getAttribute('data-state')`), 'checked');
  await ui.click(`${page} #launch-team`, 'select original save-only Create');
  await ui.waitRead(`document.querySelector('${page} #launch-team')?.getAttribute('data-state')==='unchecked'`, 'save-only selected');
  await ui.scrollTo(`${page} button[aria-label*=" provider,"]`, 'original lead model selector');
  await ui.click(`${page} button[aria-label*=" provider,"]`, 'open original lead model selector');
  await ui.scrollTo(`${page} [data-testid="team-model-selector-provider-nav-codex"]`, 'original Codex catalog');
  await ui.click(`${page} [data-testid="team-model-selector-provider-nav-codex"]`, 'select original Codex provider');
  if (installer) proof.installer = await runDesktopEmulatedCodexInstallerUi(cdp, { fixture, ui,
    assertOwnedRenderer: options.assertOwnedRenderer,
    assertPriorRuntime: async phase => { await assertSameLive(liveA, phase, true); } });
  const model = `${page} [data-testid="team-model-selector-model-option"][aria-label^="TEST next model"]`;
  await ui.waitRead(`(()=>{const rows=[...document.querySelectorAll(${literal(model)})];return rows.length===1&&rows[0].getAttribute('aria-disabled')!=='true'})()`, 'one selectable second TEST model');
  await ui.scrollTo(model, 'original second model'); await ui.click(model, 'select original second model');
  await ui.scrollTo(`${page} #lead-effort`, 'original effort choices');
  await ui.click(`${page} div:has(> #lead-effort) > button`, 'select original High effort', 'High');
  await ui.waitRead(`document.querySelector('${page} #lead-effort')?.textContent.trim()==='High'`, 'High remains selected');
  proof.selectedScreenshot = await screenshot('selected');
  await ui.scrollTo(`${page} button`, 'original save-only Create action', 'Create');
  await ui.click(`${page} button`, 'save original second selection once', 'Create');
  await ui.waitRead(`!document.querySelector('${page} #team-name')`, 'original Create closes', 60_000);
  const registry = await rows(join(fixture.root, 'hoststore/.host-team-registry/records'));
  assert.equal(registry.length, 1); assert.equal(registry[0]!.phase, 'published');
  const created = record(registry[0]!.record); assert.equal(created.teamName, bName);
  const b = team(bName, String(record(created.binding).handleId), 'TEST-model-next', 'high');
  const bSaved = await b.owner(), saved = record(bSaved.savedSettings);
  assert.equal(saved.providerId, 'codex'); assert.equal(saved.model, b.model); assert.equal(saved.effort, b.effort);
  assert.equal(saved.skipPermissions, false);
  assert.equal(saved.cwd, join(fixture.root, 'workspace')); assert.deepEqual(bSaved.runtimeCaptures ?? [], []);
  await assertSameLive(liveA, 'after-save-only', true); proof.creation = registry[0]; proof.savedSelection = saved;

  const origin = await cdp.evaluate('performance.timeOrigin'); await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(`performance.timeOrigin!==${literal(origin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`, 'fresh renderer after reload');
  await ui.observeInput(); await ui.waitRead(`Boolean(document.querySelector('button[aria-label="More actions"]'))`, 'reloaded original menu');
  await openTeam(b); await openLaunch(b);
  assert.deepEqual(await b.owner(), bSaved); await assertSameLive(liveA, 'after-reload-before-next-launch', true);
  proof.reloadedScreenshot = await screenshot('reloaded'); proof.selectionRetainedAfterReload = true;
  const liveB = await launch(b); assert.notEqual(liveB.thread.pid, liveA.thread.pid); assert.notEqual(liveB.thread.threadId, liveA.thread.threadId);
  if (installer) {
    const installed = await readDesktopEmulatedCodexInstallation(installer); assert.ok(installed);
    const nextInvocation = (await readDesktopEmulatedCodexInstallerLog(installer.invocationLog)).filter(row => row.pid === liveB.thread.pid && row.kind === 'app-server');
    assert.equal(nextInvocation.length, 1); assert.equal(nextInvocation[0]!.executable, installed.executable.path);
    assert.equal(nextInvocation[0]!.version, installer.binaryVersionB);
    const nextSources = array(record(liveB.definition.capture).recipeSources);
    assert.equal(nextSources.length, 1); assert.equal(nextSources[0]!.revision, record(record(proof.installer).publication).revision);
    assert.equal(nextSources[0]!.memberId, record(liveB.initial.binding).memberId);
    proof.bInvocation = nextInvocation[0]; proof.bSource = nextSources[0];
  }
  await openInitialChat(liveB);
  proof.bLaunchScreenshot = await screenshot('b-launch'); proof.b = { capture: liveB.capture, definition: liveB.definition, thread: liveB.thread };
  await assertSameLive(liveA, 'after-next-launch', true);
  if (installer) record(proof.installer).settings = await readDesktopEmulatedCodexInstallerSettingsUi(cdp, { fixture, ui,
    assertOwnedRenderer: options.assertOwnedRenderer, expectedStatus: record(record(proof.installer).installedStatus),
    assertPriorRuntime: async phase => { await assertSameLive(liveA, phase, true); await assertSameLive(liveB, phase, true); } });

  await openTeam(a); await openChat(liveA, ui, 'TEST boot ready');
  const before = new Set((await a.commands()).map(row => row.commandId));
  await fill('.message-composer-flat-layout textarea', 'TEST_UI_STREAM');
  await ui.click('button.message-composer-send-button', 'send original held stream once', 'Send');
  const sent = (await poll(a.commands, values => values.some(row => !before.has(row.commandId) &&
    record(row.command).operation === 'message.send' && record(record(row.command).payload).text === 'TEST_UI_STREAM' && row.phase === 'completed'), 'original stream receipt'))
    .filter(row => !before.has(row.commandId) && record(row.command).operation === 'message.send' && record(record(row.command).payload).text === 'TEST_UI_STREAM');
  assert.equal(sent.length, 1); const inputId = record(sent[0]!.effects).deliveryId;
  assert.equal(typeof inputId, 'string'); await visible('TEST stream partial');
  const pending = array((await liveA.session()).inputs).find(row => record(row.intent).inputId === inputId);
  assert.ok(pending); assert.notEqual(pending.phase, 'terminal');
  assert.equal((await effects()).filter(row => row.pid === liveA.thread.pid && row.event === 'input' && row.marker === 'TEST_UI_STREAM').length, 1);
  await openTeam(b); proof.bStop = await stop(liveB);
  const afterBStop = await assertSameLive(liveA, 'after-b-stop-during-a-input', false);
  assert.deepEqual(array(afterBStop.inputs).find(row => record(row.intent).inputId === inputId), pending);
  await openTeam(a);
  await ui.scrollTo('button[aria-label="Back to chats"]', 'original A conversation list after B Stop');
  await ui.click('button[aria-label="Back to chats"]', 'return to original A chats after B Stop');
  await openChat(liveA, ui, 'TEST stream partial');
  await visible('TEST stream partial');
  assert.equal(await cdp.evaluate(`document.body.innerText.includes('TEST stream partial complete')`), false);
  proof.aSurvivedScreenshot = await screenshot('a-survived');
  await writeFile(join(fixture.emulatedRuntime.peers[0]!.root, 'release-stream'), 'TEST release once\n', { mode: 0o600, flag: 'wx' });
  const completed = await poll(liveA.session, value => array(value.inputs).some(row => record(row.intent).inputId === inputId && row.terminal === 'succeeded'), 'original A stream completes');
  assert.equal(array(completed.inputs).length, 2); await visible('TEST stream partial complete');
  proof.completedScreenshot = await screenshot('completed'); proof.stream = { commandId: sent[0]!.commandId, inputId, terminal: 'succeeded', survivedBStop: true };
  proof.aStop = await stop(liveA, true); proof.stoppedScreenshot = await screenshot('stopped');
  const journal = await effects();
  assert.equal(journal.filter(row => row.event === 'thread-selection' && row.runtimeMcp === true).length, 2);
  proof.effects = journal; proof.fixturePins = await verifyDesktopEmulatedRuntimeFixture(fixture);
  await writeFile(join(fixture.root, 'ui-emulated-selection-effects.json'), JSON.stringify(journal, null, 2), { mode: 0o600, flag: 'wx' });
  proof.status = 'PASS'; proof.visualReview = 'Original screenshots require independent inspection';
}
