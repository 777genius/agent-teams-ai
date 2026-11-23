// CDP scenario for the REAL-vendor composer proof. Physical keyboard events only: a controlled
// React draft is never assigned through DOM evaluation.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { CdpClient } = require('../comment-notification/cdp.mjs') as {
  CdpClient: { connect(url: string): Promise<Cdp> };
};

interface Cdp {
  send(method: string, params?: object): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
export interface UiScenarioInput {
  readonly port: number;
  readonly root: string;
  readonly handleId: string;
  readonly out: string;
  readonly maxTurns: number;
  readonly vendor: 'claude' | 'codex';
  /** The user turned this provider's setting off: the proof is that nothing is offered. */
  readonly providerOff?: boolean;
}
export interface UiScenarioReport {
  status: 'pass' | 'fail' | 'inconclusive';
  reason?: string;
  steps: Record<string, unknown>[];
  turns: Record<string, unknown>[];
  interactions: Record<string, Record<string, unknown>>;
  explicitSends?: number;
}

const TA = '.message-composer-flat-layout textarea';
const ROW = '[data-testid="native-next-prompt-row"]';
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const ROW_WAIT_MS = 15_000;
const PROMPTS = [
  'Hi alice, what is the capital of France?',
  'Thanks. Name two famous landmarks in that city.',
  'Great. Which of those two is older? One sentence.',
  'Thanks. What language do they speak there? One sentence.',
  'And which river runs through it? One sentence.',
  'Last one: what currency do they use? One sentence.',
  'Which museum there is the most visited? One sentence.',
  'Which season is best to visit? One sentence.',
];

export async function runUiScenario(input: UiScenarioInput): Promise<UiScenarioReport> {
  const targets = (await (await fetch(`http://127.0.0.1:${input.port}/json/list`)).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = targets.find((candidate) => candidate.type === 'page');
  if (!page) throw new Error('no renderer page on the CDP port');
  const cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
  const ev = async (expression: string) => {
    const reply = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (reply.exceptionDetails)
      throw new Error(`eval failed: ${JSON.stringify(reply.exceptionDetails).slice(0, 300)}`);
    return reply.result.value;
  };
  const until = async (expression: string, label: string, ms = 60_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(400))
      if (await ev(expression).catch(() => null)) return;
    throw new Error(`timeout waiting for: ${label}`);
  };
  const shot = async (name: string) => {
    const reply = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(input.out, `${name}.png`), Buffer.from(reply.data, 'base64'), {
      mode: 0o600,
    });
  };
  const key = async (name: string, code: string, virtual: number, modifiers = 0) => {
    for (const type of ['rawKeyDown', 'keyUp'])
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key: name,
        code,
        windowsVirtualKeyCode: virtual,
        nativeVirtualKeyCode: virtual,
        modifiers,
      });
  };
  const commands = join(input.root, 'hoststore/teams/test-desktop-backend/.host-owner/commands');
  /** Counts human DMs the Host accepted; a suggestion must never produce one by itself. */
  const humanSends = () => {
    try {
      return readdirSync(commands)
        .map((file) => JSON.parse(readFileSync(join(commands, file), 'utf8')))
        .filter(
          (row) => row.principalId === 'TEST-human' && row.command?.operation === 'message.send'
        ).length;
    } catch {
      return -1;
    }
  };
  const humanCommandIds = () => {
    try {
      return readdirSync(commands)
        .map((file) => JSON.parse(readFileSync(join(commands, file), 'utf8')))
        .filter(
          (row) => row.principalId === 'TEST-human' && row.command?.operation === 'message.send'
        )
        .map((row) => ({ commandId: row.commandId, payload: row.command?.payload }));
    } catch {
      return [];
    }
  };
  const invoke = (operation: string, payload: object) =>
    ev(
      `window.electronAPI.agentBackend.invoke({handle:{handleId:${JSON.stringify(input.handleId)}}, commandId:'real-'+Date.now()+Math.random(), operation:${JSON.stringify(operation)}, payload:${JSON.stringify(payload)}})`
    );
  const rowText = () => ev(`document.querySelector('${ROW}')?.innerText.split('\\n')[0] ?? null`);
  const draft = () => ev(`document.querySelector('${TA}').value`);
  const clearDraft = async () => {
    await ev(`document.querySelector('${TA}').focus()`);
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
    await key('Backspace', 'Backspace', 8);
    await until(`document.querySelector('${TA}').value===''`, 'draft cleared', 8_000);
  };
  const send = async (text: string) => {
    await ev(`document.querySelector('${TA}').focus()`);
    await cdp.send('Input.insertText', { text });
    await until(
      `document.querySelector('${TA}').value===${JSON.stringify(text)}`,
      'typed text in composer'
    );
    await ev(`document.querySelector('button.message-composer-send-button').click()`);
    await until(
      `document.querySelector('${TA}').value===''`,
      'composer cleared after send',
      20_000
    );
  };
  const allTerminal = async () => {
    const reply = await invoke('runtime.read', { memberId: 'alice-id' });
    const inputs = (reply.value?.inputs ?? []) as { phase: string }[];
    return inputs.length > 0 && inputs.every((row) => row.phase === 'terminal');
  };

  // A user's window is visible and focused; a CDP-driven background window is not. Emulate the former so the
  // renderer behaves as it does for a person (timers, visibility- and focus-gated refreshes).
  await cdp.send('Page.bringToFront').catch(() => {});
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  const windowState = await ev(
    '({ visibility: document.visibilityState, focused: document.hasFocus() })'
  );

  const report: UiScenarioReport = { status: 'fail', steps: [], turns: [], interactions: {} };
  const step = (value: Record<string, unknown>) => report.steps.push(value);
  const plan = ['tab', 'escape', 'insert'];
  try {
    // The Team opens lazily; click through the seeded task/open-team affordances until alice is reachable.
    for (
      let attempt = 0;
      attempt < 20 && !(await ev(`!!document.querySelector('button[aria-label^="alice,"]')`));
      attempt += 1
    ) {
      await ev(
        `(() => { const open=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Open team'); if (open) { open.click(); return 'open'; } const task=[...document.querySelectorAll('span')].find(e=>e.children.length===0 && e.textContent.trim()==='TEST persisted Host sidebar seed'); task?.click(); return 'task'; })()`
      );
      await sleep(1_500);
    }
    await until(
      `!!document.querySelector('button[aria-label^="alice,"]')`,
      'alice sidebar button',
      30_000
    );
    await ev(`document.querySelector('button[aria-label^="alice,"]').click()`);
    await until(`!!document.querySelector('${TA}')`, 'composer textarea', 30_000);
    // Navigating via the seeded task can leave its detail dialog over the composer. Dismiss it the way a
    // user does (Escape) until the composer is really the topmost element at its own centre.
    const composerReachable = `(() => { const ta=document.querySelector('${TA}'); if (!ta) return false; const r=ta.getBoundingClientRect(); const hit=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return !!hit && (hit===ta || ta.contains(hit)); })()`;
    for (let attempt = 0; attempt < 4 && !(await ev(composerReachable)); attempt += 1) {
      await key('Escape', 'Escape', 27);
      await sleep(600);
    }
    await until(composerReachable, 'composer reachable (not covered by a dialog)', 10_000);
    const optIn = await ev(
      `window.electronAPI.config.get().then(c => c.providerConnections.${input.vendor === 'codex' ? 'codex' : 'anthropic'}.nativeNextPromptSuggestionsEnabled === true)`
    );
    step({ optIn, windowState });
    if (optIn !== !input.providerOff)
      throw new Error(
        `the provider setting is ${String(optIn)} in the app config, expected ${!input.providerOff}`
      );
    await ev(
      `(() => { window.__REAL_notices=[]; window.electronAPI.nativePromptSuggestions.onUpdated(v => window.__REAL_notices.push(JSON.parse(JSON.stringify(v)))); return true; })()`
    );
    const opened = await invoke('runtime.open', { memberId: 'alice-id' });
    step({
      open: {
        ok: opened.ok,
        nativeReady: opened.value?.nativeReady,
        diagnostic: opened.value?.diagnostic,
      },
    });
    if (!opened.value?.nativeReady)
      throw new Error(
        `native session not ready: ${JSON.stringify(opened.value?.diagnostic ?? opened.error ?? null)}`
      );
    await shot('00-opened');
    if (input.providerOff) {
      // Negative proof: only meaningful next to a passing positive run for the same vendor and account.
      for (const text of PROMPTS.slice(0, Math.min(2, input.maxTurns))) {
        await send(text);
        for (
          const end = Date.now() + 150_000;
          Date.now() < end && !(await allTerminal().catch(() => false));
          await sleep(1_500)
        );
        await sleep(30_000);
      }
      const offered = ((await ev('window.__REAL_notices')) as unknown[]).length;
      const rows = await rowText();
      report.turns.push({ providerOff: true, notices: offered, row: rows });
      report.status = offered === 0 && rows === null ? 'pass' : 'fail';
      if (report.status === 'fail')
        report.reason = `provider setting is off but ${offered} notice(s) and row ${JSON.stringify(rows)} appeared`;
      writeFileSync(join(input.out, 'ui-report.json'), `${JSON.stringify(report, null, 2)}\n`, {
        mode: 0o600,
      });
      return report;
    }

    const sendsBefore0 = humanSends();
    let sent = 0;
    for (const [index, text] of PROMPTS.slice(0, input.maxTurns).entries()) {
      if (plan.length === 0) break;
      const noticesBefore = ((await ev('window.__REAL_notices')) as unknown[]).length;
      await send(text);
      sent += 1;
      let terminal = false;
      for (const end = Date.now() + 150_000; Date.now() < end && !terminal; await sleep(1_500))
        terminal = await allTerminal().catch(() => false);
      // Phase 1: did the vendor push a notice to the renderer at all? Phase 2: how long until the composer
      // renders it (it also needs the canonical inbox readback of the DM). Both latencies are reported.
      const turnStart = Date.now();
      let noticeMs: number | null = null;
      for (const end = turnStart + 45_000; Date.now() < end && noticeMs === null; await sleep(500))
        if (((await ev('window.__REAL_notices')) as unknown[]).length > noticesBefore)
          noticeMs = Date.now() - turnStart;
      let offer: string | null = null;
      let rowMs: number | null = null;
      if (noticeMs !== null)
        for (const end = Date.now() + ROW_WAIT_MS; Date.now() < end && !offer; await sleep(700)) {
          offer = await rowText();
          if (offer) rowMs = Date.now() - turnStart;
        }
      const notices = (await ev('window.__REAL_notices')) as unknown[];
      report.turns.push({
        index,
        terminal,
        noticeDelta: notices.length - noticesBefore,
        notices: notices.slice(noticesBefore),
        humanCommands: humanCommandIds(),
        offer,
        noticeMs,
        rowMs,
        // Diagnostic only: renderer state behind the composer's display gates when no row was found.
        ...(offer
          ? {}
          : {
              gates: await ev(
                `(() => { const st = window.__agentTeamsDevStore?.getState(); if (!st) return 'no dev store'; const tn = st.selectedTeamName; const msgs = st.teamMessagesByName?.[tn]?.canonicalMessages ?? null; const data = st.selectedTeamData; return { selectedTeamName: tn, canonicalCount: msgs ? msgs.length : null, userMessages: (msgs || []).filter(m => m.from === 'user').map(m => ({ to: m.to, id: m.messageId, ts: m.timestamp })), members: (data?.members || []).map(m => ({ name: m.name, runtimeOwner: m.runtimeOwner, hostMemberId: m.hostMemberId })), isAlive: data?.isAlive, warnings: data?.warnings, teamKeys: Object.keys(st).filter(k => /team/i.test(k)).slice(0, 30) }; })()`
              ),
            }),
        ...(offer
          ? {}
          : {
              rosterRead: await invoke('team.roster.read', {})
                .then((reply: { ok?: boolean; code?: string; value?: unknown }) => ({
                  ok: reply.ok,
                  code: reply.code,
                  value: JSON.stringify(reply.value ?? null).slice(0, 700),
                }))
                .catch((error: unknown) => String(error)),
            }),
        // Diagnostic only: what the composer area actually rendered when no offer row was found.
        ...(offer
          ? {}
          : {
              composerText: await ev(
                `document.querySelector('.message-composer-flat-layout')?.innerText.slice(0, 300) ?? null`
              ),
            }),
      });
      await shot(`t${index + 1}`);
      if (!terminal) throw new Error(`turn ${index + 1} did not reach a terminal state`);
      if (!offer) continue;
      const kind = plan.shift()!;
      const before = humanSends();
      await ev(`document.querySelector('${TA}').focus()`);
      if (kind === 'tab') {
        await key('Tab', 'Tab', 9);
        await sleep(1_500);
        const value = await draft();
        report.interactions.tab = {
          offer,
          draftAfter: value,
          inserted: value === offer,
          rowGone: (await rowText()) === null,
          autoSent: humanSends() !== before,
        };
        await shot(`t${index + 1}-after-tab`);
        await clearDraft();
      } else if (kind === 'escape') {
        await key('Escape', 'Escape', 27);
        await sleep(1_500);
        report.interactions.escape = {
          offer,
          rowGone: (await rowText()) === null,
          draftEmpty: (await draft()) === '',
          autoSent: humanSends() !== before,
        };
        await shot(`t${index + 1}-after-escape`);
      } else {
        await ev(
          `[...document.querySelectorAll('${ROW} button')].find(b=>/insert/i.test(b.innerText||b.getAttribute('aria-label')||''))?.click()`
        );
        await sleep(1_500);
        const value = await draft();
        report.interactions.insert = {
          offer,
          draftAfter: value,
          inserted: value === offer,
          autoSent: humanSends() !== before,
        };
        await shot(`t${index + 1}-after-insert`);
        await clearDraft();
      }
      step({ [kind]: report.interactions[kind] });
    }
    report.explicitSends = humanSends() - sendsBefore0;
    const done = Object.entries(report.interactions);
    const broken = done.filter(
      ([name, value]) =>
        value.autoSent !== false ||
        (name !== 'escape' && value.inserted !== true) ||
        (name === 'tab' && value.rowGone !== true) ||
        (name === 'escape' && (value.rowGone !== true || value.draftEmpty !== true))
    );
    if (broken.length > 0) {
      report.status = 'fail';
      report.reason = `composer behaviour violated: ${broken.map(([name]) => name).join(', ')}`;
    } else if (report.explicitSends !== sent) {
      report.status = 'fail';
      report.reason = `expected ${sent} human sends, the Host recorded ${report.explicitSends} (a suggestion must never send)`;
    } else if (plan.length > 0) {
      report.status = 'inconclusive';
      report.reason = `the vendor offered too few suggestions to exercise ${plan.join('/')} within ${sent} turns (the ones seen behaved correctly)`;
    } else report.status = 'pass';
  } catch (error) {
    report.status = 'fail';
    report.reason = error instanceof Error ? error.message : String(error);
    await shot('99-failure').catch(() => {});
  }
  writeFileSync(join(input.out, 'ui-report.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  return report;
}
