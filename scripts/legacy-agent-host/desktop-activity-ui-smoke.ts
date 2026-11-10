import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import {
  assertCapturedActivityUnchanged,
  readCapturedActivitySessions,
} from './desktop-activity-readback-fixture.ts';
import type { CapturedActivitySource } from './desktop-activity-readback-fixture.ts';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type {
  ActivityLog as HostMemberActivityLog,
  summarizeTeamActivity,
} from '../../packages/legacy-agent-host/dist/composition/readTeamActivity.js';
type HostMemberActivityStats = ReturnType<typeof summarizeTeamActivity>;
import type { RuntimeActivityRecord } from '../../packages/legacy-agent-host/dist/runtime/activityContracts.js';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Existing original controls read one exact retained native proof; never seeds or resumes a session. */
export async function runDesktopActivityUiSmoke(
  cdp: UiCdpPort,
  options: {
    root: string;
    source: CapturedActivitySource;
    teamName: string;
    memberName: string;
    memberId: string;
    handleId: string;
    evidence: Row;
    assertNoNativeChildren(phase: 'before-first-team-read' | 'after-team-read'): void;
    assertOwnedRenderer(): void;
  }
): Promise<void> {
  assert.match(options.root, /\/TEST-[^/]+/);
  assert.equal(options.source.status, 'SCOPED_PASS');
  options.assertNoNativeChildren('before-first-team-read');
  await assertCapturedActivityUnchanged(options.source);
  const steps: Row[] = [];
  const proof: Row = {
    status: 'INCOMPLETE',
    steps,
    scope:
      'Original MemberDetailDialog Logs/Stats and renderer reload from actual retained Host/native child input',
    childQualification:
      'Original scoped native child proof; this run qualifies ordinary UI readback only',
    taskActivity: 'OPEN: separate Task Activity/detail/logstream API mapping required',
    nativeReplay: false,
    sourceSha256: sha(await readFile(import.meta.filename)),
  };
  options.evidence.memberActivityUiProof = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (row) => steps.push({ ...row, observedAt: new Date().toISOString() }),
  });
  const beforeSessions = await readCapturedActivitySessions(options.source);
  const candidates = beforeSessions.filter(
    (row) =>
      record(row.binding).memberId === options.memberId &&
      Array.isArray(row.inputs) &&
      row.inputs.length > 0 &&
      record(row.binding).teamId === options.source.teamId
  );
  assert.equal(candidates.length, 1, 'one actually used captured generation');
  const runtime = candidates[0]!;
  assert.equal(runtime.phase, 'closed');
  assert.equal(runtime.custody, 'released');
  const inputs = (runtime.inputs as unknown[]).map(record);
  assert.ok(
    inputs.every((row) => row.phase === 'terminal' || row.phase === 'unknown'),
    'original stopped unknown input is retained; no claimed/queued input is resumed'
  );
  const sourceId = runtimeDigest(record(runtime.binding));
  const activityPath = join(options.source.storeRoot, 'runtime-events', sourceId + '.json');
  const activityBytes = await readFile(activityPath);
  assert.ok(activityBytes.length <= 2 * 1024 * 1024);
  const activity = record(
    JSON.parse(activityBytes.toString('utf8'))
  ) as unknown as RuntimeActivityRecord;
  assert.deepEqual(activity.binding, runtime.binding);
  const { digest: activityDigest, ...activityBody } = activity;
  assert.equal(runtimeDigest(activityBody), activityDigest, 'original activity record digest');
  const originalEvents = new Map(activity.events.map((event) => [event.eventId, event]));
  assert.ok(originalEvents.size > 0);

  const readProjection = async () => {
    options.assertOwnedRenderer();
    const responses = record(
      await cdp.evaluate(`(async () => ({
      logs:await window.electronAPI.agentBackend.invoke(${desktopJsLiteral({ handle: { handleId: options.handleId }, commandId: 'TEST-activity-ui-read-logs', operation: 'team.activity.logs.read', payload: { memberName: options.memberName } })}),
      stats:await window.electronAPI.agentBackend.invoke(${desktopJsLiteral({ handle: { handleId: options.handleId }, commandId: 'TEST-activity-ui-read-stats', operation: 'team.activity.stats.read', payload: { memberName: options.memberName } })})
    }))()`)
    );
    options.assertNoNativeChildren('after-team-read');
    const logsResponse = record(responses.logs),
      statsResponse = record(responses.stats);
    assert.equal(logsResponse.ok, true);
    assert.equal(statsResponse.ok, true);
    const value = record(logsResponse.value);
    assert.equal(value.kind, 'team-activity-logs');
    assert.ok(Array.isArray(value.logs));
    const logs = value.logs.map(record) as unknown as HostMemberActivityLog[];
    const statsValue = record(statsResponse.value);
    assert.equal(statsValue.kind, 'team-activity-stats');
    const stats = record(statsValue.stats) as unknown as HostMemberActivityStats;
    assert.ok(logs.every((log) => log.kind === 'host_activity'));
    assert.equal(stats.kind, 'host_activity_stats');
    assert.equal(stats.scope, 'retained_runtime_activity');
    assert.equal(stats.memberName, options.memberName);
    const log = logs.find((row) => row.sessionId === `host-activity-${sourceId}`);
    assert.ok(log, 'application source ID derives exact original immutable binding');
    assert.equal(log.memberId, options.memberId);
    assert.equal(log.generation, record(runtime.binding).generation);
    assert.equal(log.startTime, null);
    assert.equal(log.durationMs, null);
    assert.ok(log.events.length > 0);
    for (const projected of log.events) {
      const raw = originalEvents.get(projected.eventId);
      assert.ok(raw, 'every displayed source event was retained in the actual native journal');
      assert.equal(projected.sequence, raw.sequence);
      assert.equal(projected.inputId, raw.inputId);
      for (const [key, item] of Object.entries(projected.data))
        assert.deepEqual(
          item,
          raw.data[key],
          'finite fields preserve original normalized native facts'
        );
      if (raw.inputId) {
        const input = inputs.find((row) => record(row.intent).inputId === raw.inputId);
        assert.ok(input);
        assert.equal(input.operationRef, raw.operationRef);
      }
    }
    const child = log.events.filter(
      (event) =>
        event.data.kind === 'subagent' && event.data.childId === options.source.provenance.childId
    );
    assert.ok(child.length > 0, 'original native child is projected');
    assert.deepEqual(
      child.map((event) => (event.data.kind === 'subagent' ? event.data.phase : null)),
      options.source.provenance.phases
    );
    for (const event of child) {
      assert.equal(event.inputId, options.source.provenance.inputId);
      assert.equal(
        event.data.kind === 'subagent' ? event.data.parentToolRef : undefined,
        options.source.provenance.parentToolRef
      );
      assert.equal(
        originalEvents.get(event.eventId)?.operationRef,
        options.source.provenance.operationRef
      );
    }
    assert.ok(log.events.some((event) => event.data.kind === 'tool'));
    assert.ok(
      log.events.some((event) => event.data.kind === 'tool-result' && event.data.isError),
      'actual failed Bash outcome remains visible'
    );
    assert.ok(log.events.some((event) => event.data.kind === 'text'));
    assert.ok(stats.observedMessages > 0);
    assert.ok(Object.values(stats.toolUsage).reduce((a, b) => a + b, 0) > 0);
    const latestUsage = new Map<string, Row>();
    for (const event of log.events)
      if (event.data.kind === 'usage' && event.inputId) latestUsage.set(event.inputId, event.data);
    for (const field of ['inputTokens', 'outputTokens'] as const) {
      const known =
        latestUsage.size > 0 &&
        [...latestUsage.values()].every((row) => typeof row[field] === 'number');
      const expected = known
        ? [...latestUsage.values()].reduce((sum, row) => sum + Number(row[field]), 0)
        : null;
      assert.equal(stats[field], expected, 'reported parent usage only; child totals are separate');
    }
    return { logs, stats, log };
  };
  const first = await readProjection();
  proof.source = {
    sourceId,
    activityPath,
    sha256: sha(activityBytes),
    activityDigest,
    binding: runtime.binding,
    inputIds: inputs.map((row) => record(row.intent).inputId),
    eventIds: first.log.events.map((event) => event.eventId),
  };
  proof.projectionBefore = first;

  const openMember = async () => {
    await ui.waitRead(
      `!document.querySelector('[role="dialog"]')`,
      'no prior dialog before member navigation'
    );
    const point = record(
      await ui.waitRead(
        `(() => {
      const rows=[...document.querySelectorAll('div[role="button"][tabindex="0"]')]
        .filter(row=>[...row.querySelectorAll('span')].some(span=>span.textContent.trim()===${desktopJsLiteral(options.memberName)}));
      if(rows.length!==1)return null;const e=rows[0],name=[...e.querySelectorAll('span')].find(span=>span.textContent.trim()===${desktopJsLiteral(options.memberName)});
      if(!name)return null;const r=name.getBoundingClientRect();
      const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
      return r.width>0&&r.height>0&&hit&&!hit.closest('button')&&(hit===e||e.contains(hit))?{x,y}:null;
    })()`,
        'one original member card'
      )
    );
    options.assertOwnedRenderer();
    steps.push({ action: 'original-member-card-click', point });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    await ui.waitRead(
      `(() => {
        const tabs=[...document.querySelectorAll('[role="dialog"] [role="tab"]')];
        const labelOf=node=>[...node.childNodes].filter(child=>child.nodeType===Node.TEXT_NODE).map(child=>child.textContent??'').join('').trim();
        return ['Logs','Stats','Activity'].every(label=>tabs.some(node=>labelOf(node)===label));
      })()`,
      'original MemberDetailDialog tabs'
    );
  };
  const screenshot = async (name: string) => {
    const image = record(
      await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
      })
    );
    const path = join(options.root, name);
    await writeFile(path, Buffer.from(String(image.data), 'base64'), {
      mode: 0o600,
      flag: 'wx',
    });
    return { path, sha256: sha(await readFile(path)) };
  };
  const visible = async (expected: typeof first, epoch: string) => {
    await openMember();
    await ui.click('[role="dialog"] [role="tab"]', 'original Member Logs', 'Logs');
    await ui.waitRead(
      `document.querySelector('[role="dialog"] [role="tabpanel"][data-state="active"]')?.textContent.includes('Captured runtime activity')`,
      'actual typed Host Logs branch'
    );
    const header = String(
      await ui.waitRead(
        `(() => {
      const rows=[...document.querySelectorAll('[role="dialog"] [role="tabpanel"] button[aria-expanded]')]
        .filter(e=>e.textContent.includes(${desktopJsLiteral(options.memberName + ' · Captured runtime activity')})&&e.textContent.includes(${desktopJsLiteral('generation ' + expected.log.generation)}));
      return rows.length===1?rows[0].textContent.trim():null;
    })()`,
        'exact original retained generation header'
      )
    );
    await ui.click(
      '[role="dialog"] [role="tabpanel"] button[aria-expanded]',
      'expand original retained activity log',
      header
    );
    const logText = String(
      await ui.waitRead(
        `(() => {const e=document.querySelector('[role="dialog"] [role="tabpanel"][data-state="active"]');return e?.innerText.includes('tool-result')&&e.innerText.includes('isError')?e.innerText:null})()`,
        'actual tool/result/text facts visible'
      )
    );
    assert.match(logText, /timestamps unavailable/);
    assert.match(logText, /"isError": true/);
    const childEvent = expected.log.events.find(
      (event) =>
        event.data.kind === 'subagent' &&
        event.data.childId === options.source.provenance.childId &&
        event.data.phase === 'completed'
    );
    assert.ok(childEvent);
    const childText = JSON.stringify(childEvent.data, null, 2);
    await ui.scrollTo(
      '[role="dialog"] [role="tabpanel"][data-state="active"] pre',
      'original completed child identity and counters',
      childText
    );
    await ui.waitRead(
      `document.querySelector('[role="dialog"] [role="tabpanel"][data-state="active"]')?.innerText.includes(${desktopJsLiteral(options.source.provenance.childId)})&&document.querySelector('[role="dialog"] [role="tabpanel"][data-state="active"]')?.innerText.includes(${desktopJsLiteral(options.source.provenance.parentToolRef)})`,
      'exact original child and parent tool refs are rendered'
    );
    proof[`logsScreenshot${epoch}`] = await screenshot(`ui-host-logs-${epoch}.png`);
    await ui.scrollTo('[role="dialog"] [role="tab"]', 'return to original Stats tab', 'Stats');
    await ui.click('[role="dialog"] [role="tab"]', 'original Member Stats', 'Stats');
    for (const [label, value] of [
      [
        'Reported input tokens',
        expected.stats.inputTokens === null
          ? 'Unknown'
          : expected.stats.inputTokens.toLocaleString(),
      ],
      [
        'Reported output tokens',
        expected.stats.outputTokens === null
          ? 'Unknown'
          : expected.stats.outputTokens.toLocaleString(),
      ],
      [
        'Reported cost (USD)',
        expected.stats.costUsd === null ? 'Unknown' : expected.stats.costUsd.toFixed(6),
      ],
      ['Observed messages', expected.stats.observedMessages.toLocaleString()],
    ])
      await ui.waitRead(
        `(() => {const e=document.querySelector('[role="dialog"] [role="tabpanel"][data-state="active"]');const label=[...e.querySelectorAll('div')].find(n=>n.textContent===${desktopJsLiteral(label)});return label?.parentElement?.firstElementChild?.textContent===${desktopJsLiteral(value)}})()`,
        `actual Stats ${label}`
      );
    await ui.waitRead(
      `document.querySelector('[role="dialog"] [role="tabpanel"][data-state="active"]')?.textContent.includes('Native timestamps, cache tokens, file/line totals and complete lifetime usage are unavailable.')`,
      'unknown capacity remains explicit'
    );
    proof[`statsScreenshot${epoch}`] = await screenshot(`ui-host-stats-${epoch}.png`);
    await ui.click('[role="dialog"] button', 'close original MemberDetailDialog', 'Close');
    await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'member dialog closes');
  };
  const openTeam = async () => {
    await ui.waitRead(
      `document.documentElement.lang==='en'&&Boolean(document.querySelector('button[aria-label="More actions"]'))`,
      'explicit English TEST shell and original application menu',
      90_000
    );
    await ui.click('button[aria-label="More actions"]', 'open original application menu');
    await ui.click('button', 'original Teams navigation', 'Teams');
    const selector = `.team-row-zebra-card[data-team-name=${JSON.stringify('host-team:' + options.handleId)}]`;
    await ui.scrollTo(selector, 'original retained Team card');
    await ui.click(selector, 'open retained native Team without seeding a Task');
  };
  await ui.observeInput();
  await openTeam();
  if (await cdp.evaluate(`Boolean(document.querySelector('[role="dialog"] #dialog-prompt'))`))
    await ui.click(
      '[role="dialog"] button',
      'close original launch settings without submit',
      'Close'
    );
  await visible(first, 'before-reload');
  const timeOrigin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(
    `performance.timeOrigin!==${desktopJsLiteral(timeOrigin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'new renderer document'
  );
  await ui.observeInput();
  await openTeam();
  const after = await readProjection();
  assert.deepEqual(after.logs, first.logs, 'reload preserves exact canonical source events');
  const { computedAt: beforeTime, ...beforeStats } = first.stats;
  const { computedAt: afterTime, ...afterStats } = after.stats;
  assert.deepEqual(afterStats, beforeStats, 'only stats observation time may change');
  proof.statsObservationTimes = { before: beforeTime, after: afterTime };
  await visible(after, 'after-reload');
  assert.deepEqual(
    await readCapturedActivitySessions(options.source),
    beforeSessions,
    'no native input/session change from read/reload'
  );
  assert.deepEqual(
    await readFile(activityPath),
    activityBytes,
    'UI reads never rewrite native activity'
  );
  options.assertNoNativeChildren('after-team-read');
  await assertCapturedActivityUnchanged(options.source);
  proof.projectionAfter = after;
  proof.childRows = first.log.events.filter((event) => event.data.kind === 'subagent');
  proof.childQualification =
    'Exact original native childId/parentToolRef/input/operation and phases shown in original Logs; no replay or new child';
  proof.noNewInputs = true;
  proof.status = 'UI_PASS_PENDING_HOST_CLOSE';
}

/** The outer captured-process harness calls this ONLY after ordinary Quit and original Host absence. */
export async function finalizeDesktopActivityReadback(
  evidence: Row,
  source: CapturedActivitySource,
  assertHostClosed: () => void
): Promise<void> {
  const proof = record(evidence.memberActivityUiProof);
  assert.equal(proof.status, 'UI_PASS_PENDING_HOST_CLOSE');
  assertHostClosed();
  await assertCapturedActivityUnchanged(source);
  proof.canonicalStateUnchangedAfterHostClose = true;
  proof.status = 'PASS';
}
