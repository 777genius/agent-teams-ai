import { desktopReadbackArtifactName } from './desktop-readback-fixture.ts';
import { nativeProcessReadbackAction, verifyNativeProcessReadbackSource, readNativeProcessReadbackSnapshot } from './desktop-native-process-readback.ts';
import { groupMembers, command } from './desktop-backend-observations.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
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
  const path = join(root, 'hoststore/teams/test-desktop-backend/.host-owner/commands');
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
    processReadbackMode?: boolean;
    processReadbackSource?: Awaited<ReturnType<typeof verifyNativeProcessReadbackSource>>;
  }
) {
  assert.equal(process.env.LEGACY_M19_PROVIDER_UI_GO, '1');
  const { fixture } = options;
  if (!options.processReadbackMode) assertProcessFixture(fixture);
  assert.ok(fixture.uiSeed);
  const continuationAction = options.processReadbackMode ? nativeProcessReadbackAction() : undefined;
  const source = options.processReadbackSource;
  assert.equal(Boolean(source), Boolean(options.processReadbackMode), 'original pre-app snapshot supplied only for cold readback');
  const before = row(
    JSON.parse(await readFile(join(fixture.root, 'native-process-before-crash.json'), 'utf8'))
  );
  const original = row(before.original),
    processRef = String(original.processRef),
    id = String(original.id);
  const selection = hostTeamSelectionKey(fixture.handleId);
  const services = await readProcessServices(fixture.root);
  assert.deepEqual(await stopReceipts(fixture.root), []);
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    steps,
    original,
    selection,
    scope:
      'Actual native member MCP registration → original Host controlled crash → existing Electron ProcessesSection original-ref reconciliation; Stop only if exact original remains same-live',
    excluded: [
      'whole process tree stop',
      'provider native-root cleanup qualification',
      'teammate readiness from process state',
      'PID/group signal fallback',
      'automatic uncertain stop retry',
    ],
  };
  if (source) {
    proof.originalContinuationSource = source;
    proof.scope = continuationAction === 'observe'
      ? 'Separate cold original-row read-only scope; original pre-app SDK-root failure remains INCOMPLETE/HOLD; zero Stop/input/launch/restart'
      : 'Separate cold original-row scope with at most one existing original-ref Stop; SDK-root custody remains HOLD';
  }
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
          const p=f?.memoizedProps;if(!p||p.teamName!==${desktopJsLiteral(selection)}||!Array.isArray(p.processes))continue;
          const rows=p.processes.filter(r=>r.id===${desktopJsLiteral(id)}&&r.processRef===${desktopJsLiteral(processRef)});
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
  assert.ok(['same-live', 'absent'].includes(String(processRow.observation)),
    'unknown/stale remains INCOMPLETE; never recapture or signal');
  assert.equal(processRow.canTerminate, processRow.observation === 'same-live');
  assert.equal(processRow.pendingStop, undefined);
  proof.coldOwnerProps = owner;
  // Actual unified renderer read, never a monkeypatch or alternate mutation path.
  const data = row(
    await cdp.evaluate(
      `(async()=>{const {api}=await import('/src/renderer/api/index.ts');return await api.teams.getData(${desktopJsLiteral(selection)});})()`
    )
  );
  const inventory = (data.processes as unknown[]).map(row);
  assert.equal(inventory.filter((p) => p.processRef === processRef).length, 1);
  const originalRead = inventory.find((p) => p.processRef === processRef)!;
  assert.equal(originalRead.observation, processRow.observation);
  assert.equal(originalRead.canTerminate, processRow.canTerminate);
  proof.coldOwnerRead = data;
  const screenshot = async (name: string) => {
    const value = row(
      await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
      })
    );
    const path = join(fixture.root, options.processReadbackMode ? desktopReadbackArtifactName(name) : name);
    await writeFile(path, Buffer.from(String(value.data), 'base64'), {
      mode: 0o600,
      flag: 'wx',
    });
    return { path, sha256: await fileDigest(path) };
  };
  await ui.scrollTo(
    '[data-section-id="processes"] span.font-medium',
    'visible original registered process label',
    PROCESS_LABEL
  );
  const originalRenderedRow = row(await ui.waitRead(`(() => {
    const labels=[...document.querySelectorAll('[data-section-id="processes"] span.font-medium')]
      .filter(node=>node.textContent.trim()===${desktopJsLiteral(PROCESS_LABEL)});
    if(labels.length!==1)return null;
    const label=labels[0],container=label.parentElement;
    const pids=[...container.querySelectorAll('span.font-mono')]
      .filter(node=>node.textContent.trim()===${desktopJsLiteral('PID' + services.primary.pid)});
    if(pids.length!==1)return null;
    const visible=node=>{
      const r=node.getBoundingClientRect(),style=getComputedStyle(node);
      const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
      return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth&&
        style.display!=='none'&&style.visibility==='visible'&&hit&&(node===hit||node.contains(hit));
    };
    if(!visible(label)||!visible(pids[0]))return null;
    const r=container.getBoundingClientRect();
    return {label:label.textContent.trim(),pidText:pids[0].textContent.trim(),
      geometry:{x:r.x,y:r.y,width:r.width,height:r.height},
      killCount:[...container.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Kill').length};
  })()`, 'rendered original process label/PID with visible geometry'));
  proof.originalRenderedRow = originalRenderedRow;
  proof.beforeScreenshot = await screenshot('ui-original-native-process-before-stop.png');
  if (source) {
    // Existing public read validates detachment; persisted phase/custody are not rewritten by this proof.
    const runtimeResult = row(await cdp.evaluate(`window.electronAPI.agentBackend.invoke(${desktopJsLiteral({
      handle: { handleId: fixture.handleId }, commandId: randomUUID(), operation: 'runtime.read',
      payload: { memberId: 'alice-id', expectedGeneration: '1' },
    })})`));
    assert.equal(runtimeResult.ok, true, JSON.stringify(runtimeResult));
    const runtime = row(runtimeResult.value);
    assert.equal(runtime.memberId, 'alice-id'); assert.equal(runtime.generation, '1');
    assert.equal(runtime.attached, false); assert.equal(runtime.nativeReady, false);
    assert.equal(runtime.attachmentCapabilities, undefined);
    proof.coldRuntimeRead = runtime;
    assert.equal(await fileDigest(String(row(before.registry).path)), row(before.registry).sha256, 'read-only UI retains original registration bytes');
    assert.deepEqual(await readNativeProcessReadbackSnapshot(fixture.root), source.snapshot,
      'read-only phase creates no new Runtime input, session, command or Stop');
    const childRows = groupMembers(options.group).filter(p => p.ppid === hostPid);
    assert.deepEqual(childRows, [], 'cold Host has no allocated native provider child');
    proof.nativeRuntimeAllocation = { observedHostChildren: childRows, inputReplay: false };
    if (continuationAction === 'observe') {
      assert.deepEqual(await stopReceipts(fixture.root), []);
      assert.equal(originalRenderedRow.killCount, processRow.observation === 'same-live' ? 1 : 0);
      proof.qualificationScope = 'cold-original-row-read-only-hold';
      proof.coldReconciliation = 'ORIGINAL_CAPTURE_OBSERVED_WITHOUT_STOP';
      proof.stopQualification = 'NOT_ATTEMPTED_READ_ONLY_SCOPE';
      proof.nativeCleanupClaim = false; proof.runtimeCustody = 'HOLD'; proof.status = 'PASS';
      return hostPid;
    }
  }
  if (processRow.observation === 'absent') {
    assert.equal(originalRenderedRow.killCount, 0, 'absent original row has no native Stop action');
    assert.deepEqual(await stopReceipts(fixture.root), []);
    proof.qualificationScope = 'cold-original-row-read-only';
    proof.coldReconciliation = 'ORIGINAL_CAPTURE_ABSENT_NO_STOP';
    proof.stopQualification = 'NOT_ATTEMPTED_ORIGINAL_ALREADY_ABSENT';
    proof.nativeCleanupClaim = false;
    proof.runtimeCustody = 'HOLD';
    proof.status = 'PASS'; // Scoped cold read only; live Kill is a separate retained proof.
    return hostPid;
  }
  await probeProcessService(services.primary);
  const neighborBeforeStop = await readFile(
    join(fixture.root, 'workspace/process-neighbor-lifecycle.ndjson'), 'utf8'
  );
  await ui.scrollTo('[data-section-id="processes"] button', 'actual original Stop button', 'Kill');
  const stopPoint = await ui.waitRead(
    `(() => {
    const buttons=[...document.querySelectorAll('[data-section-id="processes"] button')].filter(b=>b.textContent.trim()==='Kill');
    if(buttons.length!==1)return null;const b=buttons[0],container=b.parentElement?.parentElement;
    return container?.textContent.includes(${desktopJsLiteral(PROCESS_LABEL)})&&container.textContent.includes(${desktopJsLiteral(String(services.primary.pid))})?true:null;
  })()`,
    'one original displayed primary Stop action'
  );
  assert.equal(stopPoint, true);
  await writeFile(
    join(fixture.root, options.processReadbackMode ? desktopReadbackArtifactName('ui-original-process-stop-attempted.json') : 'ui-original-process-stop-attempted.json'),
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
      await cdp.evaluate(`window.electronAPI.agentBackend.invoke(${desktopJsLiteral(request)})`)
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
  assert.equal(
    neighborLifecycle.split('\n').filter(line => line.includes('SIGTERM')).length,
    neighborBeforeStop.split('\n').filter(line => line.includes('SIGTERM')).length,
    'primary Stop adds no neighbor SIGTERM; prior EOF/TTL is recorded independently'
  );
  proof.terminalStop = terminal;
  proof.ownerHistory = history;
  proof.primaryLifecycle = lifecycle;
  proof.neighborLifecycleBeforeStop = neighborBeforeStop;
  proof.neighborLifecycleAfterStop = neighborLifecycle;
  proof.qualificationScope = 'cold-original-row-and-one-stop';
  proof.stopQualification = 'COMPLETED_ORIGINAL_REF_STOP';
  proof.coldReconciliation = 'ORIGINAL_CAPTURE_SAME_LIVE_STOP_COMPLETED';
  proof.nativeCleanupClaim = false;
  proof.runtimeCustody = 'HOLD';
  proof.afterScreenshot = await screenshot('ui-original-native-process-after-stop.png');
  proof.signalEvidence =
    'One admitted UI stop command, one accepted original native request, one observed TEST service SIGTERM; no syscall tracing claim';
  proof.status = 'PASS';
  return hostPid;
}
