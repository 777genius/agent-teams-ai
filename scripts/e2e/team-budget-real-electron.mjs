// Real Electron budget UI + IPC acceptance inside one disposable owned app profile.
// Spending data is seeded synthetically; no provider credentials or inference.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkBudgetDesktop({ cdp, first, artifactRoot, until, evidence }) {
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
  await until(() => cdp.evaluate(`(() => {
    const section = ${panel};
    const trigger = section?.querySelector('button[role="combobox"]');
    if (!trigger || trigger.disabled) return false;
    trigger.click();
    return true;
  })()`), 'real budget scope picker is ready', 60_000);
  await until(() => cdp.evaluate(`(() => {
    const option = Array.from(document.querySelectorAll('[role="option"]'))
      .find(element => element.textContent?.includes(${JSON.stringify(first)}));
    if (!option) return false;
    option.click();
    return true;
  })()`), 'select original team budget scope', 30_000);
  await until(() => cdp.evaluate(`(() => {
    const section = ${panel};
    return section?.querySelector('button[role="combobox"]')?.textContent
      ?.includes(${JSON.stringify(first)}) || false;
  })()`), 'selected budget scope retained by real renderer');
  const opened = await cdp.evaluate(`(() => {
    const section = ${panel};
    const edit = section?.querySelector('button.w-full:not([role="combobox"])');
    if (!edit || edit.disabled) return false;
    edit.click();
    return true;
  })()`);
  assert(opened, 'Real budget editor button unavailable');
  await cdp.waitFor(
    'document.querySelector(\'[role="dialog"] input[inputmode="decimal"]\')',
    'real budget editor input'
  );
  const changed = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const input = dialog?.querySelector('input[inputmode="decimal"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, '100');
    input.dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  })()`);
  assert(changed, 'Cannot enter token limit through real budget editor');
  const policyOpened = await cdp.evaluate(`(() => {
    const triggers = Array.from(document.querySelectorAll('[role="dialog"] button[role="combobox"]'));
    if (triggers.length < 2) return false;
    triggers[1].click();
    return true;
  })()`);
  assert(policyOpened, 'Team enforcement selector is missing');
  await until(() => cdp.evaluate(`(() => {
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    if (options.length !== 3) return false;
    options[1].click();
    return true;
  })()`), 'choose block_launch in actual budget editor');
  const savedClick = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const buttons = Array.from(dialog?.querySelectorAll('button') ?? []);
    const save = buttons.at(-1);
    if (!save || save.disabled) return false;
    save.click();
    return true;
  })()`);
  assert(savedClick, 'Budget save button unavailable in real editor');
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
