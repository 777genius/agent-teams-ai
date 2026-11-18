import assert from 'node:assert/strict';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { revealDesktopTaskReviewCard } from './desktop-task-review-card-readiness.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { runDesktopTaskBoardUiSmoke } from './desktop-task-board-ui-smoke.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const json = async (path: string) => record(JSON.parse(await readFile(path, 'utf8')));
const selector = (id: string) => `[data-testid="${id}"]`;

/** Existing Settings, Approved-column editor and human Approve; the TEST app owns its defaults. */
export async function runDesktopReviewFlowUiSmoke(
  cdp: UiCdpPort,
  options: Parameters<typeof runDesktopTaskBoardUiSmoke>[1]
): Promise<void> {
  assert.equal(await realpath(options.root), options.root);
  assert.match(basename(options.root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
  assert.equal(await realpath(join(options.root, 'claude')), join(options.root, 'claude'));
  const profile = await json(join(options.root, 'host-profile.json'));
  assert.equal(record(profile.owner).storageRoot, join(options.root, 'hoststore'));
  assert.equal(profile.principalId, 'TEST-human');
  assert.equal(profile.runtime, undefined, 'this proof never allocates a native provider');
  assert.equal(record(options.evidence.taskReviewCycleUiProof).status, 'PASS');
  const created = record(record(options.evidence.taskBoardUiProof).createReceipt);
  assert.equal(record(created.binding).teamName, 'test-desktop-backend');
  const taskId = String(record(created.effects).taskId);
  assert.match(taskId, /^[a-f0-9-]{36}$/);
  const directory = join(options.root, 'hoststore/teams/test-desktop-backend');
  const taskPath = join(options.root, 'hoststore/tasks/test-desktop-backend', taskId + '.json');
  const boardPath = join(directory, 'kanban-state.json');
  const defaultsPath = join(options.root, 'claude/review-flow-defaults.json');
  const originalTaskBytes = await readFile(taskPath, 'utf8');
  const original = record(JSON.parse(originalTaskBytes));
  assert.equal(original.id, taskId);
  assert.equal(original.status, 'completed');
  assert.equal(original.reviewState, 'none');
  assert.equal((await json(boardPath)).reviewFlow, undefined);
  const commands = async () => {
    const path = join(directory, '.host-owner/commands');
    const files = (await readdir(path)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
    assert.ok(files.length <= 128, 'bounded original TEST command census');
    return Promise.all(files.map(name => json(join(path, name))));
  };
  let priorCommands = await commands();
  const initialCommands = priorCommands;
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE', steps, taskId, sourceSha256: await fileDigest(import.meta.filename),
    scope: 'TEST app defaults, captured Host override/inherit, human acceptance and renderer reopen through existing controls',
  };
  options.evidence.reviewFlowUiProof = proof;
  const step = (value: Record<string, unknown>) => { steps.push(value); };
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step });
  const clickPolicyFooter = (target: string, label: string, text?: string) => ui.click(target, label, text, undefined, {
    scrollBeforeClick: { label: 'reveal ' + label, requireCenterHit: true },
  });
  const waitProduct = async <T>(read: () => Promise<T>, matches: (value: T) => boolean, label: string) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      options.assertOwnedRenderer();
      const value = await read();
      if (matches(value)) return value;
      await delay(100);
    }
    throw new Error(`Review flow read timed out: ${label}; no mutation retry`);
  };
  const newReceipt = async (operation: string, payload: Record<string, unknown>) => {
    const before = new Set(priorCommands.map(row => row.commandId));
    const current = await waitProduct(commands, rows => rows.some(row =>
      !before.has(row.commandId) && row.phase === 'completed'), operation);
    const added = current.filter(row => !before.has(row.commandId));
    assert.equal(added.length, 1, 'one original Host command for one UI action');
    const receipt = added[0]!;
    assert.equal(receipt.phase, 'completed');
    assert.equal(receipt.principalId, 'TEST-human');
    assert.deepEqual(receipt.binding, created.binding);
    assert.equal(record(receipt.command).operation, operation);
    assert.deepEqual(record(receipt.command).payload, payload);
    assert.deepEqual(current.filter(row => before.has(row.commandId)), priorCommands);
    priorCommands = current;
    return receipt;
  };
  const readEditor = (prefix: string, flow: string, inherit?: boolean) => ui.waitRead(
    `Boolean(document.querySelector(${desktopJsLiteral(selector(prefix + '-' + flow))})?.checked)` +
      (inherit === undefined ? '' : `&&document.querySelector(${desktopJsLiteral(selector(prefix + '-use-default'))})?.getAttribute('aria-checked')===${desktopJsLiteral(String(inherit))}`),
    `persisted ${flow} ${inherit === undefined ? 'default' : inherit ? 'inheritance' : 'override'}`
  );
  const openPanel = async () => {
    const trigger = selector('kanban-approved-settings');
    for (let attempt = 0; attempt <= 12; attempt++) {
      const geometry = record(await ui.waitRead(`(() => {
        const e=[...document.querySelectorAll(${desktopJsLiteral(trigger)})].find(e=>e.getClientRects().length);if(!e)return null;
        const r=e.getBoundingClientRect();let p=e.parentElement;
        while(p&&!(p.scrollWidth>p.clientWidth&&/auto|scroll/.test(getComputedStyle(p).overflowX)))p=p.parentElement;
        if(!p)return {visible:true};const b=p.getBoundingClientRect(),left=Math.max(0,b.left),right=Math.min(innerWidth,b.right);
        return {visible:r.left>=left&&r.right<=right,x:(left+right)/2,y:Math.max(1,Math.min(innerHeight-1,b.y+b.height/2)),deltaX:Math.max(-600,Math.min(600,r.x+r.width/2-(left+right)/2))};
      })()`, 'original Approved settings viewport'));
      if (geometry.visible === true) break;
      assert.ok(attempt < 12, 'original Approved settings must be visible before one click');
      options.assertOwnedRenderer();
      step({ action: 'mouseWheel', label: 'reveal original Approved settings', ...geometry });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: geometry.x, y: geometry.y,
        deltaX: geometry.deltaX, deltaY: 0 });
      await delay(100);
    }
    await ui.scrollTo(trigger, 'original Approved settings');
    await ui.click(trigger, 'open original team Review flow');
  };
  const saveTeam = async (settings: Record<string, unknown> | null) => {
    await clickPolicyFooter(selector('kanban-review-flow-save'), 'save one original team review policy');
    const receipt = await newReceipt('task.board.review-flow', { settings });
    await ui.waitRead(`!document.querySelector(${desktopJsLiteral(selector('kanban-review-flow-panel'))})`,
      'original policy panel closes after its save');
    assert.equal(await readFile(taskPath, 'utf8'), originalTaskBytes, 'settings never mutate the original Task');
    return receipt;
  };
  const openDefaults = async () => {
    await clickPolicyFooter(selector('kanban-review-flow-open-settings'), 'open existing default settings link');
    await ui.waitRead(`Boolean(document.querySelector(${desktopJsLiteral(selector('review-flow-settings-page'))}))`,
      'original Review flow Settings page');
  };
  const saveDefaults = async (flow: string) => {
    await ui.click(selector('review-flow-settings-' + flow), 'select TEST app ' + flow);
    await clickPolicyFooter(selector('review-flow-settings-save'), 'save TEST app review default');
    await ui.waitRead(`document.querySelector(${desktopJsLiteral(selector('review-flow-settings-feedback'))})?.textContent.trim()==='Saved'`,
      'original default save acknowledged');
    assert.deepEqual(await json(defaultsPath), { reviewFlow: flow });
    assert.deepEqual(await commands(), priorCommands, 'global defaults retain their Main owner');
    await ui.click('[role="tab"][aria-selected="true"] button[aria-label="Close tab"]', 'close original Settings tab');
  };

  await ui.observeInput();
  await openPanel();
  await readEditor('kanban-review-flow', 'agent_approval', true);
  await openDefaults();
  await readEditor('review-flow-settings', 'agent_approval');
  await saveDefaults('human_approval');
  const humanDefaults = await readFile(defaultsPath, 'utf8');
  await openPanel();
  await readEditor('kanban-review-flow', 'human_approval', true);
  await ui.click(selector('kanban-review-flow-use-default'), 'switch original team to its own review policy');
  await ui.click(selector('kanban-review-flow-lead_then_human'), 'select original Lead sign-off flow');
  const override = await saveTeam({ reviewFlow: 'lead_then_human', reviewFlowPrompt: '' });
  assert.equal((await json(boardPath)).reviewFlow, 'lead_then_human');
  await openPanel();
  await readEditor('kanban-review-flow', 'lead_then_human', false);
  await ui.click(selector('kanban-review-flow-use-default'), 'return original team to app defaults');
  const inherit = await saveTeam(null);
  const inherited = await json(boardPath);
  assert.equal(inherited.reviewFlow, undefined);
  assert.equal(inherited.reviewFlowPrompt, undefined);
  assert.equal(await readFile(defaultsPath, 'utf8'), humanDefaults, 'Host override never copies or changes app defaults');
  await openPanel();
  await readEditor('kanban-review-flow', 'human_approval', true);
  await clickPolicyFooter(selector('kanban-review-flow-panel') + ' button', 'close inherited team policy', 'Cancel');

  const card = `.kanban-task-card[data-task-id="${taskId}"]`;
  const boardEntry = record(inherited.tasks)[taskId];
  await revealDesktopTaskReviewCard({ cdp, ui, card, assertOwnedRenderer: options.assertOwnedRenderer, step,
    expected: { contextId: 'local', teamName: hostTeamSelectionKey(options.handleId), taskId,
      subject: original.subject, status: original.status, reviewState: original.reviewState,
      boardColumn: boardEntry === undefined ? null : record(boardEntry).column ?? null } });
  await ui.hoverExpression(`(() => {const e=document.querySelector(${desktopJsLiteral(card)});if(!e)return null;
    const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`,
    'hover original completed Task for human approval');
  const approvalPoint = record(await ui.waitRead(`(() => {
    const cards=[...document.querySelectorAll('.kanban-task-card[data-state="open"]')];
    if(cards.length!==1||cards[0].dataset.taskId!==${desktopJsLiteral(taskId)})return null;
    const buttons=[...document.querySelectorAll('.kanban-task-card-toolbar[data-state="open"] button[aria-label="Approve"]')].filter(e=>e.getClientRects().length);
    if(buttons.length!==1||buttons[0].disabled)return null;const e=buttons[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
    return hit&&(hit===e||e.contains(hit))?{x,y}:null;
  })()`, 'one original human Approve control'));
  step({ action: 'mouseClick', label: 'original human Approve once', target: approvalPoint, state: 'attempted' });
  for (const type of ['mousePressed', 'mouseReleased']) {
    options.assertOwnedRenderer();
    await cdp.send('Input.dispatchMouseEvent', { type, ...approvalPoint, button: 'left', clickCount: 1 });
  }
  const approval = await newReceipt('task.review', {
    taskId, action: 'approve', notifyOwner: true, suppressTaskComment: true,
  });
  const accepted = await json(taskPath);
  assert.equal(accepted.reviewState, 'approved');
  assert.equal(accepted.status, 'completed');
  assert.ok(Array.isArray(accepted.historyEvents));
  assert.deepEqual(accepted.historyEvents.slice(0, -1), original.historyEvents);
  const humanEvent = record(accepted.historyEvents.at(-1));
  assert.equal(humanEvent.type, 'human_approved');
  assert.equal(humanEvent.actor, 'user');
  const acceptedTaskBytes = await readFile(taskPath, 'utf8');
  const approvedBoardBytes = await readFile(boardPath, 'utf8');
  const origin = await cdp.evaluate('performance.timeOrigin');
  options.assertOwnedRenderer();
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(`performance.timeOrigin!==${desktopJsLiteral(origin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'new renderer retains human approval and inherited defaults');
  await ui.observeInput();
  await ui.clickSidebar(String(original.subject));
  await openPanel();
  await readEditor('kanban-review-flow', 'human_approval', true);
  assert.equal(await readFile(taskPath, 'utf8'), acceptedTaskBytes);
  assert.equal(await readFile(boardPath, 'utf8'), approvedBoardBytes);
  assert.equal(await readFile(defaultsPath, 'utf8'), humanDefaults);
  assert.deepEqual(await commands(), priorCommands, 'reopen never repeats acceptance or settings writes');
  options.assertOwnedRenderer();
  const screenshot = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
  assert.equal(typeof screenshot.data, 'string');
  const screenshotPath = join(options.root, 'ui-review-flow-human-approval.png');
  await writeFile(screenshotPath, Buffer.from(String(screenshot.data), 'base64'), { mode: 0o600, flag: 'wx' });
  await openDefaults();
  await readEditor('review-flow-settings', 'human_approval');
  await saveDefaults('agent_approval');
  assert.equal(await readFile(taskPath, 'utf8'), acceptedTaskBytes);
  assert.equal(await readFile(boardPath, 'utf8'), approvedBoardBytes);
  assert.equal(priorCommands.length - initialCommands.length, 3);
  Object.assign(proof, { status: 'PASS', override, inherit, approval, humanEvent,
    restoredDefault: 'agent_approval', inheritedAfterReload: true,
    screenshot: { path: screenshotPath, sha256: await fileDigest(screenshotPath) } });
}
