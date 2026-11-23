import assert from 'node:assert/strict';

type Environment = Readonly<Record<string, string | undefined>>;
const mode = 'emulated-import-lifecycle-ui';
const args = Object.freeze(['--', '--ozone-platform=headless', '--headless', '--disable-gpu',
  '--remote-debugging-address=127.0.0.1']);

/** One explicit finite Linux display choice; absence leaves ordinary Desktop startup unchanged. */
export function desktopFiniteHeadlessSelected(
  environment: Environment = process.env,
  platform: string = process.platform,
  architecture: string = process.arch
): boolean {
  const selected = environment.LEGACY_DESKTOP_TEST_HEADLESS;
  if (selected === undefined) return false;
  assert.equal(selected, '1', 'finite TEST headless requires its exact selector');
  assert.equal(platform, 'linux', 'finite TEST headless requires Linux');
  assert.equal(architecture, 'x64', 'finite TEST headless requires x64');
  assert.equal(environment.LEGACY_DESKTOP_BACKEND_GO, '1', 'finite TEST headless requires explicit launch admission');
  assert.equal(environment.LEGACY_DESKTOP_EMULATED_ONLY, '1', 'finite TEST headless requires provider emulation');
  assert.equal(environment.LEGACY_DESKTOP_PROOF_MODE, mode, 'finite TEST headless requires the original import lifecycle');
  assert.equal(environment.LEGACY_DESKTOP_TEST_DISPLAY, undefined, 'finite TEST headless refuses a mixed X display');
  assert.equal(environment.LEGACY_DESKTOP_TEST_XAUTHORITY, undefined, 'finite TEST headless refuses mixed X authorization');
  const allowed = /^LEGACY_DESKTOP_(?:BACKEND_GO|EMULATED_ONLY|PROOF_MODE|CDP_PORT|TEST_HEADLESS|TEST_CHILD_TRACE|TEST_FINITE_HEAP_(?:1536|1536_UV4)|COREPACK_HOME|NODE_SHA256|HOST_ENTRY_SHA256|PNPM_PATH|PNPM_SHA256|COREPACK_PACKAGE_SHA256|COREPACK_LIBRARY_SHA256)$/u;
  for (const key of Object.keys(environment))
    if (key.startsWith('LEGACY_DESKTOP_')) assert.ok(allowed.test(key), `finite TEST headless refuses ${key}`);
  if (environment.LEGACY_DESKTOP_TEST_CHILD_TRACE !== undefined)
    assert.equal(environment.LEGACY_DESKTOP_TEST_CHILD_TRACE, '1', 'finite TEST headless requires the original child trace');
  for (const key of ['LEGACY_PROCESS_COLD_UI_GO', 'LEGACY_M19_PROVIDER_UI_GO', 'LEGACY_M19_ORIGINAL_HOST_CRASH_GO',
    'AGENT_TEAMS_HOST_CANDIDATE', 'AGENT_TEAMS_ORG_DEMO'])
    assert.equal(environment[key], undefined, `finite TEST headless refuses ${key}`);
  return true;
}

/** The original dev wrapper appends these only after normalizing its original inspector port. */
export function desktopFiniteHeadlessElectronArgs(environment: Environment = process.env,
  platform: string = process.platform, architecture: string = process.arch): readonly string[] {
  return desktopFiniteHeadlessSelected(environment, platform, architecture) ? args : [];
}

/** Carry only validated finite admission through the existing closed TEST app environment. */
export function desktopFiniteHeadlessAppEnvironment(environment: Environment = process.env,
  platform: string = process.platform, architecture: string = process.arch): Record<string, string> {
  return desktopFiniteHeadlessSelected(environment, platform, architecture) ? {
    LEGACY_DESKTOP_TEST_HEADLESS: '1', LEGACY_DESKTOP_BACKEND_GO: '1',
    LEGACY_DESKTOP_EMULATED_ONLY: '1', LEGACY_DESKTOP_PROOF_MODE: mode,
  } : {};
}
