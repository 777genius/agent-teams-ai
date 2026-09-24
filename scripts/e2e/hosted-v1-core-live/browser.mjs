import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const nonce = () => randomBytes(12).toString('hex');

function requireResult(result, status, kind, action) {
  if (result.status !== status || result.body?.kind !== kind) {
    throw new Error(`core-live-${action}-failed:${result.status}:${result.body?.kind ?? 'invalid'}`);
  }
  return result.body;
}

async function post(page, path, body, csrfToken) {
  return page.evaluate(async ({ path, body, csrfToken }) => {
    const response = await fetch(path, {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': csrfToken },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (text.length > 64 * 1024) throw new Error('core-live-response-too-large');
    return { status: response.status, body: JSON.parse(text) };
  }, { path, body, csrfToken });
}

async function uiPost(page, path, action) {
  const pending = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === path, { timeout: 30_000 });
  await action();
  const response = await pending;
  return { status: response.status(), body: await response.json() };
}

async function poll(action, timeoutMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await action();
    if (predicate(last)) return last;
    await sleep(500);
  }
  throw new Error(`core-live-poll-timeout:${JSON.stringify(last)?.slice(0, 1200)}`);
}

async function authenticatedStatus(page) {
  const response = await page.evaluate(async () => {
    const value = await fetch('/api/auth/status', { credentials: 'include', cache: 'no-store' });
    return { status: value.status, body: await value.json() };
  });
  if (response.status !== 200 || response.body?.mode !== 'personal' ||
      response.body?.authenticated !== true ||
      response.body?.principal?.authenticationMethod !== 'personal' ||
      response.body?.principal?.role !== 'owner' ||
      !/^usr_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(response.body?.principal?.userId) ||
      !/^[A-Za-z0-9_-]{32,512}$/.test(response.body?.csrfToken)) {
    throw new Error('core-live-personal-session-unavailable');
  }
  return { userId: response.body.principal.userId, token: response.body.csrfToken };
}

async function csrf(page) {
  return (await authenticatedStatus(page)).token;
}

async function publishedTeam(claudeRoot, teamId) {
  const teamsRoot = join(claudeRoot, 'teams');
  const matches = [];
  for (const key of await readdir(teamsRoot)) {
    if (!/^draft-[0-9a-f]{32}$/.test(key)) continue;
    const directory = join(teamsRoot, key);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const identity = JSON.parse(await readFile(join(directory, 'team.identity.json'), 'utf8'));
    if (identity.teamId !== teamId) continue;
    const marker = JSON.parse(await readFile(join(directory,
      '.hosted-draft-publication.json'), 'utf8'));
    if (marker.schemaVersion !== 1 || marker.teamId !== teamId ||
        marker.operationId !== `adoption_${key.slice(6)}`) {
      throw new Error('core-live-published-team-marker-mismatch');
    }
    matches.push({ legacyKey: key, operationId: marker.operationId });
  }
  if (matches.length !== 1) throw new Error('core-live-published-team-not-unique');
  return matches[0];
}

export async function openProductBrowser(origin, pairingCode) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const document = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (document?.status() !== 200) throw new Error('core-live-product-document-unavailable');
    await page.getByLabel('Pairing code').fill(pairingCode);
    await page.getByRole('button', { name: 'Pair this browser' }).click();
    await page.getByRole('complementary', { name: 'Hosted account' }).waitFor({ timeout: 20_000 });
    const { userId, token } = await authenticatedStatus(page);
    const beforeGrant = requireResult(await post(page, '/api/hosted/v1/workspaces/list',
      { schemaVersion: 1 }, token), 200, 'workspace-list', 'workspace-list-before-grant');
    if (beforeGrant.workspaces?.length !== 0) {
      throw new Error('core-live-sandbox-workspace-already-granted');
    }
    return { browser, page, context, token, userId, documentHeaders: document.headers() };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export async function selectGrantedWorkspace(session, grantedWorkspaceId) {
  if (!/^workspace_[0-9a-f]{32}$/.test(grantedWorkspaceId)) {
    throw new Error('core-live-granted-workspace-id-invalid');
  }
  await session.page.reload({ waitUntil: 'domcontentloaded' });
  const status = await authenticatedStatus(session.page);
  if (status.userId !== session.userId) {
    throw new Error('core-live-personal-session-changed-after-grant');
  }
  session.token = status.token;
  const listed = requireResult(await post(session.page, '/api/hosted/v1/workspaces/list',
    { schemaVersion: 1 }, session.token), 200, 'workspace-list', 'workspace-list');
  if (listed.workspaces?.length !== 1 ||
      listed.workspaces[0]?.workspaceId !== grantedWorkspaceId ||
      listed.workspaces[0]?.label !== 'Workspace 1') {
    throw new Error('core-live-public-workspace-not-unique');
  }
  await session.page.getByRole('button', { name: 'Workspace 1', exact: true }).click();
  await session.page.getByRole('heading', { name: 'Create team draft' }).waitFor({ timeout: 20_000 });
  session.publicWorkspaceId = grantedWorkspaceId;
}

export async function createConfiguredTeam(session, { model, claudeRoot }) {
  const workspaceId = session.publicWorkspaceId;
  const teamName = `core-live-${nonce()}`;
  const marker = `CORE_LIVE_${nonce().toUpperCase()}`;
  await session.page.getByLabel('Team name').fill(teamName);
  await session.page.getByRole('combobox', { name: 'Lane 1 runtime' }).click();
  await session.page.getByRole('option', { name: 'OpenCode', exact: true }).click();
  await session.page.getByLabel('Lane 1 OpenCode model').fill(model);
  await session.page.getByLabel('Lane 1 member 1 name').fill('worker');
  await session.page.getByLabel('Lane 1 member 1 model').fill('');
  await session.page.getByLabel('Lane 1 member 1 instructions')
    .fill('Use the assigned sandbox task. Follow the operator command and report its result.');
  const created = requireResult(await uiPost(session.page,
    '/api/hosted/v1/team-configuration/draft/create', () =>
      session.page.getByRole('button', { name: 'Create draft', exact: true }).click()),
  201, 'created', 'create-team');
  const teamId = created.identity?.teamId;
  if (!/^team_[0-9a-f]{32}$/.test(teamId) || created.identity.workspaceId !== workspaceId) {
    throw new Error('core-live-created-team-identity-invalid');
  }
  const published = await publishedTeam(claudeRoot, teamId);
  const publication = requireResult(await post(session.page,
    '/api/hosted/v1/team-configuration/draft/publication', {
      schemaVersion: 1, workspaceId, operationId: published.operationId,
    }, session.token), 200, 'publication', 'team-publication');
  if (publication.teamId !== teamId || publication.publication?.state !== 'published') {
    throw new Error(`core-live-team-publication-unproven:${publication.publication?.state ?? 'missing'}`);
  }
  const saved = requireResult(await post(session.page,
    '/api/hosted/v1/team-configuration/saved-request', {
      schemaVersion: 1, workspaceId, teamId,
    }, session.token), 200, 'found', 'read-team');
  if (saved.draft?.metadata?.name !== teamName ||
      saved.draft?.configuration?.lanes?.[0]?.selectedModel !== model) {
    throw new Error('core-live-team-configuration-mismatch');
  }
  await session.page.reload({ waitUntil: 'domcontentloaded' });
  await session.page.getByRole('button', { name: 'Workspace 1', exact: true }).click();
  const teamRow = session.page.locator(
    `[data-testid="hosted-team-lifecycle-row"][data-team-id="${teamId}"]`
  );
  await teamRow.waitFor({ timeout: 20_000 });
  await teamRow.getByRole('button').click();
  await session.page.getByRole('heading', { name: 'Team configuration' }).waitFor({ timeout: 20_000 });
  return { teamId, teamName, workspaceId, model, marker,
    legacyKey: published.legacyKey, createRevision: created.revision,
    publication: publication.publication };
}

async function lifecycleRevision(session, team) {
  const response = await post(session.page, '/api/teams/lifecycle/read', {
    schemaVersion: 1, cursor: null, expectedRevision: null,
  }, session.token);
  const body = requireResult(response, 200, 'success', 'lifecycle-read');
  const item = body.items?.find(value => value.teamId === team.teamId);
  if (!item || item.workspaceId !== team.workspaceId || !/^revision_/.test(item.revision)) {
    throw new Error('core-live-created-team-lifecycle-missing');
  }
  return item;
}

async function memberIdFromPublishedRoster(claudeRoot, team) {
  const metadata = JSON.parse(await readFile(join(claudeRoot, 'teams', team.legacyKey,
    'members.meta.json'), 'utf8'));
  const worker = metadata.members?.find(member => member.name === 'worker' && !member.removedAt);
  if (worker?.memberId && /^member_[0-9a-f]{32}$/.test(worker.memberId)) return worker.memberId;
  const immutableIdentity = worker?.joinedAt === undefined
    ? worker?.agentId ?? 'worker' : `worker\0${worker.joinedAt}`;
  if (typeof immutableIdentity !== 'string') throw new Error('core-live-worker-roster-missing');
  const digest = createHash('sha256').update(JSON.stringify({
    domain: 'hosted-task-board-member/v1', teamId: team.teamId,
    rawMemberName: immutableIdentity,
  })).digest('hex');
  return `member_${digest.slice(0, 32)}`;
}

export async function exerciseTeam(session, team, { claudeRoot, workspaceRoot }) {
  if (!/^\/tmp\/hosted-core-issuer-[A-Za-z0-9_-]+\/sandbox-project$/.test(workspaceRoot)) {
    throw new Error('core-live-sandbox-workspace-path-invalid');
  }
  await session.page.reload({ waitUntil: 'domcontentloaded' });
  await session.page.getByRole('button', { name: 'Workspace 1', exact: true }).click();
  const teamRow = session.page.locator(
    `[data-testid="hosted-team-lifecycle-row"][data-team-id="${team.teamId}"]`
  );
  await teamRow.waitFor({ timeout: 20_000 });
  await teamRow.getByRole('button').click();
  session.token = await csrf(session.page);
  await lifecycleRevision(session, team);
  const launched = requireResult(await uiPost(session.page,
    '/api/hosted/v1/team-lifecycle/launch', () =>
      session.page.getByRole('button', { name: 'Launch', exact: true }).click()),
  202, 'accepted', 'launch');
  if (launched.teamId !== team.teamId || launched.workspaceId !== team.workspaceId) {
    throw new Error('core-live-ui-launch-identity-mismatch');
  }
  const control = await poll(() => post(session.page,
    '/api/hosted/v1/team-lifecycle/control-state', {
      schemaVersion: 1, workspaceId: team.workspaceId, teamId: team.teamId,
    }, session.token), 120_000, response => response.status === 200 &&
      response.body?.kind === 'control_state' && response.body.runId === launched.runId);
  const ownerId = await poll(async () => {
    try { return await memberIdFromPublishedRoster(claudeRoot, team); }
    catch { return null; }
  }, 120_000, value => typeof value === 'string');
  const subject = `Sandbox task ${team.marker}`;
  await session.page.getByLabel('New task title').fill(subject);
  const taskResult = await uiPost(session.page, '/api/hosted/v1/team-task-board/mutations', () =>
    session.page.getByRole('button', { name: 'Save task', exact: true }).click());
  if (taskResult.status !== 200 || taskResult.body?.outcome !== 'committed') {
    throw new Error(`core-live-create-assigned-task-failed:${taskResult.status}:${taskResult.body?.kind ?? taskResult.body?.outcome ?? 'invalid'}`);
  }
  const task = taskResult.body;
  const taskId = task.affectedTaskIds?.[0];
  if (!/^task_[0-9a-f]{32}$/.test(taskId)) throw new Error('core-live-task-id-missing');
  const taskRow = session.page.locator(`[data-task-id="${taskId}"]`);
  await taskRow.waitFor({ timeout: 20_000 });
  await taskRow.getByLabel(`Owner for ${subject}`).fill(ownerId);
  const assignment = await uiPost(session.page, '/api/hosted/v1/team-task-board/mutations', () =>
    taskRow.getByRole('button', { name: 'Save owner' }).click());
  if (assignment.status !== 200 || assignment.body?.outcome !== 'committed' ||
      !assignment.body?.affectedTaskIds?.includes(taskId)) {
    throw new Error('core-live-ui-task-assignment-unproven');
  }
  // This nonce is created only after launch/assignment. A startup reply cannot satisfy it.
  const commandMarker = `CORE_EXEC_${nonce().toUpperCase()}`;
  const command = `printf '%s' '${commandMarker}' > '${workspaceRoot}/command-proof.txt'`;
  const issuedAtMs = Date.now();
  await session.page.getByLabel('New message')
    .fill(`Run this exact shell command in the sandbox:\n${command}\nAfter it succeeds, complete the assigned task and send a team reply containing ${commandMarker}.`);
  const sent = requireResult(await uiPost(session.page,
    '/api/hosted/v1/team-messages/send', () =>
      session.page.getByRole('button', { name: 'Send', exact: true }).click()),
  200, 'persisted', 'send-message');
  if (sent.receipt?.runtimeDelivery !== 'delivered') {
    throw new Error(`core-live-message-not-delivered:${sent.receipt?.runtimeDelivery ?? 'missing'}`);
  }
  const operatorMessage = session.page.locator(
    `[data-testid="hosted-team-message"][data-message-id="${sent.receipt.messageId}"]`);
  await operatorMessage.waitFor({ timeout: 20_000 });
  if ((await operatorMessage.locator('p').first().textContent())?.trim() !== 'You' ||
      !(await operatorMessage.locator('p').nth(1).textContent())?.includes(commandMarker)) {
    throw new Error('core-live-operator-command-not-rendered');
  }
  const domObservation = await poll(async () => {
    await session.page.getByRole('button', { name: 'Refresh task board' }).click();
    await session.page.getByRole('button', { name: 'Refresh messages' }).click();
    const completed = await taskRow.getByText('completed', { exact: true }).count() === 1;
    const replies = session.page.getByTestId('hosted-team-message').filter({ hasText: commandMarker });
    let peerReplyId = null;
    for (let index = 0; index < await replies.count(); index += 1) {
      const reply = replies.nth(index);
      const id = await reply.getAttribute('data-message-id');
      if (id !== sent.receipt.messageId &&
          (await reply.locator('p').first().textContent())?.trim() === 'Team' &&
          (await reply.locator('p').nth(1).textContent())?.includes(commandMarker)) {
        peerReplyId = id;
      }
    }
    return { completed, peerReplyId };
  }, 180_000, value => value.completed && /^message_[0-9a-f]{32}$/.test(value.peerReplyId));
  const completed = requireResult(await post(session.page,
    '/api/hosted/v1/team-task-board/page', {
      schemaVersion: 1, teamId: team.teamId, cursor: null,
      expectedSourceGeneration: null, limit: 50,
    }, session.token), 200, 'task_board_page', 'task-board-read');
  const reply = requireResult(await post(session.page,
    '/api/hosted/v1/team-messages/page', {
      schemaVersion: 1, teamId: team.teamId, cursor: null,
      expectedSourceGeneration: null, limit: 50,
    }, session.token), 200, 'message_page', 'message-page-read');
  if (!completed.items?.some(item => item.taskId === taskId && item.ownerId === ownerId &&
      item.status === 'completed') || !reply.messages?.some(message =>
      message.messageId === sent.receipt.messageId && message.direction === 'operator' &&
      message.text.includes(commandMarker)) || !reply.messages?.some(message =>
      message.messageId === domObservation.peerReplyId && message.direction === 'team' &&
      message.text.includes(commandMarker) && message.createdAtMs >= issuedAtMs)) {
    throw new Error('core-live-dom-state-not-backed-by-canonical-read');
  }
  return { launch: launched, control: control.body, message: sent.receipt,
    taskId, ownerId, taskRevision: assignment.body.revision, domObservation,
    command, commandMarker, commandIssuedAtMs: issuedAtMs,
    completedTask: completed.items.find(item => item.taskId === taskId),
    agentReply: reply.messages.find(message => message.messageId === domObservation.peerReplyId),
  };
}
