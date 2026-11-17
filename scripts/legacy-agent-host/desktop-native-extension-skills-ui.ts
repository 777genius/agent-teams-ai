import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EXTENSION_USER_SKILL, EXTENSION_PROJECT_SKILL, EXTENSION_USER_BODY,
  EXTENSION_PROJECT_BODY_A, EXTENSION_PROJECT_BODY_B,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-extensions/model.ts';
import { captureDesktopNativeExtensionSources } from './desktop-native-extension-consumption-fixture.ts';
import { runDesktopNativeExtensionsUiSmoke } from './desktop-native-extensions-ui-smoke.ts';
import { digest } from './desktop-backend-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};

/** Existing Create/Review/Apply/Edit controls write the two sources later consumed by the native Query. */
export async function prepareDesktopNativeExtensionSkillsUi(
  cdp: UiCdpPort,
  options: { root: string; seed: { subject: string }; evidence: Row; assertOwnedRenderer(): void }
) {
  const { root } = options;
  assert.equal(process.env.LEGACY_DESKTOP_EXTENSIONS_CONSUMPTION_UI, '1');
  const steps: Row[] = [];
  const proof: Row = { status: 'INCOMPLETE', steps };
  options.evidence.nativeExtensionSkillsUi = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer, step: row => steps.push(row),
  });
  await ui.observeInput();
  // Existing saved Team selection resolves its cwd through customProjectPaths/repositoryGroups.
  await ui.clickSidebar(options.seed.subject);
  await runDesktopNativeExtensionsUiSmoke(cdp, { ...options, pluginPhase: 'install' });
  await ui.click('[role="tab"]', 'open original Skills tab for the selected project', 'Skills');
  const fill = async (selector: string, text: string) => {
    await ui.scrollTo(selector, 'reveal original skill field ' + selector);
    await ui.click(selector, 'focus original skill field ' + selector);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA',
      modifiers: 4, commands: ['selectAll'] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
    await cdp.send('Input.insertText', { text });
    await ui.waitRead('document.querySelector(' + desktopJsLiteral(selector) + ')?.value===' +
      desktopJsLiteral(text), 'exact original field value');
  };
  const escape = async () => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  };
  const journal = async () => {
    const directory = join(root, 'hoststore/management-commands');
    const names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name));
    assert.ok(names.length <= 16);
    return Promise.all(names.sort().map(async name =>
      record(JSON.parse(await readFile(join(directory, name), 'utf8')))));
  };
  const mutations: Row[] = [];
  const body = (marker: string) => '1. ' + marker +
    '\n2. Arguments: $ARGUMENTS\n3. Use the captured Team message_send tool for the requested TEST reply.';
  const readSource = async (path: string, marker: string) => {
    const until = Date.now() + 25_000;
    for (;;) {
      options.assertOwnedRenderer();
      const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      if (text.includes(marker)) return text;
      assert.ok(Date.now() < until, 'original skill mutation did not publish; no retry');
      await new Promise<void>(done => setTimeout(done, 100));
    }
  };
  const completed = async (before: Row[], scope: 'user' | 'project', path: string, marker: string) => {
    const text = await readSource(path, marker);
    const until = Date.now() + 25_000;
    let after = await journal();
    while (!after.some(row => !before.some(original => original.commandId === row.commandId) && row.phase === 'completed')) {
      options.assertOwnedRenderer();
      assert.ok(Date.now() < until, 'original skill receipt did not complete; mutation is not repeated');
      await new Promise<void>(done => setTimeout(done, 100));
      after = await journal();
    }
    const added = after.filter(row => !before.some(original => original.commandId === row.commandId));
    assert.equal(added.length, 1);
    assert.equal(added[0]!.kind, 'skill.mutation');
    assert.equal(added[0]!.phase, 'completed');
    assert.equal(added[0]!.scope, scope);
    assert.equal(added[0]!.rootKind, 'claude');
    for (const original of before)
      assert.deepEqual(after.find(row => row.commandId === original.commandId), original);
    mutations.push({ commandId: added[0]!.commandId, scope, sourceSha256: digest(text) });
    return text;
  };
  const userPath = join(root, 'native-claude/config/skills', EXTENSION_USER_SKILL, 'SKILL.md');
  const projectPath = join(root, 'workspace/.claude/skills', EXTENSION_PROJECT_SKILL, 'SKILL.md');
  for (const selected of [
    { scope: 'user' as const, name: EXTENSION_USER_SKILL, marker: EXTENSION_USER_BODY, path: userPath },
    { scope: 'project' as const, name: EXTENSION_PROJECT_SKILL, marker: EXTENSION_PROJECT_BODY_A, path: projectPath },
  ]) {
    const before = await journal();
    await ui.click('button', 'Create Skill through original control', 'Create Skill');
    await ui.waitRead('Boolean(document.querySelector("#skill-scope"))', 'original scope selector');
    await ui.click('#skill-scope', 'choose original skill scope');
    await ui.waitRead('[...document.querySelectorAll(\'[role="option"]\')].some(e=>' +
      'e.textContent.trim().startsWith("Project: ")&&!e.hasAttribute("data-disabled")&&e.getAttribute("aria-disabled")!=="true")',
      'actual selected project is available for project skills');
    if (selected.scope === 'user') await ui.click('[role="option"]', 'select original user scope', 'User');
    else await ui.clickExpression('(() => {const rows=[...document.querySelectorAll(\'[role="option"]\')]' +
      '.filter(e=>e.textContent.trim().startsWith("Project: ")&&!e.hasAttribute("data-disabled"));' +
      'if(rows.length!==1)return null;const e=rows[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);' +
      'return r.width>0&&r.height>0&&hit&&(e===hit||e.contains(hit))?{x,y}:null;})()',
      'select original project scope');
    await fill('#skill-name', selected.name);
    await fill('#skill-folder', selected.name);
    await fill('#skill-description', 'TEST R10 ' + selected.scope + ' skill created through original UI');
    await fill('#skill-steps', body(selected.marker));
    await ui.click('[role="dialog"] button', 'review original skill create', 'Review And Create');
    await ui.waitRead('document.body.innerText.includes("Review skill changes")&&document.body.innerText.includes(' +
      desktopJsLiteral(selected.path.slice(0, -'/SKILL.md'.length)) + ')', 'review binds the exact chosen native root');
    await ui.click('[role="dialog"] button', 'confirm original skill create once', 'Create Skill');
    await completed(before, selected.scope, selected.path, selected.marker);
    await ui.waitRead('!document.querySelector("#skill-name")&&document.body.innerText.includes(' +
      desktopJsLiteral(selected.name) + ')', 'created skill is visible');
    await escape();
  }
  await fill('input[placeholder="Search by skill name or what it helps with..."]', EXTENSION_PROJECT_SKILL);
  await ui.clickExpression('(() => {const rows=[...document.querySelectorAll(".skills-grid button")]' +
    '.filter(e=>e.querySelector("h3")?.textContent.trim()===' + desktopJsLiteral(EXTENSION_PROJECT_SKILL) +
    ');if(rows.length!==1)return null;const e=rows[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);' +
    'return r.width>0&&r.height>0&&hit&&(e===hit||e.contains(hit))?{x,y}:null;})()',
    'open the original project skill card');
  await ui.click('[role="dialog"] button', 'edit original project skill', 'Edit Skill');
  const beforeEdit = await journal();
  await fill('#skill-steps', body(EXTENSION_PROJECT_BODY_B));
  await ui.click('[role="dialog"] button', 'review project body B', 'Review And Save');
  await ui.waitRead('document.body.innerText.includes(' + desktopJsLiteral(EXTENSION_PROJECT_BODY_B) + ')',
    'original edit review shows B');
  await ui.click('[role="dialog"] button', 'save project body B once', 'Save Skill');
  const edited = await completed(beforeEdit, 'project', projectPath, EXTENSION_PROJECT_BODY_B);
  assert.equal(edited.includes(EXTENSION_PROJECT_BODY_A), false);
  await ui.waitRead('!document.querySelector("#skill-steps")', 'original edit completed');
  await escape();
  const sources = await captureDesktopNativeExtensionSources(root);
  proof.mutations = mutations;
  proof.namespaceSha256 = sources.namespaceSha256;
  proof.installedPlugin = sources.plugin;
  proof.skillSources = mutations.map(row => ({ commandId: row.commandId, scope: row.scope,
    sourceSha256: row.sourceSha256 }));
  proof.status = 'PASS';
  await ui.clickSidebar(options.seed.subject);
  return sources;
}
