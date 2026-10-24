import { desktopJsLiteral } from './desktop-ui-controls.ts';
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileDigest } from "./desktop-backend-fixture.ts";
import { createDesktopUiControls } from "./desktop-ui-controls.ts";
import { readDesktopNativeStopSessions } from "./desktop-native-stop-fixture.ts";
import {
  CODEX_QUESTION_TURNS,
  CODEX_QUESTION_TEXT,
  CODEX_QUESTION_ANSWER,
} from "./desktop-codex-question-model.ts";
import type { UiCdpPort } from "./desktop-ui-controls.ts";
import type { startDesktopCodexQuestionModel } from "./desktop-codex-question-model.ts";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Row;
};
const sheet = "div.fixed.bottom-4";

/** Actual finite native MCP elicitation reaches the original existing Question Sheet. */
export async function runDesktopCodexQuestionUiSmoke(
  cdp: UiCdpPort,
  options: {
    root: string;
    seed: { subject: string };
    evidence: Row;
    model: Awaited<ReturnType<typeof startDesktopCodexQuestionModel>>;
    assertOwnedRenderer(): void;
    assertNativeAbsent(): void;
  },
) {
  const steps: Row[] = [],
    commands: Row[] = [];
  const proof = {
    status: "INCOMPLETE",
    steps,
    commands,
    scope:
      "Actual Codex0.162 native finite MCP elicitation through original Composer/Question Sheet, accept and deny, canonical replies",
    excluded: [
      "vendor inference/auth",
      "new question UI",
      "free-text/secret/URL questions",
      "full M06/M07/M08",
      "Stage2",
    ],
  };
  options.evidence.codexQuestionUiProof = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (value) => steps.push(value),
  });
  const launch = row(row(options.evidence.nativeSetup).launch);
  assert.ok(Array.isArray(launch.members) && launch.members.length === 1);
  const selected = row(launch.members[0]);
  assert.equal(selected.memberId, "alice-id");
  const session = async () => {
    const all = (await readDesktopNativeStopSessions(options.root)).filter(
      (value) => row(value.binding).runId === launch.launchId,
    );
    assert.equal(all.length, 1);
    assert.equal(row(all[0]!.binding).memberId, selected.memberId);
    assert.equal(row(all[0]!.binding).generation, selected.generation);
    return all[0]!;
  };
  await ui.observeInput();
  await ui.clickSidebar(options.seed.subject);
  await ui.click('button[aria-label^="alice,"]', "open original alice chat");
  await ui.waitRead(
    "Boolean(document.querySelector('.message-composer-flat-layout textarea'))",
    "original Composer",
  );
  for (const turn of CODEX_QUESTION_TURNS) {
    assert.deepEqual(options.model.failures, []);
    await ui.waitRead(
      `!document.querySelector(${desktopJsLiteral(sheet)})`,
      "previous original Sheet absent",
    );
    await ui.click(
      ".message-composer-flat-layout textarea",
      "focus original Composer",
    );
    await cdp.send("Input.insertText", { text: turn });
    await ui.waitRead(
      `document.querySelector('.message-composer-flat-layout textarea')?.value===${desktopJsLiteral(turn)}`,
      "original text",
    );
    await ui.click(
      "button.message-composer-send-button",
      "original Send once",
      "Send",
    );
    await ui.waitRead(
      `(() => {const e=document.querySelector(${desktopJsLiteral(sheet)});return e?.querySelector('.text-sm.font-semibold')?.textContent?.trim()==='Question'&&e.innerText.includes(${desktopJsLiteral(CODEX_QUESTION_TEXT)});})()`,
      "original native Question Sheet",
      60_000,
    );
    assert.equal(
      options.model.questionReceipts.filter((value) => value.turn === turn)
        .length,
      0,
      "no native answer before original human control",
    );
    const state = await session();
    assert.ok(Array.isArray(state.interactions));
    const pending = state.interactions
      .map(row)
      .filter((value) => value.phase === "pending");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.kind, "question");
    const image = row(
      await cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
      }),
    );
    const path = join(options.root, `ui-${turn.toLowerCase()}.png`);
    await writeFile(path, Buffer.from(String(image.data), "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    steps.push({
      assertion: "original pending native Question",
      turn,
      fact: pending[0],
      screenshot: { path, sha256: await fileDigest(path) },
    });
    if (turn === CODEX_QUESTION_TURNS[0]) {
      // The original option is a button whose visible text includes its A/B index.
      const selector = `${sheet} button`;
      const point = row(
        await ui.waitRead(
          `(() => {const rows=[...document.querySelectorAll(${desktopJsLiteral(selector)})].filter(e=>e.textContent.includes(${desktopJsLiteral(CODEX_QUESTION_ANSWER)}));if(rows.length!==1)return null;const e=rows[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return r.width&&r.height&&hit&&(hit===e||e.contains(hit))?{x,y}:null;})()`,
          "original finite answer option",
        ),
      );
      options.assertOwnedRenderer();
      for (const type of ["mousePressed", "mouseReleased"])
        await cdp.send("Input.dispatchMouseEvent", {
          type,
          ...point,
          button: "left",
          clickCount: 1,
        });
      await ui.click(`${sheet} button`, "original Submit once", "Submit");
    } else {
      // Escape is the existing Sheet's denial path, not an invented cancel control.
      await ui.click(
        `${sheet} .text-sm.font-semibold`,
        "focus original Sheet away from Composer",
      );
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
    }
    await ui.waitRead(
      `document.body.innerText.includes(${desktopJsLiteral(`DONE_${turn}`)})`,
      "actual canonical native reply",
      60_000,
    );
    const directory = join(
      options.root,
      "hoststore/teams/test-desktop-backend/.host-owner/commands",
    );
    const files = (await readdir(directory)).filter((name) =>
      /^[A-Za-z0-9_-]+\.json$/.test(name),
    );
    assert.ok(files.length <= 128);
    const rows = await Promise.all(
      files.map(async (file) =>
        row(JSON.parse(await readFile(join(directory, file), "utf8"))),
      ),
    );
    const source = rows.filter(
      (value) =>
        value.principalId === "TEST-human" &&
        row(value.command).operation === "message.send" &&
        row(row(value.command).payload).text === turn,
    );
    assert.equal(source.length, 1);
    assert.equal(source[0]!.phase, "completed");
    const inputId = row(source[0]!.effects).deliveryId;
    assert.equal(inputId, pending[0]!.inputId);
    let settled = await session();
    const deadline = Date.now() + 45_000;
    const terminal = () =>
      Array.isArray(settled.inputs) &&
      settled.inputs
        .map(row)
        .some(
          (value) =>
            row(value.intent).inputId === inputId &&
            value.phase === "terminal" &&
            value.terminal === "succeeded",
        );
    while (!terminal() && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      settled = await session();
    }
    assert.ok(
      terminal(),
      "same original input succeeds after actual native wire response",
    );
    assert.ok(Array.isArray(settled.interactions));
    const original = settled.interactions
      .map(row)
      .filter((value) => value.inputId === inputId);
    assert.equal(original.length, 1);
    assert.equal(original[0]!.phase, "resolved");
    assert.equal(original[0]!.interactionRef, pending[0]!.interactionRef);
    assert.equal(
      options.model.questionReceipts.filter((value) => value.turn === turn)
        .length,
      1,
    );
    commands.push({
      turn,
      commandId: source[0]!.commandId,
      inputId,
      interaction: original[0],
    });
  }
  assert.deepEqual(options.model.failures, []);
  assert.equal(options.model.observations.length, 6);
  await ui.waitRead(
    `!document.querySelector(${desktopJsLiteral(sheet)})`,
    "last original Sheet dismissed",
  );
  await ui.click(
    'button[aria-label="Stop"]',
    "original team Stop once",
    "Stop",
  );
  await ui.waitRead(
    "![...document.querySelectorAll('button')].some(e=>e.getAttribute('aria-label')==='Stop'||e.getAttribute('aria-label')?.startsWith('Stopping'))",
    "original Stop settles",
  );
  const stopped = await session();
  assert.equal(stopped.phase, "closed");
  assert.equal(stopped.custody, "released");
  options.assertNativeAbsent();
  options.evidence.codexQuestionUiProof = {
    ...proof,
    status: "PASS",
    wireReceipts: options.model.questionReceipts,
    observations: options.model.observations,
    nativeAfterStop: stopped,
  };
}
