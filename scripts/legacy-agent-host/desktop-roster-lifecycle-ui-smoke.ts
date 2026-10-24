import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDesktopUiControls, desktopJsLiteral } from "./desktop-ui-controls.ts";
import { fileDigest } from "./desktop-backend-fixture.ts";
import { hostTeamSelectionKey } from "../../src/features/agent-backend/contracts/teamSelection.ts";
import { readDesktopNativeStopSessions } from "./desktop-native-stop-fixture.ts";
import type { UiCdpPort } from "./desktop-ui-controls.ts";
import type { prepareDesktopBackendFixture } from "./desktop-backend-fixture.ts";
type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Row;
};
/** One stopped, UI-created TEST Team; only ordinary CDP Input can change roster/lifecycle. */
export async function runDesktopRosterLifecycleUiSmoke(
  cdp: UiCdpPort,
  options: {
    fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
    evidence: Row;
    assertOwnedRenderer(): void;
  },
): Promise<void> {
  const { root } = options.fixture,
    teamName = "test-created-from-dialog",
    memberName = "test-roster-member";
  const created = record(
    record(record(options.evidence.createConfigDialogProof).creation).record,
  );
  assert.equal(created.teamName, teamName);
  const teamSelection = hostTeamSelectionKey(String(record(created.binding).handleId));
  const teamSelector = `[data-team-name=${JSON.stringify(teamSelection)}]`;
  const memberIdentitySelector = '[data-section-id="team"] [role="button"] span.font-medium';
  const team = join(root, "hoststore/teams", teamName),
    ownerPath = join(team, ".host-owner/state.json");
  const witnessPath = join(
    root,
    "hoststore/teams/test-desktop-backend/.host-owner/state.json",
  );
  assert.ok(options.fixture.uiSeed);
  const witnessTaskPath = join(
    root,
    "hoststore/tasks/test-desktop-backend",
    options.fixture.uiSeed.taskId + ".json",
  );
  const witnessTaskBefore = await readFile(witnessTaskPath);
  const witnessBefore = await readFile(witnessPath),
    steps: Row[] = [],
    snapshots: Row[] = [];
  const proof: Row = {
    status: "INCOMPLETE",
    steps,
    snapshots,
    teamName,
    scope:
      "Existing stopped solo Create → Add/Remove/Restore teammate → Trash/Restore → permanent Delete; one TEST project, no native Team launch/input",
  };
  options.evidence.rosterLifecycleUiProof = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (value) => steps.push(value),
  });
  const read = async (path: string) =>
    record(JSON.parse(await readFile(path, "utf8")));
  const owner = () => read(ownerPath);
  const members = (value: Row, field = "members") => {
    assert.ok(Array.isArray(value[field]));
    return value[field].map(record);
  };
  const poll = async <T>(
    get: () => Promise<T>,
    accepts: (value: T) => boolean,
    label: string,
  ): Promise<T> => {
    const until = Date.now() + 30_000;
    let value = await get();
    while (!accepts(value) && Date.now() < until) {
      await new Promise<void>((done) => setTimeout(done, 100));
      value = await get();
    }
    assert.ok(accepts(value), label);
    return value;
  };
  const save = (phase: string, value: Row) => {
    snapshots.push({ phase, owner: structuredClone(value) });
  };
  const teamList = async () => {
    await ui.click(
      'button[aria-label="More actions"]',
      "open existing application menu for saved Team",
    );
    await ui.click("button", "open existing Teams list", "Teams");
    await ui.waitRead(
      `Boolean(document.querySelector(${JSON.stringify("[data-team-name=" + JSON.stringify(hostTeamSelectionKey(options.fixture.handleId)) + "]")}))`,
      "saved original neighbor Team proves Teams list loaded",
    );
  };
  const openTeam = async () => {
    await ui.scrollTo(teamSelector, "exact UI-created stopped Team card");
    await ui.click(teamSelector, "open exact UI-created stopped Team");
    await ui.waitRead(
      `window.__agentTeamsDevStore?.getState().selectedTeamName===${JSON.stringify(teamSelection)}&&[...document.querySelectorAll(${JSON.stringify(memberIdentitySelector)})].filter(e=>e.textContent.trim()===${JSON.stringify(originalLead.name === "team-lead" ? "lead" : String(originalLead.name))}&&e.getBoundingClientRect().width>0).length===1`,
      "original solo lead rendered",
    );
  };
  const reload = async () => {
    const origin = await cdp.evaluate("performance.timeOrigin");
    await cdp.send("Page.reload", { ignoreCache: false });
    await ui.waitRead(
      `performance.timeOrigin!==${JSON.stringify(origin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
      "fresh renderer for saved lifecycle",
    );
    await ui.observeInput();
    await ui.waitRead(
      `Boolean(document.querySelector('button[aria-label="More actions"]'))`,
      "reloaded application menu",
      90_000,
    );
    await teamList();
  };
  const screenshot = async (name: string) => {
    const image = record(
      await cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
      }),
    );
    const path = join(root, name);
    await writeFile(path, Buffer.from(String(image.data), "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    return { path, sha256: await fileDigest(path) };
  };
  assert.deepEqual(
    await readDesktopNativeStopSessions(root).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }),
    [],
  );
  const initial = await owner();
  assert.deepEqual(
    members(initial).map((row) => [row.name, row.role]),
    [["team-lead", "lead"]],
  );
  const originalLead = members(initial)[0]!,
    originalSaved = initial.savedSettings;
  save("solo-before-add", initial);
  await ui.observeInput();
  await openTeam();
  await ui.waitRead(
    `document.querySelector('[data-section-id="team"]')?.textContent.includes('Solo')`,
    "existing Solo badge",
  );
  await ui.click(
    '[data-section-id="team"] button',
    "open existing Add Members dialog",
    "Add",
  );
  await ui.waitRead(
    `Boolean(document.querySelector('[role="dialog"] input[aria-label="Member 1 name"]'))`,
    "original teammate name input",
  );
  await ui.click(
    '[role="dialog"] input[aria-label="Member 1 name"]',
    "focus original teammate name",
  );
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    modifiers: 4,
    commands: ["selectAll"],
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 4,
  });
  await cdp.send("Input.insertText", { text: memberName });
  await ui.waitRead(
    `document.querySelector('[role="dialog"] input[aria-label="Member 1 name"]')?.value===${JSON.stringify(memberName)}`,
    "exact new saved teammate name",
  );
  await ui.click(
    '[role="dialog"] > div:last-child > button',
    "submit existing Add member once",
    "Add member",
  );
  const added = await poll(
    owner,
    (value) => members(value).length === 2,
    "one saved teammate added",
  );
  const addedMember = members(added).find((row) => row.name === memberName)!;
  assert.ok(addedMember);
  assert.deepEqual(
    members(added).find((row) => row.role === "lead"),
    originalLead,
  );
  assert.deepEqual(added.savedSettings, originalSaved);
  assert.equal(addedMember.delivery, undefined);
  assert.deepEqual(added.runtimeCaptures ?? [], []);
  save("team-after-add", added);
  await ui.waitRead(
    `!document.querySelector('[role="dialog"] input[aria-label="Member 1 name"]')`,
    "Add dialog closed after saved result",
  );
  await ui.click(
    memberIdentitySelector,
    "open exact saved teammate detail",
    memberName,
  );
  await ui.click(
    '[role="dialog"] button',
    "request Remove from existing member detail once",
    "Remove",
  );
  // The original member detail remains mounted behind its separate confirmation.
  const removeConfirmationId = String(await ui.waitRead(
    `(() => {const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(node=>node.querySelector('h2')?.textContent.trim()==='Remove member'&&node.textContent.includes('Tasks and messages will be preserved'));return dialogs.length===1&&dialogs[0].id||null;})()`,
    "original Remove member confirmation",
  ));
  await ui.click(
    `[role="dialog"][id=${JSON.stringify(removeConfirmationId)}] > div:last-child > button`,
    "confirm original Remove member once",
    "Remove",
  );
  const removed = await poll(
    owner,
    (value) =>
      members(value).length === 1 &&
      members(value, "removedMembers").some(
        (row) => row.memberId === addedMember.memberId,
      ),
    "saved teammate soft-removed",
  );
  const retired = members(removed, "removedMembers").find(
    (row) => row.memberId === addedMember.memberId,
  )!;
  assert.ok(retired.removedAt);
  assert.equal(retired.name, memberName);
  assert.deepEqual(removed.savedSettings, originalSaved);
  save("solo-after-remove", removed);
  await ui.waitRead(
    `document.querySelector('[data-section-id="team"]')?.textContent.includes('Solo')`,
    "solo count restored with removed history",
  );
  const restoreSelector = '[data-section-id="team"] button[aria-label="Restore teammate"]';
  await ui.waitRead(
    `(() => {const controls=[...document.querySelectorAll(${desktopJsLiteral(restoreSelector)})];return controls.length===1&&controls[0].closest('[role="button"]')?.querySelector('span.font-medium')?.textContent.trim()===${desktopJsLiteral(memberName)};})()`,
    "Restore belongs to the exact original removed teammate",
  );
  await ui.scrollTo(restoreSelector, "original removed teammate control");
  await ui.click(restoreSelector, "restore original removed teammate once");
  const restored = await poll(
    owner,
    (value) =>
      members(value).length === 2 &&
      !members(value, "removedMembers").some(
        (row) => row.memberId === addedMember.memberId,
      ),
    "same original member restored",
  );
  const restoredMember = members(restored).find(
    (row) => row.name === memberName,
  )!;
  assert.deepEqual(restoredMember, addedMember);
  assert.equal(restoredMember.delivery, undefined);
  assert.deepEqual(restored.savedSettings, originalSaved);
  assert.deepEqual(restored.runtimeCaptures ?? [], []);
  assert.ok(
    Array.isArray(restored.rosterCommands) &&
      restored.rosterCommands.length === 3,
  );
  assert.equal(
    new Set(restored.rosterCommands.map((item) => record(item).commandId)).size,
    3,
  );
  save("team-after-restore", restored);
  proof.restoredMemberId = restoredMember.memberId;
  proof.rosterScreenshot = await screenshot("ui-roster-restored.png");
  const trash = async (label: string) => {
    await ui.scrollTo(
      'button[aria-label="Move to trash"]',
      label + " original Team header",
    );
    await ui.click(
      'button[aria-label="Move to trash"]',
      label + " request original Team Trash",
    );
    await ui.click(
      '[role="dialog"] > div:last-child > button',
      label + " confirm original Team Trash once",
      "Move to trash",
    );
    const trashed = await poll(
      owner,
      (value) =>
        !!value.lifecycle &&
        !!record(value.lifecycle).deletedAt &&
        record(value.lifecycle).cleanupPending === false,
      "original Team tombstone cleanup released",
    );
    assert.deepEqual(trashed.members, restored.members);
    assert.deepEqual(trashed.savedSettings, originalSaved);
    save(label, trashed);
    await teamList();
    await ui.waitRead(
      `Boolean(document.querySelector('button[aria-label="Restore team"]'))`,
      "original trashed Team controls",
    );
  };
  await trash("first-trash");
  await ui.click(
    'button[aria-label="Restore team"]',
    "restore original Team from Trash once",
  );
  const recovered = await poll(
    owner,
    (value) => !record(value.lifecycle).deletedAt,
    "original Team restored from Trash",
  );
  assert.deepEqual(recovered.members, restored.members);
  assert.deepEqual(recovered.savedSettings, originalSaved);
  save("team-after-trash-restore", recovered);
  await reload();
  await openTeam();
  assert.deepEqual(
    await owner(),
    recovered,
    "roster/lifecycle survives renderer reload",
  );
  await trash("second-trash-for-permanent-delete");
  proof.trashScreenshot = await screenshot("ui-team-trash-before-purge.png");
  const commands = await Promise.all(
    (await readdir(join(team, ".host-owner/commands")))
      .filter((name) => name.endsWith(".json"))
      .map((name) => read(join(team, ".host-owner/commands", name))),
  );
  const lifecycle = commands.filter((row) => row.family === "lifecycle");
  assert.equal(lifecycle.length, 3);
  assert.ok(
    lifecycle.every(
      (row) => row.phase === "completed" && row.principalId === "TEST-human",
    ),
  );
  assert.deepEqual(lifecycle.map((row) => row.operation).sort(), [
    "restore",
    "trash",
    "trash",
  ]);
  proof.lifecycleReceiptsBeforePurge = lifecycle;
  await ui.click(
    'button[aria-label="Delete permanently"]',
    "request original permanent Team deletion once",
  );
  await ui.waitRead(
    `Boolean([...document.querySelectorAll('[role="dialog"]')].find(node=>node.textContent.includes('All data will be lost')))`,
    "original destructive Delete permanently confirmation",
  );
  await ui.click(
    '[role="dialog"][aria-label="Delete permanently"] button[data-confirm-btn]',
    "confirm Delete forever for only the created TEST Team",
    "Delete forever",
  );
  const intentPath = join(
    root,
    "hoststore/backups/permanent-deletion-intents",
    teamName + ".json",
  );
  const intent = await poll(
    () =>
      read(intentPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return {} as Row;
        throw error;
      }),
    (value) => value.phase === "deleted" && value.cleanupCompleted === true,
    "same original permanent deletion completed",
  );
  assert.equal(intent.identityId, created.teamId);
  assert.equal(intent.teamName, teamName);
  assert.equal(intent.identityKind, "team");
  assert.ok(intent.ownerRequest);
  await assert.rejects(stat(team), { code: "ENOENT" });
  await assert.rejects(stat(join(root, "hoststore/tasks", teamName)), {
    code: "ENOENT",
  });
  proof.permanentDeletion = intent;
  await reload();
  await ui.waitRead(
    `![...document.querySelectorAll('h3')].some(node=>node.textContent.trim()===${JSON.stringify(teamName)})`,
    "permanently deleted Team absent after renderer reload",
  );
  assert.deepEqual(
    await readFile(witnessPath),
    witnessBefore,
    "original seeded neighbor Team was never mutated",
  );
  assert.deepEqual(
    await readFile(witnessTaskPath),
    witnessTaskBefore,
    "original seeded neighbor Task bytes unchanged",
  );
  assert.deepEqual(
    await read(intentPath),
    intent,
    "reload does not repeat original destructive intent",
  );
  assert.deepEqual(
    await owner().catch((error) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      return null;
    }),
    null,
  );
  assert.deepEqual(
    await readDesktopNativeStopSessions(root).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }),
    [],
  );
  proof.finalScreenshot = await screenshot("ui-team-purged-reloaded.png");
  Object.assign(proof, {
    status: "PASS",
    originalLeadAndMemberIdentityRetained: true,
    settingsRetained: true,
    nativeTeamAllocations: 0,
    originalSeedTeamUnchanged: true,
    permanentDeletionNotReplayed: true,
  });
}
