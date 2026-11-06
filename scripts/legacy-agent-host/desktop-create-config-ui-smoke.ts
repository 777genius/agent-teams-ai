import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createDesktopUiControls } from "./desktop-ui-controls.ts";
import { fileDigest } from "./desktop-backend-fixture.ts";
import { runDesktopRosterLifecycleUiSmoke } from "./desktop-roster-lifecycle-ui-smoke.ts";
import { hostTeamSelectionKey } from "../../src/features/agent-backend/contracts/teamSelection.ts";
import type { UiCdpPort } from "./desktop-ui-controls.ts";
import type { prepareDesktopBackendFixture } from "./desktop-backend-fixture.ts";

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};

/** The TEST fixture supplies only a private sandbox; Create effects use original CDP controls. */
export async function runDesktopCreateConfigUiSmoke(
  cdp: UiCdpPort,
  options: {
    fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
    evidence: Record<string, unknown>;
    assertOwnedRenderer(): void;
  },
): Promise<void> {
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = {
    status: "INCOMPLETE",
    steps,
    scope:
      "Original CreateTeamDialog save-only → Main captured owner → durable Host Team registry → canonical existing Team view → renderer reload",
    excluded: [
      "launch after Create",
      "selected Resume/relaunch",
      "native inference",
      "all advanced/mixed options",
      "full Stage1",
    ],
  };
  options.evidence.createConfigDialogProof = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (value) =>
      steps.push({ monotonicMs: Math.round(performance.now()), ...value }),
  });
  const read = async (path: string) =>
    record(JSON.parse(await readFile(path, "utf8")));
  const workspace = join(options.fixture.root, "workspace");
  await openOriginalCreateForm(cdp, ui, workspace, "test-created-from-dialog");
  await ui.scrollTo(
    '[role="dialog"] #launch-team',
    "original Run command after create",
  );
  const launch = await cdp.evaluate(
    `document.querySelector('[role="dialog"] #launch-team')?.getAttribute('data-state')`,
  );
  assert.equal(launch, "checked");
  await ui.click(
    '[role="dialog"] #launch-team',
    "disable immediate launch through original checkbox",
  );
  await ui.waitRead(
    `document.querySelector('[role="dialog"] #launch-team')?.getAttribute('data-state')==='unchecked'`,
    "save-only selected",
  );
  await ui.scrollTo(
    '[role="dialog"] button',
    "original Create save control",
    "Create",
  );
  await ui.click(
    '[role="dialog"] button',
    "save original Create once",
    "Create",
  );
  await ui.waitRead(
    `!document.querySelector('[role="dialog"] #team-name')`,
    "original Create closes after saved outcome",
    60_000,
  );
  const owner = await read(
    join(
      options.fixture.root,
      "hoststore/teams/test-created-from-dialog/.host-owner/state.json",
    ),
  );
  assert.equal(record(owner.savedSettings).cwd, workspace);
  assert.equal(owner.ready, true);
  assert.deepEqual(
    (owner.members as unknown[]).map(record).map((row) => [row.name, row.role]),
    [["team-lead", "lead"]],
  );
  const registryPath = join(
    options.fixture.root,
    "hoststore/.host-team-registry/records",
  );
  const registry = await Promise.all(
    (await readdir(registryPath))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => read(join(registryPath, name))),
  );
  assert.equal(registry.length, 1);
  assert.equal(registry[0]!.phase, "published");
  assert.equal(
    record(registry[0]!.record).teamName,
    "test-created-from-dialog",
  );
  proof.creation = registry[0];
  const discovery = record(
    await cdp.evaluate("window.electronAPI.agentBackend.getConnections()"),
  );
  assert.equal(discovery.state, "ready");
  assert.equal((discovery.bindings as unknown[]).length, 2);
  const handleId = record(record(registry[0]!.record).binding).handleId;
  assert.ok(typeof handleId === "string");
  const teamSelection = hostTeamSelectionKey(handleId);
  const lead = (owner.members as unknown[]).map(record).find(row => row.role === "lead")!;
  const leadLabel = lead.name === "team-lead" ? "lead" : String(lead.name);
  assert.ok(
    (discovery.bindings as unknown[])
      .map(record)
      .some((row) => record(row.handle).handleId === handleId),
  );
  await ui.waitRead(
    `window.__agentTeamsDevStore?.getState().selectedTeamName===${JSON.stringify(teamSelection)}&&document.body.innerText.includes('test-created-from-dialog')&&[...document.querySelectorAll('[data-section-id="team"] [role="button"] span.font-medium')].filter(e=>e.textContent.trim()===${JSON.stringify(leadLabel)}&&e.getBoundingClientRect().width>0).length===1`,
    "new owner-qualified Team visible in existing view",
  );
  const screenshot = record(
    await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    }),
  );
  assert.equal(typeof screenshot.data, "string");
  const screenshotPath = join(
    options.fixture.root,
    "ui-original-create-config.png",
  );
  await writeFile(
    screenshotPath,
    Buffer.from(String(screenshot.data), "base64"),
    { mode: 0o600 },
  );
  proof.screenshot = {
    path: screenshotPath,
    sha256: await fileDigest(screenshotPath),
  };
  const before = await cdp.evaluate("performance.timeOrigin");
  await cdp.send("Page.reload", { ignoreCache: false });
  await ui.waitRead(
    `performance.timeOrigin!==${JSON.stringify(before)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    "reloaded original renderer",
  );
  await ui.waitRead(
    `Boolean(document.querySelector('button[aria-label="More actions"]'))`,
    "reloaded original application menu",
    90_000,
  );
  await ui.click(
    'button[aria-label="More actions"]',
    "open reloaded original application menu",
  );
  await ui.click("button", "reopen original Teams list", "Teams");
  await ui.waitRead(
    `document.body.innerText.includes('test-created-from-dialog')`,
    "canonical team survives renderer reload",
    90_000,
  );
  assert.deepEqual(
    await read(
      join(
        options.fixture.root,
        "hoststore/teams/test-created-from-dialog/.host-owner/state.json",
      ),
    ),
    owner,
    "readback never rewrites Team state",
  );
  assert.equal(
    (await readdir(registryPath)).filter((name) =>
      /^[a-f0-9]{64}\.json$/.test(name),
    ).length,
    1,
  );
  proof.status = "PASS";
  proof.settingsRetainedAfterReload = true;
  await runDesktopRosterLifecycleUiSmoke(cdp, options);
}

/** Shared original form navigation, with all edits issued through CDP Input. */
export async function openOriginalCreateForm(
  cdp: UiCdpPort,
  ui: ReturnType<typeof createDesktopUiControls>,
  workspace: string,
  teamName: string,
) {
  await ui.observeInput();
  await ui.waitRead(
    `Boolean(document.querySelector('button[aria-label="More actions"]'))`,
    "existing application menu",
    90_000,
  );
  await ui.click(
    'button[aria-label="More actions"]',
    "open original application menu",
  );
  await ui.click("button", "open original Teams list", "Teams");
  await ui.waitRead(
    `Boolean([...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Create Team'))`,
    "existing Team list create button",
    90_000,
  );
  await ui.click("button", "open original Create Team dialog", "Create Team");
  await ui.waitRead(
    `Boolean(document.querySelector('[role="dialog"] #team-name'))`,
    "original Create Team form",
  );
  await ui.click('[role="dialog"] #team-name', "focus original team name");
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
  await cdp.send("Input.insertText", { text: teamName });
  await ui.waitRead(
    `document.querySelector('[role="dialog"] #team-name')?.value===${JSON.stringify(teamName)}`,
    "typed original team name",
  );
  await ui.scrollTo(
    '[role="dialog"] button',
    "original custom project mode",
    "Custom path",
  );
  await ui.click(
    '[role="dialog"] button',
    "choose original custom project mode",
    "Custom path",
  );
  await ui.scrollTo(
    '[role="dialog"] input[placeholder="/absolute/path/to/project"]',
    "original custom working directory",
  );
  await ui.click(
    '[role="dialog"] input[placeholder="/absolute/path/to/project"]',
    "type TEST workspace",
  );
  await cdp.send("Input.insertText", { text: workspace });
  await ui.waitRead(
    `document.querySelector('[role="dialog"] input[placeholder="/absolute/path/to/project"]')?.value===${JSON.stringify(workspace)}`,
    "sandbox custom path retained",
  );
}
