import { acquireProfileWriterLease } from '../../packages/legacy-agent-host/dist/adapters/profile/ProfileWriterLease.js';
import assert from 'node:assert/strict';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createFilesystemTeamOwner } from '../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import { fileDigest, digest } from './desktop-backend-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as unknown;
const names = ['test-cross-alpha', 'test-cross-beta'] as const;
const labels = ['TEST Cross Alpha', 'TEST Cross Beta'] as const;
const subjects = ['TEST Cross Alpha seed', 'TEST Cross Beta seed'] as const;

/** Before app startup only. Adds finite offline TEST owners to the same captured profile. */
export async function prepareDesktopCrossTeamUiFixture(root: string) {
  assert.equal(await realpath(root), root);
  assert.match(basename(root), /^TEST-desktop-backend-/);
  const profilePath = join(root, 'host-profile.json'),
    descriptorPath = join(root, 'desktop-descriptor.json');
  const profile = (await json(profilePath)) as TeamHostProfile;
  assert.equal(profile.owner.storageRoot, join(root, 'hoststore'));
  assert.equal(profile.principalId, 'TEST-human');
  assert.equal(profile.runtime, undefined, 'offline product fixture cannot start providers');
  const descriptor = record(await json(descriptorPath));
  assert.ok(Array.isArray(descriptor.handles) && descriptor.handles.length === 1);
  const original = record(descriptor.handles[0]);
  const base = profile.teams[0];
  assert.ok(base);
  const lease = acquireProfileWriterLease(profile.owner.storageRoot);
  try {
    lease.assertCurrent();
    for (const [index, name] of names.entries()) {
      assert.ok(!profile.teams.some((team) => team.binding.teamName === name));
      const binding = {
        backendId: profile.owner.ownerId,
        teamId: `TEST-cross-${index}`,
        teamName: name,
      };
      const scope = { ...base.scope, teamId: binding.teamId, runId: `TEST-cross-run-${index}` };
      const definition: TeamHostProfile['teams'][number] = {
        binding,
        scope,
        members: [
          {
            name: 'team-lead',
            memberId: 'lead',
            role: 'lead',
            delivery: { ...binding, runId: scope.runId, memberId: 'lead', generation: '1' },
          },
        ],
        grants: [
          {
            principalId: 'TEST-human',
            memberName: 'user',
            permissions: ['read', 'message.write', 'task.write', 'admin'],
          },
        ],
      };
      profile.teams.push(definition);
      const owner = createFilesystemTeamOwner({ root: profile.owner.storageRoot, ...definition });
      owner.connect('TEST-human').execute({
        commandId: `TEST-cross-seed-${index}`,
        operation: 'task.create',
        payload: { subject: subjects[index]! },
      });
      descriptor.handles.push({
        ...original,
        handleId: `TEST-cross-handle-${index}`,
        label: labels[index],
        scope,
        members: [{ memberId: 'lead', label: 'team-lead' }],
      });
    }
    const profileBytes = JSON.stringify(profile);
    await writeFile(profilePath, profileBytes, { mode: 0o600 });
    assert.ok(Array.isArray(descriptor.owners) && descriptor.owners.length === 1);
    const owner = record(descriptor.owners[0]),
      client = record(owner.profile),
      env = record(client.env);
    assert.equal(env.LEGACY_AGENT_HOST_PROFILE_PATH, profilePath);
    env.LEGACY_AGENT_HOST_PROFILE_SHA256 = digest(profileBytes);
    const descriptorBytes = JSON.stringify(descriptor);
    await writeFile(descriptorPath, descriptorBytes, { mode: 0o600 });
    return {
      appEnvironment: { AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256: digest(descriptorBytes) },
      pins: { profileSha256: digest(profileBytes), descriptorSha256: digest(descriptorBytes) },
    };
  } finally {
    lease.release();
  }
}

/** Original Composer/team selector, Send, target view and Reply; no renderer API mutation. */
export async function runDesktopCrossTeamUiSmoke(
  cdp: UiCdpPort,
  options: { root: string; assertOwnedRenderer(): void; evidence: Record<string, unknown> }
) {
  assert.equal(await realpath(options.root), options.root);
  assert.match(basename(options.root), /^TEST-desktop-backend-/);
  const profile = record(await json(join(options.root, 'host-profile.json')));
  assert.equal(profile.runtime, undefined, 'this proof qualifies product effects only');
  const steps: Record<string, unknown>[] = [],
    proof: Record<string, unknown> = {
      status: 'INCOMPLETE',
      steps,
      scope:
        'Original existing Messages cross-Team selector/Send, target Reply through same Composer, canonical source/target receipts and reload',
      excluded: ['native provider input/response', 'cross-owner protocol', 'full M05', 'Stage2'],
      sourceSha256: await fileDigest(import.meta.filename),
    };
  options.evidence.crossTeamUiProof = proof;
  const step = (row: Record<string, unknown>) =>
    steps.push({ monotonicMs: Math.round(performance.now()), ...row });
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step,
  });
  const commands = async (name: string) => {
    const directory = join(options.root, 'hoststore/teams', name, '.host-owner/commands');
    const files = (await readdir(directory)).filter((file) => /^[A-Za-z0-9_-]+\.json$/.test(file));
    assert.ok(files.length <= 64);
    return Promise.all(files.map(async (file) => record(await json(join(directory, file)))));
  };
  const sourceReceipts = async (name: string) =>
    (await commands(name)).filter((row) => row.family === 'cross-team');
  const waitProduct = async (read: () => Promise<Record<string, unknown>[]>, label: string) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      options.assertOwnedRenderer();
      const rows = await read();
      assert.ok(rows.length <= 1, 'one original cross-Team command without duplicate effects');
      if (rows.length === 1 && rows[0]!.phase === 'completed') return rows;
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    throw new Error(`Missing original product outcome: ${label}; no repeated Send`);
  };
  await ui.observeInput();
  await ui.clickSidebar(subjects[0]);
  await ui.click('button[aria-label^="Group chat,"]', 'open original source Group chat');
  await ui.waitRead(
    "Boolean(document.querySelector('.message-composer-flat-layout textarea'))",
    'original group Composer'
  );
  await ui.click(
    '.message-composer-flat-layout button[aria-label^="Select Team:"]',
    'open original Team selector'
  );
  const targetText = await ui.waitRead(
    `(() => {const rows=[...document.querySelectorAll('[data-radix-popper-content-wrapper] button')].filter(e=>[...e.querySelectorAll('div.truncate')].some(d=>d.textContent.trim()===${desktopJsLiteral(labels[1])}));return rows.length===1?rows[0].textContent.trim():null;})()`,
    'one original target row'
  );
  assert.equal(typeof targetText, 'string');
  await ui.click(
    '[data-radix-popper-content-wrapper] button',
    'choose original same-Host target',
    String(targetText)
  );
  await ui.click('.message-composer-flat-layout textarea', 'focus original cross-Team Composer');
  await cdp.send('Input.insertText', { text: 'TEST_CROSS_TEAM_ONE' });
  await ui.click('button.message-composer-send-button', 'original cross-Team Send once', 'Send');
  const originals = await waitProduct(() => sourceReceipts(names[0]), 'first source receipt');
  const original = originals[0]!;
  assert.equal(original.phase, 'completed');
  const intent = record(original.intent),
    pair = record(intent.pair),
    request = record(intent.request);
  assert.equal(record(pair.source).teamName, names[0]);
  assert.equal(record(pair.target).teamName, names[1]);
  assert.equal(request.text, 'TEST_CROSS_TEAM_ONE');
  assert.equal(original.commandId, request.messageId);
  await ui.clickSidebar(subjects[1]);
  await ui.click('button[aria-label^="Group chat,"]', 'open original target Group chat');
  await ui.waitRead(
    "document.body.innerText.includes('TEST_CROSS_TEAM_ONE')",
    'canonical target message visible'
  );
  const point = record(
    await ui.waitRead(
      `(() => {const rows=[...document.querySelectorAll('article')].filter(e=>e.innerText.includes('TEST_CROSS_TEAM_ONE'));if(rows.length!==1)return null;const r=rows[0].getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`,
      'original target message row'
    )
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await ui.click('button[aria-label="Reply to message"]', 'reply through existing message action');
  await ui.waitRead(
    `document.querySelector('.message-composer-flat-layout button[aria-label^="Select Team:"]')?.textContent.includes(${desktopJsLiteral(labels[0])})`,
    'Reply selected exact original source'
  );
  await ui.click('.message-composer-flat-layout textarea', 'focus original reply Composer');
  await cdp.send('Input.insertText', { text: 'TEST_CROSS_TEAM_TWO' });
  await ui.click('button.message-composer-send-button', 'original reply Send once', 'Send');
  const replies = await waitProduct(() => sourceReceipts(names[1]), 'reply source receipt');
  const reply = replies[0]!;
  assert.equal(reply.phase, 'completed');
  const replyIntent = record(reply.intent),
    replyRequest = record(replyIntent.request);
  assert.equal(replyRequest.conversationId, request.conversationId);
  assert.equal(replyRequest.replyToConversationId, request.conversationId);
  assert.equal(record(record(replyIntent.pair).target).teamName, names[0]);
  for (const name of names) {
    const sent = await json(join(options.root, 'hoststore/teams', name, 'sent-cross-team.json'));
    assert.ok(Array.isArray(sent) && sent.length === 1, 'one canonical source outbox row');
    const targetRows = (await commands(name)).filter(
      (row) => row.family === undefined && row.crossTeam !== undefined
    );
    assert.equal(targetRows.length, 1, 'one ordinary target receipt');
    assert.equal(targetRows[0]!.phase, 'completed');
  }
  await ui.clickSidebar(subjects[0]);
  await ui.waitRead(
    "document.body.innerText.includes('TEST_CROSS_TEAM_TWO')",
    'original source sees reply'
  );
  const screenshot = record(
    await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  );
  const path = join(options.root, 'ui-cross-team-reply.png');
  await writeFile(path, Buffer.from(String(screenshot.data), 'base64'), { mode: 0o600 });
  proof.screenshot = { path, sha256: await fileDigest(path) };
  const before = await Promise.all(names.map(sourceReceipts));
  const origin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: true });
  await ui.waitRead(
    `performance.timeOrigin!==${desktopJsLiteral(origin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'fresh renderer after cross-Team reply'
  );
  await ui.observeInput();
  await ui.clickSidebar(subjects[0]);
  await ui.click('button[aria-label^="Group chat,"]', 'reopen original Group chat after reload');
  await ui.waitRead(
    "document.body.innerText.includes('TEST_CROSS_TEAM_TWO')",
    'original cross-Team history survives reload'
  );
  assert.deepEqual(
    await Promise.all(names.map(sourceReceipts)),
    before,
    'reload issues no new send commands'
  );
  proof.status = 'PASS';
  proof.commandIds = [original.commandId, reply.commandId];
  proof.conversationId = request.conversationId;
}
