import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { ownerRoutingRow as row } from './desktop-owner-routing-fixture.ts';
import { bounded } from './desktop-proof-bounds.ts';
import { desktopJsLiteral as literal } from './desktop-ui-controls.ts';

import type { DesktopCdpPort } from './desktop-captured-app.ts';
import type { OwnerRoutingRow as Row } from './desktop-owner-routing-fixture.ts';
import type { createDesktopUiControls } from './desktop-ui-controls.ts';

/** Original UI navigation, filtering and reads within the caller's existing epoch and deadline. */
export async function assertDesktopOwnerRoutingAvailability(options: {
  cdp: DesktopCdpPort; ui: ReturnType<typeof createDesktopUiControls>; evidence: Row;
  root: string; deadline: number; assertCurrent(): void; contextId: string;
  discovery: Row; aPublic: Row; bPublic: Row; bTask: Row; openTeam(): Promise<void>;
}): Promise<void> {
  const { cdp, ui, assertCurrent, contextId, aPublic, bPublic, bTask } = options;
  const a = hostTeamSelectionKey(String(row(aPublic.handle).handleId));
  const b = hostTeamSelectionKey(String(row(bPublic.handle).handleId));
  assert.match(String(aPublic.ownerResourceRef), /^[a-f0-9]{64}$/);
  assert.match(String(bPublic.ownerResourceRef), /^[a-f0-9]{64}$/);
  assert.notEqual(aPublic.ownerResourceRef, bPublic.ownerResourceRef);
  const task = row(bTask.task), receipt = row(bTask.receipt);
  assert.deepEqual(bTask.handle, bPublic.handle);
  assert.equal(typeof task.id, 'string'); assert.equal(typeof task.subject, 'string');
  assert.equal(receipt.phase, 'completed'); assert.equal(row(receipt.command).operation, 'task.create');
  assert.equal(row(receipt.effects).taskId, task.id); assert.equal(row(receipt.result).id, task.id);
  assert.equal(row(row(receipt.command).payload).subject, task.subject);
  assert.equal(options.discovery.state, 'ready', 'Partial UI proof requires original ready discovery');
  assert.ok(Array.isArray(options.discovery.bindings) && Array.isArray(options.discovery.unavailableOwners));
  assert.deepEqual(options.discovery.bindings.filter(value => row(row(value).handle).handleId === row(bPublic.handle).handleId), [bPublic]);
  const aTeamNames = new Set(options.discovery.bindings.filter(value =>
    row(value).ownerResourceRef === aPublic.ownerResourceRef).map(value => {
    const handleId = row(row(value).handle).handleId;
    assert.ok(typeof handleId === 'string' && handleId.length > 0);
    return hostTeamSelectionKey(handleId);
  }));
  assert.ok(aTeamNames.has(a), 'Original A binding must remain captured');
  const unavailable = options.discovery.unavailableOwners.map(row);
  assert.equal(unavailable.length, 1); assert.equal(unavailable[0]!.kind, 'owner');
  assert.equal(unavailable[0]!.ownerResourceRef, aPublic.ownerResourceRef);
  assert.ok(['unavailable', 'shutting-down'].includes(String(unavailable[0]!.code)));
  assert.ok(['not-dispatched', 'rejected', 'unknown'].includes(String(unavailable[0]!.outcome)));
  const identity = { contextId, teamName: b, taskId: task.id, ownerResourceRef: bPublic.ownerResourceRef };
  const proof: Row = { status: 'INCOMPLETE', identity, originalUnavailableOwners: unavailable, observations: [] };
  options.evidence.availability = proof;
  const observations = proof.observations as Row[];
  const remaining = (maximum = 30_000) => {
    assertCurrent(); const value = Math.min(maximum, options.deadline - Date.now());
    assert.ok(value > 0, 'Original owner availability deadline'); return value;
  };
  const action = async <T>(operation: () => Promise<T>): Promise<T> => {
    const timeoutMs = remaining(Number.MAX_SAFE_INTEGER);
    const value = await bounded(operation(), timeoutMs, 'original availability action'); remaining(); return value;
  };
  const click = (...args: Parameters<typeof ui.click>) => action(() => ui.click(...args));
  const scrollTo = (...args: Parameters<typeof ui.scrollTo>) => action(() => ui.scrollTo(...args));
  const send = async (method: string, params: Record<string, unknown>, maximum = 30_000) => {
    const timeoutMs = remaining(maximum);
    const value = await bounded(cdp.send(method, params, timeoutMs), timeoutMs, 'original availability input'); remaining(); return value;
  };
  const read = async (expression: string, label: string) => {
    const timeoutMs = remaining();
    const value = await bounded(ui.waitRead(expression, label, timeoutMs), timeoutMs, label); remaining(); return value;
  };
  const screenshot = async (name: string) => {
    const image = row(await send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 5000));
    assertCurrent(); assert.equal(typeof image.data, 'string');
    const bytes = Buffer.from(String(image.data), 'base64'), path = join(options.root, 'ui-owner-routing-' + name + '.png');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(bytes.readUInt32BE(16) >= 640 && bytes.readUInt32BE(20) >= 480);
    await action(() => writeFile(path, bytes, { flag: 'wx', mode: 0o600 }));
    const sha256 = await action(() => fileDigest(path)); return { path, sha256 };
  };
  const setSearch = async (selector: string, value: string) => {
    await click(selector, 'original availability search');
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA',
        windowsVirtualKeyCode: 65, modifiers: process.platform === 'darwin' ? 4 : 2 });
    }
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
    if (value) await send('Input.insertText', { text: value });
    await read('document.querySelector(' + literal(selector) + ')?.value===' + literal(value), 'original availability filter retained');
  };
  const targets = { teams: '[data-team-name=' + literal(b) + ']',
    tasks: '#sidebar-tasks-panel [data-task-key=' + literal(JSON.stringify([b, task.id])) + ']' };
  const observe = async (surface: 'teams' | 'tasks', filtered: boolean) => {
    const collection = surface === 'teams' ? 'teams' : 'globalTasks';
    const notice = '[data-team-aggregate-notice="' + surface + '"]';
    const value = row(await read('(() => {const s=window.__agentTeamsDevStore?.getState();' +
      'if(!s||s.activeContextId!==' + literal(contextId) + '||s[' + literal(collection + 'Loading') + ']||s[' + literal(collection + 'Error') + ']!==null)return null;' +
      'const items=s[' + literal(collection) + '],unavailable=s[' + literal(collection + 'Unavailable') + '];' +
      'if(!Array.isArray(items)||!Array.isArray(unavailable)||!unavailable.length||unavailable.length>16)return null;' +
      'const healthy=items.filter(e=>e.teamName===' + literal(b) + (surface === 'tasks' ? '&&e.id===' + literal(task.id) : '') + ');' +
      'const notices=[...document.querySelectorAll(' + literal(notice) + ')];if(healthy.length!==1||notices.length!==1)return null;' +
      'const n=notices[0],r=n.getBoundingClientRect(),targets=[...document.querySelectorAll(' + literal(targets[surface]) + ')];' +
      'if(["data-state","data-team-count","data-owner-count","data-loaded-count"].some(key=>!n.hasAttribute(key)))return null;' +
      'return {contextId:s.activeContextId,loaded:items.length,unavailable,healthy:healthy[0],targets:targets.length,' +
      'notice:{state:n.getAttribute("data-state"),teams:Number(n.getAttribute("data-team-count")),owners:Number(n.getAttribute("data-owner-count")),' +
      'loaded:Number(n.getAttribute("data-loaded-count")),visible:r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight,' +
      'loadedLabel:[...n.querySelectorAll("*")].some(e=>e.textContent?.trim()===items.length+" loaded"),' +
      'unknownCount:n.textContent.toLowerCase().includes("team count unknown"),refresh:[...n.querySelectorAll("button")].some(e=>e.textContent.trim()==="Refresh"&&!e.disabled)}};})()',
      'original ' + surface + ' partial availability'));
    const rows = value.unavailable as Row[], noticeValue = row(value.notice), healthy = row(value.healthy);
    assert.ok(rows.length > 0 && rows.length <= 16);
    assert.ok(rows.every(entry => ['busy', 'unavailable', 'shutting-down'].includes(String(entry.code)) &&
      ['not-dispatched', 'rejected', 'unknown'].includes(String(entry.outcome)) &&
      (entry.kind === 'owner' ? entry.ownerResourceRef === aPublic.ownerResourceRef : entry.kind === 'team' && typeof entry.teamName === 'string' && aTeamNames.has(entry.teamName))));
    assert.equal(rows.filter(entry => entry.kind === 'owner').length, 1);
    assert.equal(healthy.teamName, b); assert.equal(healthy.ownerResourceRef, bPublic.ownerResourceRef);
    if (surface === 'tasks') {
      assert.equal(healthy.id, task.id); assert.equal(healthy.subject, task.subject); assert.equal(healthy.status, task.status);
    }
    assert.equal(value.targets, filtered ? 0 : 1);
    assert.deepEqual(noticeValue, { state: 'partial', teams: rows.filter(entry => entry.kind === 'team').length,
      owners: rows.filter(entry => entry.kind === 'owner').length, loaded: value.loaded,
      visible: true, loadedLabel: true, unknownCount: true, refresh: true });
    const observation = { surface, filtered, contextId: value.contextId, loaded: value.loaded,
      unavailable: rows, healthy, notice: noticeValue, screenshot: await screenshot(surface + (filtered ? '-filtered' : '')) };
    observations.push(observation);
  };
  await click('button[aria-label="More actions"]', 'open original availability menu');
  await click('button', 'open original available Teams list', 'Teams');
  await scrollTo(targets.teams, 'original healthy B Team');
  await observe('teams', false);
  const teamSearch = 'input[aria-label="Search teams..."]', absent = 'TEST-original-owner-no-matching-result';
  await setSearch(teamSearch, absent); await observe('teams', true); await setSearch(teamSearch, '');
  await action(options.openTeam);
  await read('window.__agentTeamsDevStore?.getState().selectedTeamName===' + literal(b), 'original B navigation remains usable');
  const sidebar = row(await read('({collapsed:window.__agentTeamsDevStore?.getState().sidebarCollapsed})', 'original Tasks sidebar state'));
  assert.equal(typeof sidebar.collapsed, 'boolean');
  if (sidebar.collapsed) await click('button[aria-label="Expand sidebar"]', 'open original global Tasks');
  await scrollTo(targets.tasks, 'original healthy B Task'); await observe('tasks', false);
  await click('#sidebar-tasks-panel button[aria-label="Search tasks..."]', 'open original global Task search');
  const taskSearch = '#sidebar-tasks-panel input[placeholder="Search tasks..."]';
  await setSearch(taskSearch, absent); await observe('tasks', true); await setSearch(taskSearch, '');
  const taskButton = targets.tasks + ' [data-testid="sidebar-task-detail"]';
  await scrollTo(taskButton, 'original B Task detail'); await click(taskButton, 'open exact original B Task');
  const taskKey = JSON.stringify([contextId, b, task.id]);
  proof.openedTask = await read('(() => {const s=window.__agentTeamsDevStore?.getState(),d=s?.globalTaskDetail,e=s?.taskDetailById[' + literal(taskKey) + '];' +
    'return d?.contextId===' + literal(contextId) + '&&d.teamName===' + literal(b) + '&&d.taskId===' + literal(task.id) +
    '&&e?.phase==="ready"&&!e.loading&&!e.refreshPending&&e.full?.id===' + literal(task.id) + '&&e.full.subject===' + literal(task.subject) +
    '&&[...document.querySelectorAll(\'[role="dialog"]\')].some(n=>n.getClientRects().length&&n.textContent.includes(' + literal(task.subject) + '))' +
    '?{contextId:d.contextId,teamName:d.teamName,taskId:d.taskId,phase:e.phase}:null;})()', 'original healthy B Task fully read');
  proof.taskScreenshot = await screenshot('task-opened');
  remaining(); proof.status = 'PASS';
}
