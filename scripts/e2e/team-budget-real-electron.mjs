// Real Electron budget UI + IPC acceptance inside one disposable owned app profile.
// Spending data is seeded synthetically; no provider credentials or inference.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkBudgetDesktop({ cdp, first, artifactRoot, until, evidence }) {
  // A synthetic .click() does not exercise Radix Select's real pointer path.
  // Reuse the same CDP mouse events / hit-test guard as Attention's working E2E.
  const clickAt = async (expression, label) => {
    const pointExpression = `(() => {
      const element = ${expression};
      if (!element || element.matches(':disabled') || !element.getClientRects().length) return null;
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      return hit && element.contains(hit) ? { x, y } : null;
    })()`;
    await until(() => cdp.evaluate(pointExpression), label + ' actionable', 30_000);
    const point = await cdp.evaluate(pointExpression);
    assert(point, label + ' pointer point unavailable');
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
  };
  // This is the actual product renderer and IPC in the same owned Electron
  // profile as Attention, not a mocked React or HTTP/unit fixture.
  await cdp.evaluate('window.__agentTeamsDevStore.getState().openTeamsTab()');
  await until(() => cdp.evaluate(
    `window.__agentTeamsDevStore.getState().teams.some(t => t.teamName === ${JSON.stringify(first)})`
  ), 'owned team available to real budget editor', 60_000);
  await cdp.evaluate(
    'window.__agentTeamsDevStore.getState().openTab({type:"token-usage",label:"Usage"})'
  );
  const panel = `Array.from(document.querySelectorAll(
    '.token-usage-dashboard section.usage-detail-panel'
  )).find(section => section.querySelector('button[role="combobox"]') &&
    section.querySelector('button.w-full:not([role="combobox"])'))`;
  await clickAt(`${panel}?.querySelector('button[role="combobox"]')`,
    'real budget scope picker');
  await clickAt(
    `Array.from(document.querySelectorAll('[role="option"]'))
      .find(element => element.textContent?.includes(${JSON.stringify(first)}))`,
    'select original team budget scope'
  );
  await until(() => cdp.evaluate(`(() => {
    const section = ${panel};
    return section?.querySelector('button[role="combobox"]')?.textContent
      ?.includes(${JSON.stringify(first)}) || false;
  })()`), 'selected budget scope retained by real renderer');
  await clickAt(`${panel}?.querySelector('button.w-full:not([role="combobox"])')`,
    'open real budget editor');
  await cdp.waitFor(
    'document.querySelector(\'[role="dialog"] input[inputmode="decimal"]\')',
    'real budget editor input'
  );
  await clickAt(`document.querySelector('[role="dialog"] input[inputmode="decimal"]')`,
    'focus real budget token limit input');
  await cdp.send('Input.insertText', { text: '100' });
  await until(() => cdp.evaluate(
    `document.querySelector('[role="dialog"] input[inputmode="decimal"]')?.value === "100"`
  ), 'real budget token limit entered');
  await clickAt(
    `Array.from(document.querySelectorAll('[role="dialog"] button[role="combobox"]'))[1]`,
    'open real team enforcement selector'
  );
  await until(() => cdp.evaluate(
    `document.querySelectorAll('[role="option"]').length === 3`
  ), 'all three real enforcement choices available');
  await clickAt(
    `Array.from(document.querySelectorAll('[role="option"]'))[1]`,
    'choose block_launch in real budget editor'
  );
  await clickAt(
    `Array.from(document.querySelectorAll('[role="dialog"] button')).at(-1)`,
    'save real budget editor'
  );
  await until(async () => {
    const value = await cdp.evaluate('window.electronAPI.tokenUsage.getBudgetSettings()');
    const team = value?.teams?.['team:' + first];
    return team?.monthlyTokenLimit === 100 && team?.onExceeded === 'block_launch'
      ? value : false;
  }, 'durable team budget through real IPC', 45_000);
  // This harness's until() resolves void on success, not the predicate value.
  const settings = await cdp.evaluate('window.electronAPI.tokenUsage.getBudgetSettings()');
  assert(settings.updatedAt, 'Saved budget CAS revision unavailable');
  await until(async () => {
    const status = await cdp.evaluate('window.electronAPI.tokenUsage.getBudgetStatus()');
    return status.targets?.some(target => target.scope === 'team' &&
      target.id === 'team:' + first && target.onExceeded === 'block_launch' &&
      target.metrics.some(metric => metric.metric === 'tokens' && metric.limit === 100));
  }, 'persisted budget appears in real IPC status projection', 30_000);
  await cdp.screenshot(path.join(artifactRoot, 'budget-editor-saved.png'));
  evidence.checks.push('real Electron budget editor/Save -> durable IPC settings + status');

  await cdp.evaluate('window.__agentTeamsDevStore.getState().openTeamsTab()');
  await until(() => cdp.evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.team-row-zebra-card'))
      .find(node => node.querySelector('h3')?.textContent === ${JSON.stringify(first)});
    const label = card?.querySelector('[aria-label*="/ 100"]');
    return Boolean(label);
  })()`), 'team card reflects real budget status', 60_000);
  await cdp.screenshot(path.join(artifactRoot, 'team-budget-card.png'));
  evidence.checks.push('real team list budget card reflects configured team limit');

  const current = await cdp.evaluate('window.electronAPI.tokenUsage.getBudgetStatus()');
  const team = current.targets.find(target => target.scope === 'team' &&
    target.id === 'team:' + first);
  const actualTokens = team?.metrics.find(metric => metric.metric === 'tokens')?.value;
  assert.equal(actualTokens, 150,
    'Real IPC budget projection did not attribute the isolated ledger to this team');
  const launch = await cdp.evaluate(`(async () => {
    try {
      const result = await window.electronAPI.teams.launchTeam({
        teamName:${JSON.stringify(first)},
        cwd:${JSON.stringify(path.join(artifactRoot, 'project'))},
        providerId:'anthropic',
        model:'claude-sonnet-4-6',
        prompt:'Disposable E2E; never run real inference.'
      });
      return { result };
    } catch (error) {
      return { error: String(error) };
    }
  })()`);
  assert.match(JSON.stringify(launch), /TEAM_BUDGET_BLOCKED/,
    'Product launch bypassed uncertain team-budget policy');
  evidence.checks.push('real product launch IPC blocks exceeded team tokens before native spawn');
}
