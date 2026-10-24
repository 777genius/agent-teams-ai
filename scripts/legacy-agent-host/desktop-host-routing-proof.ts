import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import { desktopJsLiteral } from './desktop-ui-controls.ts';

/** Explicit API boundary probe, separate from ordinary control signoff. */
export async function runDesktopHostRoutingProof(
  cdp: UiCdpPort,
  fixture: { handleId: string; root: string },
  evidence: Record<string, unknown>
): Promise<void> {
  // Main/preload readiness precedes the cold renderer module graph. Wait for the
  // actual UI before awaiting its API module, without repeating any API probe.
  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const startedAt = Date.now(),
    deadline = startedAt + 120_000;
  let uiReady = false;
  while (Date.now() < deadline) {
    uiReady = (await cdp.evaluate('window.__claudeTeamsUiDidInit===true')) === true;
    if (uiReady) break;
    await new Promise<void>((done) => setTimeout(done, 100));
  }
  evidence.routingRendererReadiness = {
    uiReady,
    elapsedMs: Date.now() - startedAt,
    budgetMs: 120_000,
  };
  assert.equal(uiReady, true, 'actual renderer initialized before the one negative routing probe');
  const teamName = 'host-team:' + encodeURIComponent(fixture.handleId);
  const request = {
    teamName,
    cwd: join(fixture.root, 'workspace'),
    members: [{ name: 'alice' }],
  };
  // Electron Vite serves src/renderer as its root (index.html imports ./main.tsx).
  // The frozen preload namespace does not contain the renderer owner decorator.
  const probes = await cdp.evaluate(`(async () => {
    const {api} = await import('/api/index.ts');
    const request = ${desktopJsLiteral(request)};
    const probes = [
      ['launchTeam', request],
      ['createTeam', request],
      ['createConfig', request],
      ['updateMemberSettings', {teamName: request.teamName, memberName: 'alice',
        commandId: 'TEST-not-dispatched', idempotencyKey: 'TEST-not-dispatched',
        expectedFingerprint: 'TEST-not-dispatched', targetKind: 'member', settings: {}}],
      ['showMessageNotification', {teamName: request.teamName, teamDisplayName: 'TEST',
        from: 'alice', body: 'TEST route probe', nativeSessionId: 'TEST-forbidden-selector'}],
      ['showMessageNotification', {teamDisplayName: 'TEST', from: 'alice',
        body: 'TEST route probe', target: {kind: 'task', teamName: request.teamName, taskId: ''}}],
    ];
    const outcomes = [];
    for (const [method, argument] of probes) {
      try {
        await api.teams[method](argument);
        outcomes.push({method, outcome: 'unexpected-success'});
      } catch (error) {
        outcomes.push({method, outcome: error instanceof Error ? error.message : String(error)});
      }
    }
    return outcomes;
  })()`);
  assert.ok(Array.isArray(probes));
  assert.equal(probes.length, 6);
  evidence.hostRequestRouting = { status: 'INCOMPLETE', probes };
  for (const probe of probes)
    assert.equal(
      (probe as Record<string, unknown>).outcome,
      (probe as Record<string, unknown>).method === 'launchTeam'
        ? 'Host team operation launch-source-required (not-dispatched)'
        : (probe as Record<string, unknown>).method === 'showMessageNotification'
          ? 'Invalid captured Host notification'
          : 'This operation is not supported for Host teams',
      'exact renderer routing refusal, not an arbitrary legacy validation or transport failure'
    );
  evidence.hostRequestRouting = {
    status: 'PASS',
    scope:
      'Actual renderer unified API rejects unsupported Host destinations, source-less Launch and malformed notification selectors before mutation dispatch. This negative API probe does not qualify ordinary Launch/config/member/notification functionality.',
    probes,
  };
}
