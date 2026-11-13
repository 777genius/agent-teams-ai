import {
  assertMixedInputAccounting,
  initialMixedBusinessTurns,
  mixedInputAccounting,
} from './desktop-mixed-input-proof.ts';
import { runDesktopMixedMemberRestartUiSmoke } from './desktop-mixed-member-restart-ui-smoke.ts';
import { runMixedEditTeamUi, mixedEditedDescription } from './desktop-mixed-edit-team-ui.ts';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { storedModelProbeSchema } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import { runDesktopMixedGroupUiSmoke } from './desktop-mixed-group-ui-smoke.ts';
import assert from 'node:assert/strict';
import {
  configureMixedCreateSettings,
  mixedConfiguredMembers,
  assertMixedSavedSettings,
  assertMixedLaunchHydration,
  startMixedProgressObservation,
  finishMixedProgressObservation,
} from './desktop-mixed-dialog-settings.ts';
import { constants } from 'node:fs';
import { lstat, open, opendir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { processFacts } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import type { ProcessFact } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import { command } from './desktop-backend-observations.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { openOriginalCreateForm } from './desktop-create-config-ui-smoke.ts';
import {
  mixedDesktopTeamName,
  readMixedCapturedPrincipal,
} from './desktop-mixed-native-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { DesktopMixedModels } from './desktop-mixed-native-fixture.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const read = async (path: string) => record(JSON.parse(await readFile(path, 'utf8')));


/** One bounded TEST snapshot after the original failure; never authority or recovery. */
async function failedColdProbeJournal(root: string, observedAt: number) {
  const unavailable = { status: 'unavailable' as const, atomic: false as const };
  try {
    const directory = join(root, 'hoststore', 'management-commands');
    const originalDirectory = await lstat(directory);
    assert.ok(originalDirectory.isDirectory() && !originalDirectory.isSymbolicLink());
    const rows: Array<{
      receipt: string; provider: 'claude' | 'codex' | 'opencode';
      phase: 'running' | 'completed' | 'cancelled' | 'held';
      resourceHeld: boolean; ok: boolean; expiresInMs: number;
    }> = [];
    let entries = 0;
    for await (const entry of await opendir(directory)) {
      assert.ok(++entries <= 256, 'bounded original TEST journal');
      assert.ok(entry.isFile(), 'only original regular TEST receipts');
      if (/^\.tmp-[a-f0-9-]{36}$/.test(entry.name)) continue;
      assert.match(entry.name, /^[a-f0-9]{64}\.json$/);
      const path = join(directory, entry.name);
      const linkedBefore = await lstat(path);
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await file.stat();
        assert.ok(before.isFile() && linkedBefore.isFile() && !linkedBefore.isSymbolicLink());
        assert.equal(before.dev, linkedBefore.dev);
        assert.equal(before.ino, linkedBefore.ino);
        assert.ok(before.size <= 64 * 1024);
        const bytes = Buffer.alloc(64 * 1024 + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await file.read(bytes, length, bytes.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const after = await file.stat();
        const linkedAfter = await lstat(path);
        assert.ok(linkedAfter.isFile() && !linkedAfter.isSymbolicLink());
        assert.equal(length, before.size);
        for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const) {
          assert.equal(after[field], before[field]);
          assert.equal(linkedAfter[field], before[field]);
        }
        const parsed = record(JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
        ));
        const { digest, ...body } = parsed;
        if (body.kind !== 'model.probe') continue;
        const probe = storedModelProbeSchema.parse(body);
        assert.equal(digest, managementDigest(body));
        assert.equal(entry.name, managementDigest(probe.commandId) + '.json');
        if (!/^team-probe-[a-f0-9]{64}$/.test(probe.profileId)) continue;
        const provider = probe.providerId === 'anthropic' ? 'claude'
          : probe.providerId === 'codex' ? 'codex'
          : probe.providerId === 'test-local' ? 'opencode' : null;
        if (!provider) continue;
        assert.ok(rows.length < 64, 'bounded original TEST probe rows');
        const expiresInMs = probe.expiresAt - observedAt;
        assert.ok(Number.isSafeInteger(expiresInMs));
        rows.push({ receipt: entry.name.slice(0, -5), provider, phase: probe.phase,
          resourceHeld: probe.resourceHeld, ok: probe.ok, expiresInMs });
      } finally {
        await file.close();
      }
    }
    const currentDirectory = await lstat(directory);
    assert.ok(currentDirectory.isDirectory() && !currentDirectory.isSymbolicLink());
    assert.equal(currentDirectory.dev, originalDirectory.dev);
    assert.equal(currentDirectory.ino, originalDirectory.ino);
    return { status: 'observed' as const, atomic: false as const, rows };
  } catch {
    return unavailable;
  }
}

/** All application mutations use original dialog/composer/Stop controls through CDP Input. */
export async function runDesktopMixedCreateLaunchUiSmoke(
  cdp: UiCdpPort,
  options: {
    fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
    models: DesktopMixedModels;
    appGroup: number;
    evidence: Record<string, unknown>;
    assertOwnedRenderer(): void;
  }
) {
  const { fixture, models } = options;
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    openCodeGeneration: models.openCodeGeneration,
    steps,
    scope:
      'Original configured Create save-only3 members → original Edit description/Save/reload/reopen → original Launch hydration/close/reopen/preflights → one fresh3-member native capture → one original Launch lead prompt and2 Composer inputs/MCP/effects/replies → original mixed group/directed Bob input/three-provider ACK → original isolated Bob Restart/three-provider continuation → Stop/reload/Launch readback',
    excluded: [
      'real credentials/projects/vendor inference',
      'immediate Create launch',
      'nondefault worktree/args/MCP policies (separate qualifications)',
      'unknown-model refusal (broad-OK fixture is not a refusal oracle)',
      'Resume/adoption',
      'full Stage1',
    ],
  };
  options.evidence.mixedCreateLaunchProof = proof;
  const modelRows = [models.claude, models.codex, models.opencode];
  const assertCurrent = () => {
    options.assertOwnedRenderer();
    for (const model of modelRows)
      assert.deepEqual(model.failures, [], 'native inference fixture remains valid');
  };
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: assertCurrent,
    step: (row) => steps.push({ monotonicMs: Math.round(performance.now()), ...row }),
  });
  const poll = async <T>(
    observe: () => Promise<T>,
    accepts: (value: T) => boolean,
    label: string
  ) => {
    const until = Date.now() + 90_000;
    let value = await observe();
    while (!accepts(value) && Date.now() < until) {
      assertCurrent();
      await new Promise<void>((done) => setTimeout(done, 100));
      value = await observe();
    }
    assert.ok(accepts(value), label);
    return value;
  };
  const teamRoot = join(fixture.root, 'hoststore/teams', mixedDesktopTeamName);
  const ownerState = () => read(join(teamRoot, '.host-owner/state.json'));
  const workspace = join(fixture.root, 'workspace');
  await openOriginalCreateForm(cdp, ui, workspace, mixedDesktopTeamName);
  await configureMixedCreateSettings(cdp, ui);
  await ui.scrollTo('[data-testid="create-team-page"] #launch-team', 'original Create save-only checkbox');
  if (
    await cdp.evaluate(
      `document.querySelector('[data-testid="create-team-page"] #launch-team')?.getAttribute('data-state')==='checked'`
    )
  )
    await ui.click('[data-testid="create-team-page"] #launch-team', 'original Create save-only checkbox');
  await ui.waitRead(
    `document.querySelector('[data-testid="create-team-page"] #launch-team')?.getAttribute('data-state')==='unchecked'`,
    'Create save-only retained'
  );
  await ui.scrollTo(
    '[data-testid="create-team-page"] #sync-models-with-lead',
    'original independent provider settings'
  );
  if (
    await cdp.evaluate(
      `document.querySelector('[data-testid="create-team-page"] #sync-models-with-lead')?.getAttribute('data-state')==='checked'`
    )
  )
    await ui.click(
      '[data-testid="create-team-page"] #sync-models-with-lead',
      'disable original provider/model synchronization'
    );
  await ui.waitRead(
    `document.querySelector('[data-testid="create-team-page"] #sync-models-with-lead')?.getAttribute('data-state')==='unchecked'`,
    'original independent provider settings retained'
  );
  await ui.scrollTo('[data-testid="create-team-page"] button', 'existing member JSON editor', 'Edit as JSON');
  await ui.click('[data-testid="create-team-page"] button', 'open existing member JSON editor', 'Edit as JSON');
  await ui.scrollTo('[data-testid="create-team-page"] .cm-editor', 'original member JSON input');
  await ui.click(
    '[data-testid="create-team-page"] .cm-editor .cm-content .cm-line:first-child',
    'focus original member JSON input'
  );
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
  await cdp.send('Input.insertText', {
    text: JSON.stringify(mixedConfiguredMembers, null, 2),
  });
  await ui.waitRead(
    `(() => {const rows=[...document.querySelectorAll('[data-testid="create-team-page"] [data-role="member-row"] input[aria-label^="Member "]')]; return rows.length===2&&rows[0].value==='bob'&&rows[1].value==='carol'})()`,
    'original form renders the two entered provider rows'
  );
  await ui.scrollTo('[data-testid="create-team-page"] button', 'original save-only Create control', 'Create');
  await ui.click(
    '[data-testid="create-team-page"] button',
    'Create the original saved3-member roster once',
    'Create'
  );
  await ui.waitRead(
    `!document.querySelector('[data-testid="create-team-page"] #team-name')`,
    'original Create closes',
    90_000
  );
  const saved = await poll(
    ownerState,
    (state) => Array.isArray(state.members) && state.members.length === 3,
    'three saved members'
  );
  let configuredBeforeLaunch = assertMixedSavedSettings(saved, workspace);
  proof.configuredAfterCreate = configuredBeforeLaunch;
  const members = (saved.members as unknown[]).map(record);
  assert.deepEqual(
    members.map((row) => [row.name, row.role]),
    [
      ['team-lead', 'lead'],
      ['bob', 'member'],
      ['carol', 'member'],
    ]
  );
  assert.equal(record(saved.savedSettings).cwd, workspace);
  assert.equal(record(saved.savedSettings).syncModelsWithLead, false);
  assert.equal(
    record(saved.savedSettings).skipPermissions,
    true,
    'fresh original Create defaults to auto-approved native TEST tools'
  );
  assert.equal(record(members[1]!.settings).providerId, 'codex');
  assert.equal(record(members[2]!.settings).providerId, 'opencode');
  assert.equal((saved.runtimeCaptures as unknown[] | undefined)?.length ?? 0, 0);
  assert.ok(
    members.every((member) => member.delivery === undefined),
    'Create save-only has no registered native delivery'
  );
  const registryPath = join(fixture.root, 'hoststore/.host-team-registry/records');
  const registry = await Promise.all(
    (await readdir(registryPath))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => read(join(registryPath, name)))
  );
  const created = registry.filter(
    (row) => row.phase === 'published' && record(row.record).teamName === mixedDesktopTeamName
  );
  assert.equal(created.length, 1);
  const handleId = record(record(created[0]!.record).binding).handleId;
  assert.equal(typeof handleId, 'string');
  const key = hostTeamSelectionKey(String(handleId));
  proof.created = { registry: created[0], roster: members, noCapture: true };
  const probesBeforeLaunch = modelRows.map((model) => model.probes.length);
  proof.probesBeforeLaunch = probesBeforeLaunch;
  await ui.click('button[aria-label="More actions"]', 'original menu after Create');
  await ui.click('button', 'original Teams list after Create', 'Teams');
  const teamSelector = `[role="button"][data-team-name=${JSON.stringify(key)}]`;
  await ui.scrollTo(teamSelector, 'original newly created Team card');
  await ui.click(teamSelector, 'open original newly created Team');
  const edited = await runMixedEditTeamUi(cdp, {
    selection: key,
    handleId: String(handleId),
    before: saved,
    evidence: proof,
    ownerState,
    assertOwnedRenderer: assertCurrent,
    assertNoNativeInputs: () => {
      assertCurrent();
      assert.ok(modelRows.every((model) => model.observations.length === 0));
    },
    step: (row) => steps.push(row),
  });
  proof.editTeam = edited.proof;
  configuredBeforeLaunch = assertMixedSavedSettings(
    edited.state,
    workspace,
    mixedEditedDescription
  );
  proof.configuredBeforeLaunch = configuredBeforeLaunch;
  await ui.click('button', 'open original mixed Launch dialog', 'Launch');
  await ui.waitRead(
    `Boolean(document.querySelector('[role="dialog"]'))`,
    'original mixed Launch form'
  );
  proof.firstLaunchHydration = await assertMixedLaunchHydration(cdp, ui);
  await ui.scrollTo('[role="dialog"] > button', 'original hydrated Launch Close control', 'Close');
  await ui.click(
    '[role="dialog"] > button',
    'close original hydrated Launch without submitting',
    'Close'
  );
  await ui.waitRead(
    `!document.querySelector('[role="dialog"]')`,
    'original Launch closed without allocation'
  );
  assert.deepEqual(
    assertMixedSavedSettings(await ownerState(), workspace, mixedEditedDescription),
    configuredBeforeLaunch
  );
  assert.equal(((await ownerState()).runtimeCaptures as unknown[] | undefined)?.length ?? 0, 0);
  await ui.click('button', 'reopen original mixed Launch before Submit', 'Launch');
  proof.reopenedLaunchHydration = await assertMixedLaunchHydration(cdp, ui);
  // Preserve a bounded, credential-free timing trace for each original provider
  // preflight. All three native model checks and the original 90s deadline remain mandatory.
  const preflightStartedAt = performance.now();
  const preflightProbeTimeline: Array<{ elapsedMs: number; counts: number[] }> = [];
  let previousProbeSignature = '';
  let nextProbeSampleMs = 0;
  try {
    await poll(
      async () => {
        const counts = modelRows.map((model) => model.probes.length);
        const elapsedMs = Math.round(performance.now() - preflightStartedAt);
        const signature = counts.join(':');
        if (signature !== previousProbeSignature || elapsedMs >= nextProbeSampleMs) {
          preflightProbeTimeline.push({ elapsedMs, counts });
          previousProbeSignature = signature;
          nextProbeSampleMs = elapsedMs + 10_000;
        }
        return counts;
      },
      (counts) => counts.every((count, index) =>
        count > probesBeforeLaunch[index]! && count <= (index === 0 ? 9 : 8)),
      'all3 selected namespaces have actual bounded model preflights'
    );
  } finally {
    // Persist the original fixture's count-only timeline on PASS and INCOMPLETE.
    proof.preflightProbeTimeline = preflightProbeTimeline;
  }
  assert.equal(
    ((await ownerState()).runtimeCaptures as unknown[] | undefined)?.length ?? 0,
    0,
    'all3 scoped model preflights finish before the one runtime capture'
  );
  await ui.scrollTo('[role="dialog"] button', 'original mixed Launch team control', 'Launch team');
  let capturedMetadataChild: ProcessFact | undefined;
  if (process.env.LEGACY_DESKTOP_OPENCODE_GENERATION === 'v2') {
    await ui.waitRead(
      `[...document.querySelectorAll('[role="dialog"] button')].some(e=>e.textContent.trim()==='Launch team'&&!e.disabled)`,
      'all native preflights finish and enable original Launch'
    );
    capturedMetadataChild = await poll(async () => {
      const table = processFacts();
      const hosts = table.filter(value => value.groupId === options.appGroup &&
        command(value.pid) === `${fixture.node} ${fixture.hostEntry}`);
      assert.equal(hosts.length, 1);
      const children = table.filter(value => value.parentPid === hosts[0]!.pid);
      return children.length === 1 && children[0]!.command === process.env.OPENCODE_V2_EMBEDDED_BUN
        ? children[0] : undefined;
    }, value => value !== undefined, 'one original metadata child before any runtime allocation');
    assert.ok(capturedMetadataChild);
    assert.equal(((await ownerState()).runtimeCaptures as unknown[] | undefined)?.length ?? 0, 0);
    proof.originalMetadataChildBeforeLaunch = capturedMetadataChild;
  }
  await startMixedProgressObservation(cdp);
  await ui.click(
    '[role="dialog"] button',
    'submit original mixed Launch once without optional bypass',
    'Launch team'
  );
  await ui.waitRead(
    `!document.querySelector('[role="dialog"]')`,
    'original mixed Launch closes',
    90_000
  );
  const state = await poll(
    ownerState,
    (row) => Array.isArray(row.runtimeCaptures) && row.runtimeCaptures.length === 1,
    'exactly one fresh mixed capture'
  );
  const capture = record((state.runtimeCaptures as unknown[])[0]);
  assert.ok(Array.isArray(capture.members) && capture.members.length === 3);
  proof.capture = capture;
  assert.equal(record(state.savedSettings).allowExperimentalLocalModels, false);
  const configuredAfterLaunch = assertMixedSavedSettings(state, workspace, mixedEditedDescription);
  assert.deepEqual(
    configuredAfterLaunch,
    {
      ...configuredBeforeLaunch,
      savedSettings: {
        ...configuredBeforeLaunch.savedSettings,
        allowExperimentalLocalModels: false,
      },
    },
    'Launch retains configured settings and persists the explicitly disabled opt-in'
  );
  let selectedBindings: string[] | undefined = undefined;
  const sessions = () =>
    readDesktopNativeStopSessions(fixture.root).then((rows) =>
      rows.filter(
        (row) =>
          record(row.binding).runId === capture.launchId &&
          (!selectedBindings || selectedBindings.includes(runtimeDigest(row.binding)))
      )
    );
  await poll(
    sessions,
    (rows) => rows.length === 3 && rows.every((row) => row.custody === 'owned'),
    'all3 original native sessions allocated'
  );
  await ui.waitRead(
    `/Team is ready\\.|Team launched/.test(document.body.innerText)`,
    'original UI aggregate native readiness/progress',
    90_000
  );
  for (const [provider, name, turn, reply] of [
    ['claude', 'team-lead', 'NATIVE_TEAM_ONE', 'REPLY_NATIVE_ONE'],
    ['codex', 'bob', 'CODEX_TEAM_ONE', 'REPLY_CODEX_ONE'],
    ['opencode', 'carol', 'OPENCODE_TEAM_ONE', 'REPLY_OPENCODE_ONE'],
  ] as const) {
    if (provider !== 'claude') {
      await ui.scrollTo(
        'button[aria-label="Back to chats"]',
        `original mixed Back to chats before ${provider}`
      );
      await ui.click(
        'button[aria-label="Back to chats"]',
        `original mixed Back to chats before ${provider}`
      );
    }
    const principalId = readMixedCapturedPrincipal(fixture.root, provider);
    const displayName = name === 'team-lead' ? 'lead' : name;
    await ui.click(
      `button[aria-label^=${JSON.stringify(displayName + ',')}]`,
      `original ${provider} direct chat`
    );
    if (provider !== 'claude') {
      await ui.click('.message-composer-flat-layout textarea', `original ${provider} Composer`);
      await cdp.send('Input.insertText', { text: turn });
      await ui.waitRead(
        `document.querySelector('.message-composer-flat-layout textarea')?.value===${JSON.stringify(turn)}`,
        `original ${provider} input retained`
      );
      await ui.click(
        'button.message-composer-send-button',
        `send ${provider} business input once`,
        'Send'
      );
    }
    await ui.waitRead(
      `document.querySelector('.message-composer-flat-layout textarea')?.value===''&&document.body.innerText.includes(${JSON.stringify(reply)})`,
      `original ${provider} admitted input and visible native reply`,
      90_000
    );
    await revealDesktopReply(cdp, reply, {
      assertOwnedRenderer: assertCurrent,
      step: (row) => steps.push(row),
    });
    steps.push({
      action: 'native-business-input-completed',
      provider,
      principalId,
      turn,
      reply,
      source: provider === 'claude' ? 'original Launch initial prompt' : 'original Composer Send',
    });
  }
  await poll(
    async () => modelRows.map((model) => model.observations.length),
    (counts) => counts.every((count) => count === 8),
    'all3 original terminal inference requests complete'
  );
  for (const model of modelRows) {
    assert.deepEqual(model.failures, []);
    assert.ok(
      model.observations.every((row) => row.contextEffective),
      'actual native requests retain captured context'
    );
  }
  const leadNotifications = models.claude.notificationObservations;
  assert.ok(leadNotifications);
  assert.ok(
    [...models.claude.observations, ...leadNotifications].every(
      (row) => row.requestedModel === 'claude-opus-4-6' && row.requestedEffort === 'medium'
    ),
    'actual lead uses the selected model and effort'
  );
  const terminalSessions = await poll(sessions,
    value => mixedInputAccounting(fixture.root, value, models, initialMixedBusinessTurns).ready,
    'exact original business and receipt-bound notifications terminal');
  proof.nativeInputAccounting = assertMixedInputAccounting(fixture.root, terminalSessions, models, initialMixedBusinessTurns);
  proof.nativeTerminalInputs = terminalSessions;
  proof.mixedGroup = await runDesktopMixedGroupUiSmoke(cdp, {
    root: fixture.root,
    teamName: mixedDesktopTeamName,
    models,
    launchId: capture.launchId,
    assertOwnedRenderer: assertCurrent,
    step: (value) => steps.push(value),
  });
  const restarted = await runDesktopMixedMemberRestartUiSmoke(cdp, {
    root: fixture.root,
    launchId: capture.launchId,
    models,
    appGroup: options.appGroup,
    node: fixture.node,
    hostEntry: fixture.hostEntry,
    ...(capturedMetadataChild ? { capturedMetadataChild } : {}),
    assertOwnedRenderer: assertCurrent,
    step: (value) => steps.push(value),
  });
  proof.isolatedMemberRestart = restarted;
  selectedBindings = restarted.currentBindings.map((binding) => runtimeDigest(binding));
  const expectedObservations = [13, 15, 13];
  proof.progressDomObservations = await finishMixedProgressObservation(cdp);
  assert.ok(
    Array.isArray(proof.progressDomObservations) && proof.progressDomObservations.length > 0,
    'original UI progress observations retained without synthesizing progress states'
  );
  assert.ok(
    proof.progressDomObservations.some((row) =>
      /Team is ready\.|Team launched/.test(String(record(row).text))
    ),
    'actual aggregate readiness was visible in original progress UI'
  );
  assert.equal(
    await readFile(join(workspace, 'native-effect.txt'), 'utf8'),
    'ONE\nONE\nONE\nTWO\nTWO\nTWO\n'
  );
  const tasks = await Promise.all(
    (await readdir(join(fixture.root, 'hoststore/tasks', mixedDesktopTeamName)))
      .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
      .map((name) => read(join(fixture.root, 'hoststore/tasks', mixedDesktopTeamName, name)))
  );
  assert.equal(tasks.length, 3);
  assert.ok(tasks.every((row) => row.status === 'completed'));
  proof.tasks = tasks;
  proof.sessionsBeforeStop = await sessions();
  const tableBeforeStop = processFacts();
  const originalHost = restarted.physical.originalHost;
  assert.deepEqual(
    tableBeforeStop.find((row) => row.pid === originalHost.pid),
    originalHost
  );
  const allHostChildren = tableBeforeStop.filter((row) => row.parentPid === originalHost.pid);
  assert.deepEqual(
    allHostChildren,
    restarted.physical.childrenAfter,
    'every captured child identity remains unchanged after the three continuation turns'
  );
  const managementChild = restarted.physical.managementChild;
  const children = allHostChildren.filter((child) => child.pid !== managementChild.pid);
  assert.equal(children.length, 3, 'three exact runtime children, separately from Host management');
  proof.allHostChildrenBeforeStop = allHostChildren;
  proof.managementChildBeforeStop = managementChild;
  proof.nativeChildrenBeforeStop = children;
  await ui.scrollTo('button[aria-label="Stop"]', 'visible original whole Team Stop control');
  await ui.click('button[aria-label="Stop"]', 'original whole Team Stop once', 'Stop');
  await poll(
    sessions,
    (rows) =>
      rows.length === 3 &&
      rows.every((row) => row.phase === 'closed' && row.custody === 'released'),
    'all3 selected custodians confirm released'
  );
  const tableAfterStop = await poll(
    async () => processFacts(),
    (rows) => children.every((child) => !rows.some((row) => row.pid === child.pid)),
    'all three exact runtime children absent'
  );
  assert.deepEqual(
    tableAfterStop.find((row) => row.pid === originalHost.pid),
    originalHost
  );
  assert.deepEqual(
    tableAfterStop.find((row) => row.pid === managementChild.pid),
    managementChild,
    'the original Host management child is separate from stopped Team runtimes'
  );
  assert.deepEqual(
    tableAfterStop.filter((row) => row.parentPid === originalHost.pid),
    [managementChild],
    'only the original management child remains under the Host after Team Stop'
  );
  proof.managementChildAfterStop = managementChild;
  const timeOrigin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(
    `performance.timeOrigin!==${JSON.stringify(timeOrigin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'original renderer reload after Stop',
    90_000
  );
  await ui.observeInput();
  await ui.waitRead(
    `Boolean(document.querySelector('button[aria-label="More actions"]'))`,
    'original menu after mixed Stop/reload',
    90_000
  );
  await ui.click('button[aria-label="More actions"]', 'original menu after mixed Stop/reload');
  await ui.click('button', 'original saved Teams after mixed Stop/reload', 'Teams');
  await ui.scrollTo(teamSelector, 'original mixed saved Team survives Stop/reload');
  await ui.click(teamSelector, 'read original mixed saved Team after Stop/reload');
  const after = await ownerState();
  assert.equal(
    (after.runtimeCaptures as unknown[]).length,
    1,
    'reload never captures/replays a run'
  );
  assert.deepEqual(
    modelRows.map((model) => model.observations.length),
    expectedObservations
  );
  assert.equal(record(after.savedSettings).allowExperimentalLocalModels, false);
  const configuredAfterStop = assertMixedSavedSettings(after, workspace, mixedEditedDescription);
  assert.deepEqual(configuredAfterStop, configuredAfterLaunch);
  // Permit a single new TEST probe only after observing the original cold UI boundary.
  // This grants neither a new native business input nor a repeated Launch submission.
  const nativeClaudeProbeCount = models.beginColdReadbackProbes();
  proof.nativeClaudeProbeCount = nativeClaudeProbeCount;
  await ui.click('button', 'reopen original mixed Launch after Stop/reload', 'Launch');
  try {
    await poll(
      async () => models.claude.probes.length,
      (count) => count === nativeClaudeProbeCount + 1,
      'one fresh original cold Launch model preflight'
    );
  } catch (error) {
    const failure = {
      kind: 'TEST_MIXED_COLD_MODEL_PREFLIGHT',
      journal: await failedColdProbeJournal(fixture.root, Date.now()),
      providerProbeCounts: modelRows.map((model) => model.probes.length),
      baseline: nativeClaudeProbeCount,
      observed: models.claude.probes.length,
      probes: models.claude.probes
        .slice(nativeClaudeProbeCount, nativeClaudeProbeCount + 8)
        .map((probe) => ({
          phase: probe.phase ?? null,
          requestedModel: probe.requestedModel?.slice(0, 160) ?? null,
          requestedEffort: probe.requestedEffort?.slice(0, 32) ?? null,
        })),
      omitted: Math.max(0, models.claude.probes.length - nativeClaudeProbeCount - 8),
    };
    proof.coldModelPreflightFailure = failure;
    process.stderr.write(JSON.stringify(failure) + '\n');
    throw error;
  }
  assert.deepEqual(models.claude.probes.slice(nativeClaudeProbeCount), [
    { phase: 'cold-readback', requestedModel: 'claude-opus-4-6', requestedEffort: 'medium' },
  ]);
  assert.deepEqual(models.claude.failures, []);
  // The cold preflight replaces its status panel and moves the optional header.
  // Observe its original completed UI before the one settings click; never retry
  // a click that may already have reached a different control during hydration.
  await ui.waitRead(`(() => {
    const dialog=document.querySelector('[role="dialog"]');
    return dialog?.textContent.includes('All selected providers are ready.') &&
      [...dialog.querySelectorAll('button')].some(button=>
        button.textContent.trim()==='Launch team'&&!button.disabled);
  })()`, 'original cold Launch preflights settled before reading saved settings');
  proof.stoppedReloadLaunchHydration = await assertMixedLaunchHydration(cdp, ui);
  assert.deepEqual(
    assertMixedSavedSettings(await ownerState(), workspace, mixedEditedDescription),
    configuredAfterStop
  );
  assert.equal(((await ownerState()).runtimeCaptures as unknown[]).length, 1);
  assert.deepEqual(
    modelRows.map((model) => model.observations.length),
    expectedObservations,
    'reopening never sends a business input'
  );
  const screenshot = record(
    await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    })
  );
  const path = join(fixture.root, 'ui-original-mixed-create-launch.png');
  await writeFile(path, Buffer.from(String(screenshot.data), 'base64'), {
    mode: 0o600,
  });
  proof.screenshot = { path, sha256: await fileDigest(path) };
  await ui.scrollTo('[role="dialog"] > button', 'original stopped readback Close control', 'Close');
  await ui.click('[role="dialog"] > button', 'close original stopped readback Launch', 'Close');
  await ui.waitRead(
    `!document.querySelector('[role="dialog"]')`,
    'readback dialog closed without launch'
  );
  proof.settingsRetainedAfterReload = true;
  proof.unknownModelRefusalQualified = false;
  proof.probes = {
    claude: models.claude.probes,
    codex: models.codex.probes,
    opencode: models.opencode.probes,
  };
  const sessionsAfterStop = await sessions();
  assert.equal(sessionsAfterStop.length, 3);
  assert.ok(sessionsAfterStop.every((row) => row.phase === 'closed' && row.custody === 'released'));
  proof.sessionsAfterStop = sessionsAfterStop;
  const allSessionsAfterStop = (await readDesktopNativeStopSessions(fixture.root)).filter(
    (value) => record(value.binding).runId === capture.launchId
  );
  assert.equal(allSessionsAfterStop.length, 4);
  assert.ok(
    allSessionsAfterStop.every((value) => value.phase === 'closed' && value.custody === 'released')
  );
  proof.allSessionsAfterStop = allSessionsAfterStop;
  proof.stop = { children, releasedBeforeQuit: true };
  proof.status = 'PASS';
}
