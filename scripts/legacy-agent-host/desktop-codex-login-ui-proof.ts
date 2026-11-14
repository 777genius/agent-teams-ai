import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from './desktop-backend-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};

/** Actual Settings inputs. No renderer API mutation, token fixture or browser credential reuse. */
export async function runDesktopCodexLoginUiProof(
  cdp: UiCdpPort,
  options: {
    fixture: { profilePath: string; root: string };
    evidence: Record<string, unknown>;
    execution?: 'finite-protocol-peer';
    assertOwnedRenderer(): void;
  }
): Promise<void> {
  const { fixture, evidence } = options;
  const steps: Record<string, unknown>[] = [];
  const cases: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE', steps, cases,
    ...(options.execution === 'finite-protocol-peer'
      ? { execution: options.execution, protocolRevision: '0.162.0', vendorExecutable: false }
      : { nativeVersion: '0.162.0' }),
    platform: process.platform, architecture: process.arch,
    externalOpen: process.platform === 'linux'
      ? 'Actual Electron dispatch to a private TEST OS opener; only URL digest retained'
      : 'Button presence only; personal browser not opened',
    vendorCompletion: 'Not attempted; requires a dedicated authorized TEST account',
  };
  evidence.codexLoginUi = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (value) => { steps.push(value); },
  });
  const profile = record(JSON.parse(await readFile(fixture.profilePath, 'utf8')));
  const commandsDirectory = join(String(record(profile.owner).storageRoot), 'management-commands');
  const commands = async (): Promise<Record<string, unknown>[]> => {
    const names = await readdir(commandsDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert.ok(names.length <= 32, 'bounded fresh TEST auth journal');
    return Promise.all(names.map(async name => record(JSON.parse(await readFile(join(commandsDirectory, name), 'utf8')))));
  };
  const snapshot = async () => {
    options.assertOwnedRenderer();
    return record(await cdp.evaluate('window.electronAPI.getCodexAccountSnapshot()'));
  };
  assert.equal((await commands()).filter(row => row.kind === 'oauth').length, 0);
  assert.equal((await snapshot()).managedAccount, null, 'fresh TEST account is signed out');

  await ui.observeInput();
  await ui.click('button[aria-label="More actions"]', 'open existing More menu');
  await ui.click('button', 'open existing Settings', 'Settings');
  await ui.click('[data-testid="settings-nav-providers"]', 'open existing Providers settings');
  const manage = '[data-testid="provider-settings-page"] [data-testid="runtime-manage-codex"]';
  const dialogButtons = '[role="dialog"] button';
  const openManage = async () => {
    await ui.scrollTo(manage, 'show original Codex Manage action');
    await ui.click(manage, 'open original Codex settings dialog');
  };
  await openManage();
  let externalOpenCount = 0;
  for (const [index, mode, label] of [[0, 'browser', 'Connect ChatGPT'], [1, 'device_code', 'Use code']] as const) {
    const result: Record<string, unknown> = { mode, status: 'INCOMPLETE' };
    cases.push(result);
    await ui.scrollTo(dialogButtons, 'show original login action', label);
    await ui.click(dialogButtons, 'start one original ' + mode + ' login', label);
    // Private read remains in this process; neither URLs nor codes enter the receipt/logs.
    const login = record(await ui.waitRead(
      `window.electronAPI.getCodexAccountSnapshot().then(s=>s.login?.authUrl?{status:s.login.status,authUrl:s.login.authUrl,userCode:s.login.userCode??null}:s.login?.status==='failed'?{status:'failed'}:null)`,
      mode + ' native authorization outcome', 30_000
    ));
    result.nativeStatus = login.status;
    assert.equal(login.status, 'pending', 'native login must return a pending authorization');
    assert.equal(typeof login.authUrl, 'string');
    const privateUrl = String(login.authUrl);
    const privateCode = typeof login.userCode === 'string' ? login.userCode : null;
    assert.equal(new URL(privateUrl).protocol, 'https:');
    assert.equal(mode === 'device_code' ? Boolean(privateCode) : privateCode === null, true);
    const copySelector = '[role="dialog"] button[title=' + desktopJsLiteral(
      privateCode ? 'Copy ChatGPT login link and code' : 'Copy ChatGPT login link'
    ) + ']';
    await ui.waitRead(`Boolean(document.querySelector(${desktopJsLiteral(copySelector)}))`, 'rendered private login controls');
    if (privateCode) assert.equal(await cdp.evaluate(
      `Array.from(document.querySelectorAll('[role="dialog"] .font-mono')).some(e=>e.textContent===${desktopJsLiteral(privateCode)})`
    ), true, 'actual device-code badge matches the private native reply');
    await ui.click(copySelector, 'copy original private login link/code');
    await ui.waitRead(`document.querySelector(${desktopJsLiteral(copySelector)})?.textContent.trim()==='Copied'`, 'native clipboard write acknowledged');
    result.copyAcknowledged = true;
    await ui.scrollTo(dialogButtons, 'show original Open login action', 'Open login');
    if (process.platform === 'linux') {
      await ui.click(dialogButtons, 'open original login through TEST OS opener', 'Open login');
      externalOpenCount++;
      const end = Date.now() + 5000;
      let rows: Record<string, unknown>[] = [];
      do {
        try {
          rows = (await readFile(join(fixture.root, 'external-open.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => record(JSON.parse(line)));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (rows.length === externalOpenCount) break;
        await delay(100);
      } while (Date.now() < end);
      assert.equal(rows.length, externalOpenCount, 'one OS opener dispatch per explicit click');
      assert.equal(rows.at(-1)?.sha256 === digest(privateUrl), true, 'original URL reached the TEST OS opener');
      result.externalOpenDispatched = true;
    }
    const pending = await commands();
    const oauth = pending.filter(row => row.kind === 'oauth');
    assert.equal(oauth.length, index + 1, 'one native authorization receipt per start');
    const original = oauth.find(row => row.methodIndex === index);
    assert.ok(original);
    assert.equal(original.phase, 'waiting-for-browser');
    assert.equal(original.completionMethod, 'auto');
    const serialized = JSON.stringify(pending);
    assert.equal(serialized.includes(privateUrl) || Boolean(privateCode && serialized.includes(privateCode)), false,
      'public durable journal excludes native authorization secrets');

    // Reopen the actual dialog: existing private authorization must survive presentation teardown.
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await ui.waitRead(`document.querySelector('[role="dialog"]')===null`, 'close original settings dialog');
    await openManage();
    await ui.waitRead(`Boolean(document.querySelector(${desktopJsLiteral(copySelector)}))`, 'original pending login after reopen');
    const reopened = record((await snapshot()).login);
    assert.equal(reopened.authUrl === privateUrl && reopened.userCode === login.userCode, true, 'same private authorization after reopen');
    assert.equal((await commands()).filter(row => row.kind === 'oauth').length, index + 1, 'reopen never starts another login');
    result.reopenPreservedOriginal = true;
    await ui.scrollTo(dialogButtons, 'show original Cancel login action', 'Cancel login');
    await ui.click(dialogButtons, 'cancel original ' + mode + ' login', 'Cancel login');
    await ui.waitRead(
      `window.electronAPI.getCodexAccountSnapshot().then(s=>s.login?.status==='cancelled'&&!s.login.authUrl&&!s.login.userCode&&s.managedAccount===null)`,
      'native cancellation and signed-out readback', 30_000
    );
    await ui.waitRead(`!document.querySelector(${desktopJsLiteral(copySelector)})`, 'private login fields disappear');
    const retired = (await commands()).find(row => row.commandId === original.commandId);
    assert.equal(retired?.phase, 'cancelled');
    assert.equal(retired?.resourceHeld, false, 'original native cleanup confirmed before retry');
    assert.equal((await commands()).some(row => row.kind === 'credential.forget'), false, 'cancel never logs out');
    result.status = 'PASS';
    result.cancelledOriginal = true;
    result.privateFieldsCleared = true;
  }
  const inputProof = record(await cdp.evaluate(`(() => {
    const rows=window.__TEST_desktopInputEvents??[];
    return {clicks:rows.filter(e=>e.type==='click').length,allClicksTrusted:rows.filter(e=>e.type==='click').every(e=>e.trusted===true)};
  })()`));
  assert.equal(inputProof.allClicksTrusted, true);
  assert.ok(Number(inputProof.clicks) >= 8);
  proof.input = inputProof;
  proof.status = 'PASS';
}

/** Existing receipt facts only: an attempted input never proves its native outcome. */
export function projectDesktopCodexLoginFailure(evidence: Record<string, unknown>): Record<string, unknown> {
  const scope = 'codex-login-ui-retained-failure';
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  const present = (value: unknown): boolean | null => {
    if (value === undefined) return false;
    return object(value) ? true : null;
  };
  const failureRecorded = (value: unknown): boolean | null => {
    if (value === undefined) return false;
    return typeof value === 'string' ? true : null;
  };
  const boolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
  const choice = (value: unknown, allowed: readonly string[]): string | null =>
    typeof value === 'string' && allowed.includes(value) ? value : null;
  const count = (value: unknown, limit: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? { count: Math.min(value, limit), overflow: value > limit } : { count: null, overflow: null };
  try {
    const proof = object(evidence.codexLoginUi), cleanup = object(evidence.cleanup);
    const listener = object(evidence.cdpListenerFailure);
    const rawSteps = proof?.steps, rawCases = proof?.cases, remaining = cleanup?.remaining;
    const steps: unknown[] | undefined = Array.isArray(rawSteps) ? rawSteps : undefined;
    const cases: unknown[] | undefined = Array.isArray(rawCases) ? rawCases : undefined;
    const last = steps?.length ? object(steps[steps.length - 1]) : undefined;
    const rawLabel = last?.label;
    const label = typeof rawLabel === 'string' && rawLabel.length <= 128
      ? rawLabel.replace(/^hover /, '') : undefined;
    const stages = new Map([
      ['open existing More menu', 'more-menu'], ['open existing Settings', 'settings'],
      ['open existing Providers settings', 'providers'],
      ['show original Codex Manage action', 'manage'], ['open original Codex settings dialog', 'manage'],
      ['show original login action', 'start'], ['start one original browser login', 'browser-start'],
      ['start one original device_code login', 'device-code-start'],
      ['copy original private login link/code', 'copy'],
      ['show original Open login action', 'open-login'], ['open original login through TEST OS opener', 'open-login'],
      ['show original Cancel login action', 'cancel'], ['cancel original browser login', 'browser-cancel'],
      ['cancel original device_code login', 'device-code-cancel'],
    ]);
    const projection = {
      scope, unavailable: false,
      status: choice(evidence.status, ['PASS', 'INCOMPLETE']),
      initialSnapshotRecorded: present(evidence.codexInitialAccount),
      proofRecorded: present(evidence.codexLoginUi),
      originalFailureRecorded: failureRecorded(evidence.failure),
      listenerFailure: {
        recorded: present(evidence.cdpListenerFailure),
        ...count(listener?.scope === 'original-linux-lsof-test-cdp' ? listener.holderCount : undefined, 256),
      },
      proofStatus: choice(proof?.status, ['PASS', 'INCOMPLETE']),
      steps: {
        ...count(steps?.length, 256),
        lastAction: choice(last?.action, ['mouseMoved', 'mouseClick', 'mouseWheel']),
        lastAttempt: label === undefined ? null : stages.get(label) ?? null,
      },
      cases: {
        ...count(cases?.length, 2),
        items: (cases?.slice(0, 2) ?? []).map(value => {
          const item = object(value);
          return {
            mode: choice(item?.mode, ['browser', 'device_code']),
            status: choice(item?.status, ['PASS', 'INCOMPLETE']),
            nativeStatus: choice(item?.nativeStatus, ['pending', 'failed']),
            copyAcknowledged: boolean(item?.copyAcknowledged),
            externalOpenDispatched: boolean(item?.externalOpenDispatched),
            reopenPreservedOriginal: boolean(item?.reopenPreservedOriginal),
            cancelledOriginal: boolean(item?.cancelledOriginal),
            privateFieldsCleared: boolean(item?.privateFieldsCleared),
          };
        }),
      },
      cleanup: {
        recorded: present(evidence.cleanup),
        ...count(Array.isArray(remaining) ? remaining.length : undefined, 256),
        capturedHostObserved: boolean(cleanup?.capturedHostObserved),
        capturedHostAbsent: boolean(cleanup?.capturedHostAbsent),
        failureRecorded: failureRecorded(cleanup?.cleanupFailure),
      },
    };
    return Buffer.byteLength(JSON.stringify(projection)) <= 4096
      ? projection : { scope, unavailable: true };
  } catch {
    return { scope, unavailable: true };
  }
}
