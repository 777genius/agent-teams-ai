import { groupMembers, command } from './desktop-backend-observations.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { assertProcessFixture, probeProcessService, readProcessServices } from './desktop-native-process-fixture.ts';
import { PROCESS_LABEL } from './desktop-native-process-model.ts';
const row = (v: unknown): Record<string, unknown> => {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v));
  return v as Record<string, unknown>;
};
async function stopReceipts(root: string) {
  const path = join(root, 'hoststore/teams/test-desktop-backend/commands');
  const files = (await readdir(path)).filter((p) => /^[a-f0-9]{64}\.json$/.test(p));
  assert.ok(files.length <= 128);
  const records = await Promise.all(
    files.map(async (p) => row(JSON.parse(await readFile(join(path, p), 'utf8'))))
  );
  return records.filter((r) => r.family === 'process' && r.operation === 'terminate');
}
/** Cold owner UI read and one original Stop. No DOM handlers, store mutations, or native replay. */
export async function qualifyColdProcessUi(
  cdp: UiCdpPort,
  options: {
    fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
    evidence: Record<string, unknown>;
    assertOwnedRenderer(): void;
    group: number;
  }
) {
  assert.equal(process.env.LEGACY_M19_PROVIDER_UI_GO, '1');
  const { fixture } = options;
  assertProcessFixture(fixture);
  const before = row(
    JSON.parse(await readFile(join(fixture.root, 'native-process-before-crash.json'), 'utf8'))
  );
  const original = row(before.original),
    processRef = String(original.processRef),
    id = String(original.id);
  const selection = hostTeamSelectionKey(fixture.handleId);
  const services = await readProcessServices(fixture.root);
  await probeProcessService(services.primary);
  await probeProcessService(services.neighbor);
  assert.deepEqual(await stopReceipts(fixture.root), []);
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    steps,
    original,
    selection,
    scope:
      'Actual native member MCP registration → original Host controlled crash → existing Electron ProcessesSection original-ref Stop',
    excluded: [
      'whole process tree stop',
      'provider native-root cleanup qualification',
      'teammate readiness from process state',
      'PID/group signal fallback',
      'automatic uncertain stop retry',
    ],
  };
  options.evidence.nativeProcessUi = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (v) => steps.push({ at: Date.now(), ...v }),
  });
  await ui.observeInput();
  await ui.waitRead(
    `Boolean(document.querySelector('#sidebar-tasks-panel'))`,
    'original cold sidebar',
    90_000
  );
  await ui.clickSidebar(fixture.uiSeed.subject);
  await ui.waitRead(
    `Boolean(document.querySelector('[data-section-id="processes"]'))`,
    'original ProcessesSection exists after real Host restart',
    45_000
  );
  const hosts = groupMembers(options.group).filter(p => command(p.pid) === `${fixture.node} ${fixture.hostEntry}`);
  assert.equal(hosts.length, 1, 'one original cold selected standalone Host');
  const hostPid = hosts[0]!.pid;
  options.evidence.coldProcessHost = { ...hosts[0], command: `${fixture.node} ${fixture.hostEntry}`, observedBeforeShutdown: true };
  const collapse = await cdp.evaluate(
    `document.querySelector('[data-section-id="processes"] button[aria-label="Expand section"]')!==null`
  );
  if (collapse)
    await ui.click(
      '[data-section-id="processes"] button[aria-label="Expand section"]',
      'expand original process section'
    );
  const ownershipExpression = `(() => {
    const section=document.querySelector('[data-section-id="processes"]');if(!section)return null;
    for(const node of [section,...section.querySelectorAll('*')]) {
      const key=Object.keys(node).find(k=>k.startsWith('__reactFiber$'));let fiber=key?node[key]:null;
      for(let depth=0;fiber&&depth<128;depth++,fiber=fiber.return) {
        for(const f of [fiber,fiber.alternate]) {
          const p=f?.memoizedProps;if(!p||p.teamName!==${JSON.stringify(selection)}||!Array.isArray(p.processes))continue;
          const rows=p.processes.filter(r=>r.id===${JSON.stringify(id)}&&r.processRef===${JSON.stringify(processRef)});
          if(rows.length===1)return {teamName:p.teamName,process:rows[0],isTeamAlive:p.isTeamAlive??null};
        }
      }
    } return null;
  })()`;
  const owner = row(
    await ui.waitRead(
      ownershipExpression,
      'exact canonical process props, independent of compiled function name'
    )
  );
  assert.equal(owner.teamName, selection);
  const processRow = row(owner.process);
  assert.equal(processRow.pid, services.primary.pid);
  assert.equal(processRow.label, PROCESS_LABEL);
  assert.equal(processRow.observation, 'same-live');
  assert.equal(processRow.canTerminate, true);
  assert.equal(processRow.pendingStop, undefined);
  proof.coldOwnerProps = owner;
  // Actual unified renderer read, never a monkeypatch or alternate mutation path.
  const data = row(
    await cdp.evaluate(
      `(async()=>{const {api}=await import('/src/renderer/api/index.ts');return await api.teams.getData(${JSON.stringify(selection)});})()`
    )
  );
  const inventory = (data.processes as unknown[]).map(row);
  assert.equal(inventory.filter((p) => p.processRef === processRef).length, 1);
  assert.equal(inventory.find((p) => p.processRef === processRef)!.canTerminate, true);
  proof.coldOwnerRead = data;
  const screenshot = async (name: string) => {
    const value = row(
      await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
      })
    );
    const path = join(fixture.root, name);
    await writeFile(path, Buffer.from(String(value.data), 'base64'), {
      mode: 0o600,
      flag: 'wx',
    });
    return { path, sha256: await fileDigest(path) };
  };
  proof.beforeScreenshot = await screenshot('ui-original-native-process-before-stop.png');
  await ui.scrollTo('[data-section-id="processes"] button', 'actual original Stop button', 'Kill');
  const stopPoint = await ui.waitRead(
    `(() => {
    const buttons=[...document.querySelectorAll('[data-section-id="processes"] button')].filter(b=>b.textContent.trim()==='Kill');
    if(buttons.length!==1)return null;const b=buttons[0],container=b.parentElement?.parentElement;
    return container?.textContent.includes(${JSON.stringify(PROCESS_LABEL)})&&container.textContent.includes(${JSON.stringify(String(services.primary.pid))})?true:null;
  })()`,
    'one original displayed primary Stop action'
  );
  assert.equal(stopPoint, true);
  await writeFile(
    join(fixture.root, 'ui-original-process-stop-attempted.json'),
    JSON.stringify({
      processRef,
      id,
      displayedPid: services.primary.pid,
      action: 'existing ProcessesSection Kill button once',
    }),
    { mode: 0o600, flag: 'wx' }
  );
  await ui.click(
    '[data-section-id="processes"] button',
    'one original ProcessesSection Stop',
    'Kill'
  );
  const deadline = Date.now() + 15_000;
  let receipt: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const receipts = await stopReceipts(fixture.root);
    assert.ok(receipts.length <= 1, 'one original Stop command; no automatic new nonce');
    if (receipts.length) {
      receipt = receipts[0];
      break;
    }
    await delay(50);
  }
  assert.ok(receipt, 'original UI stop writes durable requested intent before native entry');
  assert.equal(receipt.processRef, processRef);
  assert.ok(['requested', 'completed'].includes(String(row(receipt.state).phase)));
  proof.initialStopReceipt = receipt;
  const commandId = String(receipt.commandId);
  // Only exact original lookup may reconcile accepted with observed absence. No terminate replay.
  let terminal: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    options.assertOwnedRenderer();
    const request = {
      handle: { handleId: fixture.handleId },
      commandId: randomUUID(),
      operation: 'process.lookup',
      payload: { originalCommandId: commandId },
    };
    const result = row(
      await cdp.evaluate(`window.electronAPI.agentBackend.invoke(${JSON.stringify(request)})`)
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const found = row(result.value);
    assert.equal(found.commandId, commandId);
    assert.equal(found.originalProcessRef, processRef);
    const state = row(found.state);
    if (state.phase === 'completed') {
      assert.equal(state.native, 'observed-absent');
      assert.equal(state.signalAccepted, true);
      terminal = found;
      break;
    }
    assert.equal(state.phase, 'requested');
    assert.equal(state.native, 'accepted');
    await delay(100);
  }
  assert.ok(terminal, 'signal acceptance alone cannot qualify observed original exit');
  await probeProcessService(services.neighbor);
  const history = await stopReceipts(fixture.root);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.commandId, commandId);
  assert.equal(row(history[0]!.state).phase, 'completed');
  const lifecycle = (
    await readFile(join(fixture.root, 'workspace/process-primary-lifecycle.ndjson'), 'utf8')
  )
    .trim()
    .split('\n')
    .map((line) => row(JSON.parse(line)));
  assert.equal(lifecycle.filter((e) => e.event === 'closing' && e.reason === 'SIGTERM').length, 1);
  assert.equal(lifecycle.filter((e) => e.event === 'closed' && e.reason === 'SIGTERM').length, 1);
  const neighborLifecycle = await readFile(
    join(fixture.root, 'workspace/process-neighbor-lifecycle.ndjson'),
    'utf8'
  );
  assert.equal(neighborLifecycle.includes('SIGTERM'), false);
  proof.terminalStop = terminal;
  proof.ownerHistory = history;
  proof.primaryLifecycle = lifecycle;
  proof.neighborAliveAfterPrimaryStop = true;
  proof.afterScreenshot = await screenshot('ui-original-native-process-after-stop.png');
  proof.signalEvidence =
    'One admitted UI stop command, one accepted original native request, one observed TEST service SIGTERM; no syscall tracing claim';
  proof.status = 'PASS';
  return hostPid;
}
