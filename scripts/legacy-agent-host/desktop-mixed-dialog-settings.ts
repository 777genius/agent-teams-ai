import { desktopJsLiteral } from './desktop-ui-controls.ts';
import assert from 'node:assert/strict';
import type { createDesktopUiControls, UiCdpPort } from './desktop-ui-controls.ts';

type Controls = ReturnType<typeof createDesktopUiControls>;
const record = (v: unknown): Record<string, unknown> => {
  assert(v && typeof v === 'object' && !Array.isArray(v));
  return v as Record<string, unknown>;
};
export const mixedConfiguredMembers = [
  {
    name: 'bob',
    providerId: 'codex',
    role: 'developer',
    workflow: 'TEST mixed codex workflow: use only the supplied business input.',
  },
  {
    name: 'carol',
    providerId: 'opencode',
    model: 'TEST-local/TEST-model',
    role: 'reviewer',
    workflow: 'TEST mixed opencode workflow: use only the supplied business input.',
  },
] as const;
export const mixedDescription = 'TEST mixed Create saved settings and Launch hydration';

async function expand(cdp: UiCdpPort, ui: Controls, title: string) {
  const value = record(
    await ui.waitRead(
      `(()=>{const rows=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')].filter(e=>e.textContent.includes(${desktopJsLiteral(title)}));return rows.length===1?{id:rows[0].getAttribute('aria-controls'),expanded:rows[0].getAttribute('aria-expanded')}:null})()`,
      title
    )
  );
  if (value.expanded !== 'true') {
    const selector = `[role="dialog"] button[aria-controls=${JSON.stringify(value.id)}]`;
    await ui.scrollTo(selector, title);
    await ui.click(selector, title);
  }
  assert.equal(
    await cdp.evaluate(
      `document.querySelector('[role="dialog"] button[aria-controls='+${desktopJsLiteral(JSON.stringify(value.id))}+']')?.getAttribute('aria-expanded')`
    ),
    'true'
  );
}
async function replace(
  cdp: UiCdpPort,
  ui: Controls,
  selector: string,
  value: string,
  label: string
) {
  await ui.scrollTo(selector, label);
  await ui.click(selector, label);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 4,
    commands: ['selectAll'],
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 4,
  });
  await cdp.send('Input.insertText', { text: value });
  await ui.waitRead(
    `document.querySelector(${desktopJsLiteral(selector)})?.value===${desktopJsLiteral(value)}`,
    label + ' retained'
  );
}
async function checked(cdp: UiCdpPort, ui: Controls, selector: string, value: boolean) {
  await ui.scrollTo(selector, selector);
  const expected = value ? 'checked' : 'unchecked';
  if (
    (await cdp.evaluate(
      `document.querySelector(${desktopJsLiteral(selector)})?.getAttribute('data-state')`
    )) !== expected
  )
    await ui.click(selector, selector);
  await ui.waitRead(
    `document.querySelector(${desktopJsLiteral(selector)})?.getAttribute('data-state')===${desktopJsLiteral(expected)}`,
    selector + ' retained'
  );
}

/** Original controls only. Called before switching the visible Create form to save-only. */
export async function configureMixedCreateSettings(cdp: UiCdpPort, ui: Controls) {
  await ui.scrollTo(
    '[role="dialog"] button[aria-label*=" provider,"]',
    'original explicit lead model'
  );
  if (!(await cdp.evaluate(`Boolean(document.querySelector('[role="dialog"] #lead-effort'))`)))
    await ui.click(
      '[role="dialog"] button[aria-label*=" provider,"]',
      'expand original lead model'
    );
  await ui.scrollTo(
    '[role="dialog"] [data-testid="team-model-selector-model-option"][aria-label^="Opus 4.6"]',
    'original Opus4.6 choice'
  );
  await ui.click(
    '[role="dialog"] [data-testid="team-model-selector-model-option"][aria-label^="Opus 4.6"]',
    'select original Opus4.6'
  );
  await ui.scrollTo('[role="dialog"] button', 'original Medium effort', 'Medium');
  await ui.click('[role="dialog"] button', 'select original Medium effort', 'Medium');
  await checked(cdp, ui, '[role="dialog"] #lead-limit-context', true);
  await expand(cdp, ui, 'Optional launch settings');
  // Explicit Off preserves a known supported setting, rather than assuming the TEST default.
  await ui.scrollTo(
    '[role="dialog"] div:has(> #create-fast-mode) > button',
    'original Fast mode Off',
    'Off'
  );
  await ui.click(
    '[role="dialog"] div:has(> #create-fast-mode) > button',
    'original Fast mode Off',
    'Off'
  );
  await checked(cdp, ui, '[role="dialog"] #create-skip-permissions', true);
  await replace(
    cdp,
    ui,
    '[role="dialog"] #team-prompt',
    'NATIVE_TEAM_ONE',
    'original saved initial lead prompt'
  );
  await expand(cdp, ui, 'Optional team details');
  await replace(
    cdp,
    ui,
    '[role="dialog"] #team-description',
    mixedDescription,
    'original team description'
  );
  await ui.scrollTo('[role="dialog"] button[title="blue"]', 'original blue Team color');
  await ui.click('[role="dialog"] button[title="blue"]', 'original blue Team color');
}

/** Check configured intent independently of effective provider recipes. */
export function assertMixedSavedSettings(state: Record<string, unknown>, workspace: string) {
  const settings = record(state.savedSettings);
  for (const [name, value] of Object.entries({
    cwd: workspace,
    prompt: 'NATIVE_TEAM_ONE',
    model: 'claude-opus-4-6',
    effort: 'medium',
    fastMode: 'off',
    limitContext: true,
    skipPermissions: true,
    syncModelsWithLead: false,
    description: mixedDescription,
    color: 'blue',
  }))
    assert.equal(settings[name], value, 'saved ' + name);
  assert.ok(
    settings.allowExperimentalLocalModels === undefined ||
      settings.allowExperimentalLocalModels === false,
    'experimental local-model override remains disabled'
  );
  assert.equal(settings.worktree, undefined, 'lead worktree remains unselected');
  assert.ok(
    settings.extraCliArgs === undefined || settings.extraCliArgs === '',
    'no unqualified global CLI arguments'
  );
  assert(Array.isArray(state.members));
  const members: Record<string, unknown>[] = state.members.map(record);
  for (const expected of mixedConfiguredMembers) {
    const member: Record<string, unknown> | undefined = members.find(
      (row) => row.name === expected.name
    );
    assert(member);
    for (const [key, value] of Object.entries(expected))
      if (key !== 'name')
        assert.deepEqual(record(member.settings)[key], value, expected.name + ' saved ' + key);
  }
  return structuredClone({
    savedSettings: settings,
    members: state.members
      .map(record)
      .map(({ name, role, settings }) => ({ name, role, settings })),
  });
}

/** Read original Launch controls and its original JSON editor; never inject renderer state. */
export async function assertMixedLaunchHydration(cdp: UiCdpPort, ui: Controls) {
  // The original Launch form unmounts these controls while its optional section is closed.
  // Open it before inspecting the roster/lead on every first/reopened/stopped readback.
  await expand(cdp, ui, 'Optional launch settings');
  await ui.waitRead(
    `(() => {const rows=[...document.querySelectorAll('[role="dialog"] [data-role="member-row"] input[aria-label^="Member "]')];return rows.length===2&&rows[0].value==='bob'&&rows[1].value==='carol';})()`,
    'both original saved provider rows hydrate after expanding their section'
  );
  const lead = '[role="dialog"] button[aria-label*=" provider,"][aria-label*="Opus 4.6"]';
  await ui.waitRead(
    `Boolean(document.querySelector(${desktopJsLiteral(lead)}))`,
    'saved lead model hydrated'
  );
  if (!(await cdp.evaluate(`Boolean(document.querySelector('[role="dialog"] #lead-effort'))`))) {
    await ui.scrollTo(lead, 'saved lead model controls');
    await ui.click(lead, 'expand saved lead model controls');
  }
  await ui.waitRead(
    `document.querySelector('[role="dialog"] #lead-effort')?.textContent.trim()==='Medium'`,
    'saved lead effort hydrated'
  );
  assert.equal(
    await cdp.evaluate(
      `document.querySelector('[role="dialog"] #lead-limit-context')?.getAttribute('data-state')`
    ),
    'checked'
  );
  await expand(cdp, ui, 'Optional launch settings');
  await ui.waitRead(
    `document.querySelector('[role="dialog"] #dialog-prompt')?.value==='NATIVE_TEAM_ONE'`,
    'saved initial prompt hydrated'
  );
  assert.equal(
    await cdp.evaluate(
      `document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')`
    ),
    'checked'
  );
  assert.equal(
    await cdp.evaluate(
      `document.querySelector('[role="dialog"] #launch-fast-mode')?.textContent.trim()`
    ),
    'Off'
  );
  await ui.scrollTo('[role="dialog"] button', 'original hydrated roster JSON', 'Edit as JSON');
  await ui.click('[role="dialog"] button', 'read original hydrated roster JSON', 'Edit as JSON');
  const text = await ui.waitRead(
    `document.querySelector('[role="dialog"] .cm-editor .cm-content')?.textContent`,
    'original roster JSON value'
  );
  const rows = JSON.parse(String(text)) as unknown[];
  assert.equal(rows.length, 2);
  for (const expected of mixedConfiguredMembers) {
    const actual = rows.map(record).find((row) => row.name === expected.name);
    assert(actual);
    for (const [key, value] of Object.entries(expected))
      assert.deepEqual(actual[key], value, expected.name + ' hydrated ' + key);
  }
  await ui.scrollTo('[role="dialog"] button', 'original roster JSON close control', 'Hide JSON');
  await ui.click('[role="dialog"] button', 'close original roster JSON', 'Hide JSON');
  return { prompt: 'NATIVE_TEAM_ONE', members: rows };
}

/** Passive DOM evidence only; no app action or provider invocation. */
export async function startMixedProgressObservation(cdp: UiCdpPort) {
  await cdp.evaluate(`(()=>{
  window.__TEST_mixedProgress=[];
  const sample=()=>{const text=document.body.innerText.split('\\n').filter(line=>/launch|prepar|ready|online|starting|connecting|Claude|Codex|OpenCode/i.test(line)).join('\\n').slice(0,6000);const rows=window.__TEST_mixedProgress;if(text&&rows.at(-1)?.text!==text&&rows.length<80)rows.push({monotonicMs:Math.round(performance.now()),text});};
  window.__TEST_mixedProgressObserver=new MutationObserver(sample);
  window.__TEST_mixedProgressObserver.observe(document.body,{subtree:true,childList:true,characterData:true});sample();
 })()`);
}
export async function finishMixedProgressObservation(cdp: UiCdpPort) {
  return cdp.evaluate(
    `(()=>{window.__TEST_mixedProgressObserver?.disconnect();return window.__TEST_mixedProgress??[]})()`
  );
}
