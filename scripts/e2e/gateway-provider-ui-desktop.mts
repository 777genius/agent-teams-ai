#!/usr/bin/env node
// Standalone: pnpm exec node scripts/e2e/gateway-provider-ui-desktop.mts --fixture /owned/fixture.json
// GATEWAY_E2E_UI_API_KEY must be a fresh group-bound test key reserved for this UI owner.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface RoleOptions {
  name?: string | RegExp;
  exact?: boolean;
}
export interface GatewayUiLocator {
  locator(selector: string): GatewayUiLocator;
  getByRole(role: string, options?: RoleOptions): GatewayUiLocator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): GatewayUiLocator;
  filter(options: { hasText: string | RegExp }): GatewayUiLocator;
  first(): GatewayUiLocator;
  count(): Promise<number>;
  getAttribute(name: string): Promise<string | null>;
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string): Promise<void>;
  waitFor(options?: { state?: 'visible' | 'hidden'; timeout?: number }): Promise<void>;
}
export interface GatewayUiPage {
  locator(selector: string): GatewayUiLocator;
  getByRole(role: string, options?: RoleOptions): GatewayUiLocator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): GatewayUiLocator;
  url(): string;
  evaluate<T>(expression: string): Promise<T>;
  screenshot(options: { path: string; fullPage?: boolean; scale?: 'css' }): Promise<Buffer>;
  keyboard: { press(key: string): Promise<void> };
}
export interface GatewayUiFixture {
  root: string;
  dirs: { sandbox: string; evidence: string };
  port: number;
  endpoints: string[];
}
export interface GatewayUiOptions {
  providerId?: 'codex' | 'opencode';
  apiKey: string;
  model?: string;
  teamName?: string;
  memberName?: string;
}
interface Profile {
  id: string;
  displayName: string;
  baseUrl: string;
}
interface Binding {
  teamName: string;
  memberName: string;
  profileId: string;
}
interface InputBrowser {
  contexts(): { pages(): GatewayUiPage[] }[];
  close(): Promise<void>;
}

async function assertFixture(fixture: GatewayUiFixture): Promise<void> {
  assert(
    Number.isInteger(fixture.port) && fixture.port > 0 && fixture.port < 65536,
    'Invalid fixture CDP port'
  );
  const root = await realpath(fixture.root);
  const sandbox = await realpath(fixture.dirs.sandbox);
  const evidence = await realpath(fixture.dirs.evidence);
  assert(
    sandbox.startsWith(root + path.sep) && evidence.startsWith(root + path.sep),
    'Fixture paths must belong to its root'
  );
  assert.equal(
    await readFile(path.join(sandbox, '.gateway-e2e-test-only'), 'utf8'),
    root,
    'Sandbox ownership marker mismatch'
  );
  assert(fixture.endpoints.length > 0, 'No fixture gateway endpoint');
  for (const endpoint of fixture.endpoints) {
    const url = new URL(endpoint);
    assert(
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
      'UI E2E gateway must be loopback'
    );
    assert(url.protocol === 'http:' || url.protocol === 'https:');
    assert(!url.username && !url.password && !url.search && !url.hash, 'Invalid fixture endpoint');
  }
}

/** Actual user input signoff; API calls are used only for fixture readback. Never launches a team. */
export async function verifyGatewayUi(
  page: GatewayUiPage,
  fixture: GatewayUiFixture,
  options: GatewayUiOptions
): Promise<void> {
  await assertFixture(fixture);
  assert(options.apiKey, 'A fresh group-bound test key is required');
  const teamName = options.teamName ?? `gateway-ui-${Date.now().toString(36)}`;
  const memberName = options.memberName ?? 'ui-member';
  const model = options.model ?? 'claude-sonnet-4-5-20250929';
  assert(
    /^[a-z][a-z0-9-]+$/.test(teamName) && /^[a-z][a-z0-9-]+$/.test(memberName),
    'Use simple test owner names'
  );
  const profileName = `UI gateway ${Date.now().toString(36)}`;
  const editedName = `${profileName} edited`;
  const baseUrl = fixture.endpoints[0];
  await mkdir(fixture.dirs.evidence, { recursive: true });
  const capture = async (name: string): Promise<void> => {
    await page.screenshot({
      path: path.join(
        fixture.dirs.evidence,
        `gateway-ui-${options.providerId ? options.providerId + '-' : ''}${name}.png`
      ),
      fullPage: true,
    });
  };
  const profiles = (): Promise<Profile[]> =>
    page.evaluate('window.electronAPI.gatewayProvider.listGatewayProfiles()');
  const bindings = (): Promise<Binding[]> =>
    page.evaluate(
      `window.electronAPI.gatewayProvider.listGatewayBindings(${JSON.stringify(teamName)})`
    );
  const readback = async (label: string, read: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await read()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`UI readback failed: ${label}`);
  };
  const settings = async (): Promise<void> => {
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /^Gateway providers/ }).click();
    await page.getByRole('button', { name: 'Add profile', exact: true }).waitFor();
  };
  const row = (): GatewayUiLocator => page.locator('div.border-b').filter({ hasText: editedName });
  const cancelDialog = async (): Promise<void> => {
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  };
  const memberDraft = async (): Promise<GatewayUiLocator> => {
    // Allowed dev fixture staging: switch to the sandbox Teams view, then use real controls.
    await page.evaluate(
      `window.__agentTeamsDevStore.getState().openTeamsTab(${JSON.stringify(fixture.dirs.sandbox)})`
    );
    // The Teams header precedes the equivalent empty-state action.
    await page.getByRole('button', { name: 'Create Team', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#team-name').fill(teamName);
    const lead = dialog.locator('[data-role="lead-row"]');
    const unresolvedProvider = lead.getByRole('combobox', {
      name: 'Choose team provider',
      exact: true,
    });
    if (await unresolvedProvider.count()) {
      await unresolvedProvider.click();
      await page.getByRole('option', { name: 'Claude', exact: true }).click();
    }
    const sync = dialog.locator('#sync-models-with-lead');
    if ((await sync.getAttribute('aria-checked')) === 'true') await sync.click();
    if ((await dialog.locator('[data-role="member-row"]').count()) === 0) {
      await dialog.getByRole('button', { name: 'Add member', exact: true }).click();
    }
    const member = dialog.locator('[data-role="member-row"]').first();
    await member.getByRole('textbox', { name: 'Member 1 name', exact: true }).fill(memberName);
    await member.getByRole('button', { name: /provider,/i }).click();
    await member.locator(`#member-${memberName}-gateway-profile`).waitFor();
    return member;
  };

  await settings();
  await page.getByRole('button', { name: 'Add profile', exact: true }).click();
  await page.locator('#gateway-profile-name').fill(profileName);
  await page.locator('#gateway-profile-url').fill(baseUrl);
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await readback('created profile', async () =>
    (await profiles()).some((profile) => profile.displayName === profileName)
  );
  await page
    .locator('div.border-b')
    .filter({ hasText: profileName })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await page.locator('#gateway-profile-name').fill(editedName);
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await readback('edited profile', async () =>
    (await profiles()).some((profile) => profile.displayName === editedName)
  );
  const profile = (await profiles()).find((item) => item.displayName === editedName);
  assert(profile);
  await capture('profile-created-edited');

  const member = await memberDraft();
  await member.locator(`#member-${memberName}-gateway-profile`).click();
  await page.getByRole('option', { name: editedName, exact: true }).click();
  await member.locator(`#member-${memberName}-gateway-key`).fill('gateway-e2e-invalid-key');
  await member.getByRole('button', { name: 'Check key and load models', exact: true }).click();
  await member.getByText('Key authorization was rejected.', { exact: true }).waitFor();
  await capture('invalid-key');
  await member.locator(`#member-${memberName}-gateway-key`).fill(options.apiKey);
  await member.getByRole('button', { name: 'Check key and load models', exact: true }).click();
  await member.locator(`#member-${memberName}-gateway-model`).click();
  await page.getByRole('option', { name: model, exact: true }).click();
  await member.getByRole('button', { name: 'Bind teammate', exact: true }).click();
  await member.getByText(`Bound to ${editedName} · key stored`, { exact: true }).waitFor();
  await readback('UI binding', async () =>
    (await bindings()).some(
      (binding) => binding.memberName === memberName && binding.profileId === profile.id
    )
  );
  if (options.providerId) {
    await member
      .locator(`[data-testid="team-model-selector-provider-nav-${options.providerId}"]`)
      .click();
    // Runtime status can settle after the tab opens in inspection mode.
    const providerLabel = options.providerId === 'opencode' ? 'OpenCode' : 'Codex';
    await readback('confirmed ' + providerLabel + ' selection', async () => {
      const useProvider = member.getByRole('button', { name: 'Use ' + providerLabel, exact: true });
      if (await useProvider.count()) await useProvider.click();
      return (
        (await member
          .getByRole('button', { name: new RegExp(providerLabel + ' provider,', 'i') })
          .count()) > 0
      );
    });
  }
  await capture('member-bound');
  await cancelDialog();

  await settings();
  await row().getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#gateway-profile-url').fill(`${baseUrl}/different-endpoint`);
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').waitFor();
  await page
    .getByText(
      'This profile still has teammates bound to it. Unbind them first, or create another profile for the new URL.',
      { exact: true }
    )
    .waitFor();
  assert.equal((await profiles()).find((item) => item.id === profile.id)?.baseUrl, baseUrl);
  await capture('bound-url-denied');
  await cancelDialog();

  const boundMember = await memberDraft();
  await boundMember.getByRole('button', { name: 'Unbind', exact: true }).click();
  await readback(
    'UI unbind',
    async () => !(await bindings()).some((binding) => binding.memberName === memberName)
  );
  await capture('member-unbound');
  await cancelDialog();
  await settings();
  await row().getByRole('button', { name: 'Delete', exact: true }).click();
  await readback(
    'UI delete',
    async () => !(await profiles()).some((item) => item.id === profile.id)
  );
  await capture('profile-deleted');
  console.log(
    'Gateway UI PASS: profile CRUD, bound URL guard, invalid-key error, model selection, bind/unbind'
  );
}

async function main(): Promise<void> {
  const index = process.argv.indexOf('--fixture');
  assert(
    index >= 0 && process.argv[index + 1],
    'Pass --fixture /owned/fixture.json; arbitrary app connections are forbidden'
  );
  const fixture = JSON.parse(await readFile(process.argv[index + 1], 'utf8')) as GatewayUiFixture;
  await assertFixture(fixture);
  const apiKey = process.env.GATEWAY_E2E_UI_API_KEY;
  assert(apiKey, 'Set GATEWAY_E2E_UI_API_KEY to a fresh fixture-only key');
  const require = createRequire(import.meta.url);
  let playwright: { chromium: { connectOverCDP(url: string): Promise<InputBrowser> } };
  try {
    playwright = require('playwright') as typeof playwright;
  } catch {
    playwright = require(
      path.join(
        os.homedir(),
        '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
      )
    ) as typeof playwright;
  }
  const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${fixture.port}`);
  try {
    let page: GatewayUiPage | undefined;
    for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
      if (
        await candidate.evaluate<boolean>(
          'Boolean(window.electronAPI?.gatewayProvider && window.__agentTeamsDevStore)'
        )
      ) {
        page = candidate;
        break;
      }
    }
    assert(page, 'Fixture CDP has no gateway Electron renderer');
    await verifyGatewayUi(page, fixture, { apiKey });
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
