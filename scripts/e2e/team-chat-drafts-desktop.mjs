#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CdpClient } from './comment-notification/cdp.mjs';

const port = Number(process.env.TEAM_CHAT_DRAFTS_E2E_PORT ?? 9222);
const teamName = process.env.TEAM_CHAT_DRAFTS_E2E_TEAM_NAME;
const projectPath = process.env.TEAM_CHAT_DRAFTS_E2E_PROJECT_PATH;
const shotDir = path.join(os.tmpdir(), 'team-chat-drafts-e2e-shots');

assert(teamName, 'TEAM_CHAT_DRAFTS_E2E_TEAM_NAME is required');
assert(projectPath, 'TEAM_CHAT_DRAFTS_E2E_PROJECT_PATH is required');
assert(
  /(?:sandbox|team-direct-chats-e2e|_sandboxes)/i.test(projectPath),
  `refusing to use a non-test project: ${projectPath}`
);

const groupDraft = '**Group draft**\nkeeps markdown and a long readable line 😀';
const aliceDraft = 'Alice private draft - independent from group';

async function click(client, expression, label) {
  const clicked = await client.evaluate(`(() => {
    const element = ${expression};
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: 'nearest' });
    element.click();
    return true;
  })()`);
  assert.equal(clicked, true, `missing ${label}`);
}

async function setComposer(client, value) {
  await client.waitFor(
    `document.querySelector('textarea') instanceof HTMLTextAreaElement`,
    'hydrated composer',
    10_000
  );
  const changed = await client.evaluate(`(() => {
    const textarea = document.querySelector('textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, ${JSON.stringify(value)});
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    return true;
  })()`);
  assert.equal(changed, true, 'composer textarea must exist');
  await new Promise((resolve) => setTimeout(resolve, 700));
}

async function openTeam(client, mode = 'bottom-sheet') {
  await client.waitFor(
    `Boolean(window.__agentTeamsDevStore?.getState && window.electronAPI?.teams && window.__agentTeamsComposerDraftRepository)`,
    'renderer dev APIs',
    60_000
  );
  await client.evaluate(`(() => {
    const state = window.__agentTeamsDevStore.getState();
    state.openTeamTab(${JSON.stringify(teamName)}, ${JSON.stringify(projectPath)});
    state.setMessagesPanelMode(${JSON.stringify(mode)});
    void state.selectTeam(${JSON.stringify(teamName)});
  })()`);
  await client.waitFor(
    `window.__agentTeamsDevStore.getState().selectedTeamData?.teamName === ${JSON.stringify(teamName)}`,
    'selected disposable draft fixture',
    20_000
  );
}

async function openGroupChat(client) {
  const alreadyOpen = await client.evaluate(
    `Boolean(document.querySelector('button[aria-label="Back to chats"]'))`
  );
  if (!alreadyOpen) {
    await client.waitFor(
      `Array.from(document.querySelectorAll('button')).some((button) => button.getAttribute('aria-label')?.startsWith('Group chat,'))`,
      'Group chat row',
      20_000
    );
    await click(
      client,
      `Array.from(document.querySelectorAll('button')).find((button) => button.getAttribute('aria-label')?.startsWith('Group chat,'))`,
      'Group chat row'
    );
  }
  await client.waitFor(`Boolean(document.querySelector('textarea'))`, 'group composer', 10_000);
}

async function seedAttempt(client, { id, address, text, reason, outcome, active = false }) {
  return client.evaluate(`(async () => {
    const repository = window.__agentTeamsComposerDraftRepository;
    const address = ${JSON.stringify(address)};
    const id = ${JSON.stringify(id)};
    if (${JSON.stringify(active)}) repository.setAttemptActive(id, true, address);
    const begun = await repository.beginAttempt(address, '__e2e_non_matching_revision__', {
      attemptId: id,
      snapshot: {
        content: { text: ${JSON.stringify(text)}, chips: [], attachments: [], actionMode: 'do' },
        editorContext: { kind: 'plain' },
      },
      preparedRequest: {
        kind: 'local',
        teamName: ${JSON.stringify(teamName)},
        request: { member: 'alice', text: ${JSON.stringify(text)} },
      },
      ${reason ? `recoveryReason: ${JSON.stringify(reason)},` : ''}
      createdAt: Date.now(),
    });
    ${outcome ? `await repository.settleAttempt(address, id, ${JSON.stringify(outcome)});` : ''}
    return begun;
  })()`);
}

async function reloadFixture(client, mode = 'bottom-sheet') {
  await client.send('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 800));
  await openTeam(client, mode);
  await openGroupChat(client);
}

async function revealLatest(client) {
  const scrolled = await client.evaluate(`(() => {
    const scroll = Array.from(document.querySelectorAll('[data-messages-thread-scroll="true"]'))
      .find((candidate) => candidate instanceof HTMLElement && candidate.getBoundingClientRect().height > 0);
    if (!(scroll instanceof HTMLElement)) return false;
    scroll.scrollTop = scroll.scrollHeight;
    scroll.dispatchEvent(new Event('scroll'));
    return true;
  })()`);
  assert.equal(scrolled, true, 'visible conversation scroll container must exist');
  await new Promise((resolve) => setTimeout(resolve, 150));
}

await mkdir(shotDir, { recursive: true });
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(
  (candidate) => candidate.type === 'page' && candidate.url.startsWith('http://localhost:5173')
);
assert(target, `renderer target is unavailable on ${port}`);
const client = await CdpClient.connect(target.webSocketDebuggerUrl);
try {
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await openTeam(client);
  const contextId = await client.evaluate(
    `window.__agentTeamsDevStore.getState().activeContextId`
  );
  await client.evaluate(
    `window.__agentTeamsComposerDraftRepository.discardNamespace(${JSON.stringify(contextId)}, ${JSON.stringify(teamName)})`
  );
  await reloadFixture(client);

  await setComposer(client, groupDraft);
  await click(client, `document.querySelector('button[aria-label="Back to chats"]')`, 'Back to chats');
  await client.waitFor(
    `document.body.innerText.includes('Draft: **Group draft** keeps markdown')`,
    'group draft marker',
    10_000
  );
  await click(
    client,
    `Array.from(document.querySelectorAll('button')).find((button) => button.getAttribute('aria-label')?.startsWith('alice,'))`,
    'Alice chat row'
  );
  await setComposer(client, aliceDraft);
  await click(client, `document.querySelector('button[aria-label="Back to chats"]')`, 'Back to chats');
  await client.waitFor(
    `document.body.innerText.includes('Draft: Alice private draft - independent from group') && document.body.innerText.includes('Draft: **Group draft** keeps markdown')`,
    'independent draft markers',
    10_000
  );
  await client.screenshot(path.join(shotDir, 'per-conversation-draft-markers.png'));
  await openGroupChat(client);
  await client.waitFor(
    `document.querySelector('textarea')?.value === ${JSON.stringify(groupDraft)}`,
    'group draft automatic restoration',
    10_000
  );

  const groupAddress = { contextId, teamName, target: { kind: 'team-feed' } };
  const activeId = 'e2e-active-send';
  await seedAttempt(client, {
    id: activeId,
    address: groupAddress,
    text: 'Active sending bubble',
    active: true,
  });
  await client.waitFor(
    `document.querySelector('[data-composer-outbox-id="recovery:${activeId}"][data-composer-outbox-status="sending"]')?.textContent.includes('Sending...') === true`,
    'active Sending inline bubble',
    10_000
  );

  await client.evaluate(`(async () => {
    const repository = window.__agentTeamsComposerDraftRepository;
    const address = ${JSON.stringify(groupAddress)};
    await repository.settleAttempt(address, ${JSON.stringify(activeId)}, {
      kind: 'accepted',
      messageId: 'e2e-canonical-message',
    });
    repository.setAttemptActive(${JSON.stringify(activeId)}, false, address);
  })()`);
  await client.waitFor(
    `document.querySelector('[data-composer-outbox-id="recovery:${activeId}"][data-composer-outbox-status="syncing"]')?.textContent.includes('Sent - syncing...') === true`,
    'accepted syncing inline bubble',
    10_000
  );

  await seedAttempt(client, {
    id: 'e2e-not-sent',
    address: groupAddress,
    text: 'Definitive failure bubble',
    outcome: { kind: 'not-sent', detail: 'fixture failure' },
  });
  await seedAttempt(client, {
    id: 'e2e-unknown',
    address: groupAddress,
    text: 'Unknown delivery bubble',
    outcome: { kind: 'unconfirmed', detail: 'fixture uncertainty' },
  });
  await seedAttempt(client, {
    id: 'e2e-unavailable',
    address: {
      contextId,
      teamName,
      target: { kind: 'cross-team', toTeam: 'removed-sandbox-team', toMember: 'ghost' },
    },
    text: 'Recovered unavailable chat draft',
    reason: 'displaced-draft',
  });
  await client.waitFor(
    `(() => {
      const rows = Array.from(document.querySelectorAll('[data-composer-outbox-id]')).map((row) => row.textContent ?? '').join(' ');
      return rows.includes('Not sent') && rows.includes('Delivery unknown') && rows.includes('Recovered draft') && !document.body.textContent.includes('Saved messages');
    })()`,
    'inline delivery states without Saved messages',
    10_000
  );
  assert.equal(
    await client.evaluate(`Boolean(document.querySelector('button[aria-label="Message recovery"]'))`),
    false,
    'separate recovery trigger must be absent'
  );
  await revealLatest(client);
  await client.screenshot(path.join(shotDir, 'bottom-sheet-inline-outbox-states.png'));

  await click(
    client,
    `document.querySelector('[data-composer-outbox-id="recovery:e2e-not-sent"] button[aria-label="Edit"]')`,
    'Edit failed message with occupied composer'
  );
  await client.waitFor(
    `document.querySelector('[data-composer-outbox-id="recovery:e2e-not-sent"]')?.textContent.includes('This chat already has a draft. Nothing was overwritten.') === true`,
    'occupied draft safety',
    10_000
  );
  assert.equal(
    await client.evaluate(`document.querySelector('textarea')?.value`),
    groupDraft,
    'occupied draft must remain unchanged'
  );
  await setComposer(client, '');
  await click(
    client,
    `document.querySelector('[data-composer-outbox-id="recovery:e2e-not-sent"] button[aria-label="Edit"]')`,
    'Edit failed message'
  );
  await client.waitFor(
    `document.querySelector('textarea')?.value === 'Definitive failure bubble' && !document.querySelector('[data-composer-outbox-id="recovery:e2e-not-sent"]')`,
    'failed message restored without autosend',
    10_000
  );
  await setComposer(client, '');
  await click(
    client,
    `document.querySelector('[data-composer-outbox-id="recovery:e2e-unknown"] button[aria-label="Restore to draft"]')`,
    'Restore unknown delivery as draft'
  );
  await client.waitFor(
    `document.querySelector('textarea')?.value === 'Unknown delivery bubble' && document.body.innerText.includes('Previous delivery is unknown')`,
    'unknown duplicate-risk notice',
    10_000
  );
  await client.screenshot(path.join(shotDir, 'unknown-restored-with-warning.png'));

  await client.evaluate(`(() => {
    const store = window.__agentTeamsDevStore;
    const state = store.getState();
    const previous = state.teamMessagesByName[${JSON.stringify(teamName)}] ?? {
      canonicalMessages: [], optimisticMessages: [], feedRevision: null, nextCursor: null,
      hasMore: false, lastFetchedAt: null, loadingHead: false, loadingOlder: false, headHydrated: true,
    };
    store.setState({
      teamMessagesByName: {
        ...state.teamMessagesByName,
        [${JSON.stringify(teamName)}]: {
          ...previous,
          optimisticMessages: [...previous.optimisticMessages, {
            from: 'user', to: 'alice', text: 'Active sending bubble',
            timestamp: new Date().toISOString(), read: true, source: 'user_sent',
            messageId: 'e2e-canonical-message',
          }],
        },
      },
    });
  })()`);
  await client.waitFor(
    `!document.querySelector('[data-composer-outbox-id="recovery:${activeId}"]')`,
    'exact canonical message reconciliation',
    10_000
  );

  await seedAttempt(client, {
    id: 'e2e-reload-pending',
    address: groupAddress,
    text: 'Pending across reload',
  });
  await reloadFixture(client);
  await client.waitFor(
    `document.querySelector('[data-composer-outbox-id="recovery:e2e-reload-pending"][data-composer-outbox-status="delivery-unknown"]')?.textContent.includes('Delivery unknown') === true`,
    'stale pending after reload',
    20_000
  );
  await revealLatest(client);
  await client.screenshot(path.join(shotDir, 'stale-pending-after-reload.png'));

  await openTeam(client, 'sidebar');
  await openGroupChat(client);
  await revealLatest(client);
  await client.screenshot(path.join(shotDir, 'sidebar-inline-outbox.png'));
  const fullScreenSwitchState = await client.evaluate(`(() => {
    const control = document.querySelector('button[role="switch"][aria-label="Full Screen"]');
    if (!(control instanceof HTMLElement)) return null;
    return control.getAttribute('aria-checked') === 'true';
  })()`);
  if (fullScreenSwitchState !== null) {
    if (!fullScreenSwitchState) {
      await click(
        client,
        `document.querySelector('button[role="switch"][aria-label="Full Screen"]')`,
        'Full Screen switch'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    await revealLatest(client);
    const wideMessageLayout = await client.evaluate(`(() => {
      const shortMessage = document.querySelector('[data-timeline-row-key="dm-history-60"] article');
      if (!(shortMessage instanceof HTMLElement)) return null;
      const messageWidth = shortMessage.getBoundingClientRect().width;
      const rowWidth = shortMessage.parentElement?.getBoundingClientRect().width ?? 0;
      return {
        collapsedCount: document.querySelectorAll('.wide-chat-message[data-expanded="false"]').length,
        messageWidth,
        rowWidth,
      };
    })()`);
    assert(wideMessageLayout, 'short full-screen fixture message must be present');
    assert.equal(wideMessageLayout.collapsedCount, 0, 'wide chat must not collapse messages');
    assert(
      wideMessageLayout.messageWidth < wideMessageLayout.rowWidth * 0.75,
      'short full-screen message must remain content-sized'
    );
    await client.screenshot(path.join(shotDir, 'full-screen-inline-outbox.png'));
  }

  process.stdout.write(
    `${JSON.stringify({ ok: true, shotDir, port, teamName, electronLeftOpen: true }, null, 2)}\n`
  );
} finally {
  await client.close();
}
