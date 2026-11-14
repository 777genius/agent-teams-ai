import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  connectCapturedDesktopApp,
  cleanupCapturedDesktopApp,
  captureDesktopNativeExecutable,
  selectedDesktopRuntime,
} from './desktop-captured-app.ts';
import type { DesktopCdpLibrary, DesktopCdpPort } from './desktop-captured-app.ts';
import {
  assertOwnedCdpListener,
  command,
  groupMembers,
  portOccupied,
  processTable,
  compiledBundleHashes,
  projectDesktopHarnessFailure,
} from './desktop-backend-observations.ts';
import {
  captureDonorSavedInputs,
  captureDonorSavedCorpus,
  writeDonorSavedSeed,
  donorRow,
  DONOR_SAVED_MEMBER,
  DONOR_SAVED_DESCRIPTION,
} from './desktop-donor-saved-fixture.ts';
import type { DonorSavedSeed, DonorRow } from './desktop-donor-saved-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import { desktopCreateTeamHeaderButtonSelector } from './desktop-create-config-ui-smoke.ts';
import { desktopProofSources } from './desktop-proof-sources.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 100));

/** Preserve the original copied pnpm exec after one read-only donor availability prelude. */
export async function prepareDonorSavedPackageManager(options: {
  root: string; donorRoot: string; node: string;
  pnpmStubSha256: string; sentinelSha256: string; shellProbeSha256: string;
}) {
  const parkedDirectory = join(options.root, 'donor-codex-parked');
  await mkdir(parkedDirectory, { mode: 0o700 });
  const absent = async (path: string) => {
    try { await lstat(path); } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return true;
      throw error;
    }
    return false;
  };
  const checked = async (path: string, expected?: { dev: bigint; ino: bigint; mode: bigint }, links = 1n) => {
    const before = await lstat(path, { bigint: true });
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === links &&
      before.size > 0n && before.size <= 64n * 1024n, 'Regular bounded original donor sentinel');
    assert.equal(await realpath(path), path);
    const bytes = await readFile(path), after = await lstat(path, { bigint: true });
    for (const key of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const)
      assert.equal(after[key], before[key], 'Original donor sentinel stable during read');
    assert.equal(BigInt(bytes.length), before.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), options.sentinelSha256, 'Donor metadata pin changed');
    const identity = { dev: before.dev, ino: before.ino, mode: before.mode & 0o7777n };
    if (expected) assert.deepEqual(identity, expected, 'Same original donor sentinel identity and mode');
    return identity;
  };
  const originals = await Promise.all([
    join(options.root, 'bin/codex'), join(options.root, 'claude/local/node_modules/.bin/codex'),
  ].map(async (path, index) => ({ path,
    parkedPath: join(parkedDirectory, index === 0 ? 'root-bin' : 'claude-vendor'), identity: await checked(path) })));
  const sentinels = Object.freeze(originals.map(value => Object.freeze({
    path: value.path, parkedPath: value.parkedPath, mode: Number(value.identity.mode), sha256: options.sentinelSha256,
  })));
  let parkingAttempted = false;
  const parkCodexSentinels = async () => {
    assert.equal(parkingAttempted, false, 'One original donor parking attempt');
    parkingAttempted = true;
    for (const value of originals) {
      await checked(value.path, value.identity);
      assert.ok(await absent(value.parkedPath), 'Private original sentinel parking name is absent');
    }
    for (const value of originals) {
      await rename(value.path, value.parkedPath);
      await checked(value.parkedPath, value.identity);
      assert.ok(await absent(value.path), 'Original donor Codex candidate is genuinely absent');
    }
    return sentinels;
  };
  const restoreCodexSentinels = async () => {
    for (const value of originals) {
      if (await absent(value.parkedPath)) {
        await checked(value.path, value.identity);
        continue; // A prelaunch error may precede this original file's move.
      }
      await checked(value.parkedPath, value.identity);
      assert.ok(await absent(value.path), 'Never overwrite a replacement donor Codex candidate');
      await link(value.parkedPath, value.path); // Exclusive creation, preserving original inode/bytes/mode.
      await checked(value.path, value.identity, 2n);
      await checked(value.parkedPath, value.identity, 2n);
      await unlink(value.parkedPath);
      await checked(value.path, value.identity);
    }
    return sentinels;
  };
  const bin = join(options.root, 'donor-bin'), shimPath = join(bin, 'pnpm');
  await mkdir(bin, { mode: 0o700 });
  await copyFile(join(options.root, 'bin/pnpm'), shimPath);
  await chmod(shimPath, 0o700);
  const original = await readFile(shimPath, 'utf8');
  assert.equal(await fileDigest(shimPath), options.pnpmStubSha256);
  assert.ok(original.startsWith('#!/bin/sh\n'));
  const checkPath = join(options.root, 'donor-codex-availability.mjs');
  const receiptPath = join(options.root, 'donor-codex-availability.json');
  const checkSource = `import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const expected = ${JSON.stringify({ ...options, receiptPath, sentinels })};
const invocation = process.argv.slice(2);
assert.deepEqual(invocation.slice(0, 3), ['exec', 'electron-vite', 'dev']);
assert.equal(realpathSync(process.cwd()), expected.donorRoot);
assert.equal(realpathSync(process.execPath), realpathSync(expected.node));
for (const [name, value] of Object.entries({
  HOME: join(expected.root, 'home'), CFFIXED_USER_HOME: join(expected.root, 'home'),
  AGENT_TEAMS_ELECTRON_USER_DATA_DIR: join(expected.root, 'userData'),
  AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: join(expected.root, 'claude'),
  CLAUDE_ROOT: join(expected.root, 'claude'), CLAUDE_CONFIG_DIR: join(expected.root, 'claude'),
  CODEX_HOME: join(expected.root, 'config/codex'), SHELL: join(expected.root, 'bin/shell-env'),
})) assert.equal(process.env[name], value, 'Original donor environment binding: ' + name);
assert.equal(process.env.CODEX_CLI_PATH, undefined, 'Donor Codex override must be absent');
const absent = path => {
  try { lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
  return false;
};
const pinned = (path, sha256, mode) => {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 64 * 1024, 'Regular bounded donor metadata');
  assert.equal(realpathSync(path), path);
  if (mode !== undefined) assert.equal(stat.mode & 0o7777, mode, 'Original donor metadata mode');
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), sha256, 'Donor metadata pin changed');
};
for (const original of expected.sentinels) {
  pinned(original.parkedPath, expected.sentinelSha256, original.mode);
  assert.ok(absent(original.path), 'Unexpected donor Codex candidate: ' + original.path);
}
pinned(process.env.SHELL, expected.shellProbeSha256);
const managed = join(expected.root, 'userData/data/runtimes/codex/current.json');
assert.ok(absent(managed), 'Donor managed Codex manifest must be absent');
const pathValue = process.env.PATH;
assert.ok(typeof pathValue === 'string' && pathValue.length <= 16 * 1024);
const home = join(expected.root, 'home');
const directories = [...pathValue.split(':').map(value => value.trim()).filter(Boolean),
  join(expected.donorRoot, 'node_modules/.bin'), join(expected.root, 'claude/local/node_modules/.bin'),
  ...['.bun/bin', '.local/bin', '.npm-global/bin', '.npm/bin', '.asdf/shims', '.local/share/mise/shims',
    '.volta/bin', 'Library/pnpm', '.local/share/pnpm', '.cargo/bin', '.nix-profile/bin'].map(value => join(home, value)),
  '/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const candidates = [...new Set([...directories.map(directory => resolve(expected.donorRoot, directory, 'codex')),
  ...expected.sentinels.map(value => value.path)])];
assert.ok(candidates.length <= 128, 'Finite original donor resolver candidates');
const observations = candidates.map(path => {
  assert.ok(absent(path), 'Unexpected donor Codex candidate: ' + path);
  return { path, kind: 'absent' };
});
const receipt = JSON.stringify({ schemaVersion: 1, kind: 'donor-saved-codex-unavailable',
  cwd: expected.donorRoot, invocation, sentinelSha256: expected.sentinelSha256,
  shellProbeSha256: expected.shellProbeSha256, sentinels: expected.sentinels, observations });
assert.ok(Buffer.byteLength(receipt) <= 64 * 1024);
writeFileSync(expected.receiptPath, receipt, { mode: 0o600, flag: 'wx' });
`;
  await writeFile(checkPath, checkSource, { mode: 0o600, flag: 'wx' });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const shim = '#!/bin/sh\n' + quote(options.node) + ' ' + quote(checkPath) +
    ' "$@" || exit "$?"\n' + original.slice('#!/bin/sh\n'.length);
  await writeFile(shimPath, shim, { mode: 0o700 });
  return { bin, checkPath, receiptPath, originalPnpmSha256: options.pnpmStubSha256,
    checkSha256: await fileDigest(checkPath), shimSha256: await fileDigest(shimPath),
    sentinels, parkCodexSentinels, restoreCodexSentinels };
}

/** One genuine old-frontend epoch, before current Main. Only UI Save mutates product records. */
export async function produceDesktopDonorSavedTeam(options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
  cdpLibrary: DesktopCdpLibrary;
  model: Awaited<ReturnType<typeof startNativeTeamModel>>;
  evidence: DonorRow;
}): Promise<DonorSavedSeed> {
  const { fixture, model } = options;
  assert.equal(process.env.LEGACY_DESKTOP_DONOR_SAVED_ONLY, '1');
  assert.equal(process.env.LEGACY_DESKTOP_STOPPED_IMPORT_LAUNCH ?? '', '');
  const inputs = await captureDonorSavedInputs(
    process.env.LEGACY_DESKTOP_DONOR_PATH!,
    fixture.node
  );
  assert.equal(await portOccupied(), false, 'never attach donor to an existing renderer');
  const selectedRuntime = () => selectedDesktopRuntime(inputs.runtime.path);
  assert.deepEqual(selectedRuntime(), [], 'unique donor runtime has no previous process');
  const donorPackageManager = await prepareDonorSavedPackageManager({
    root: fixture.root, donorRoot: inputs.root, node: fixture.node,
    pnpmStubSha256: fixture.pins.pnpmStubSha256, sentinelSha256: fixture.pins.sentinelSha256,
    shellProbeSha256: fixture.pins.shellProbeSha256,
  });
  const { bin } = donorPackageManager;
  const env: NodeJS.ProcessEnv = {
    HOME: join(fixture.root, 'home'),
    CFFIXED_USER_HOME: join(fixture.root, 'home'),
    XDG_CONFIG_HOME: join(fixture.root, 'config'),
    XDG_DATA_HOME: join(fixture.root, 'data'),
    XDG_CACHE_HOME: join(fixture.root, 'cache'),
    TMPDIR: join(fixture.root, 'tmp'),
    MAC_CHROMIUM_TMPDIR: join(fixture.root, 'tmp'),
    PATH: [
      bin,
      dirname(fixture.node),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(':'),
    SHELL: join(fixture.root, 'bin/shell-env'),
    TERM: 'dumb',
    NO_COLOR: '1',
    NODE_ENV: 'development',
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: join(fixture.root, 'userData'),
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: join(fixture.root, 'claude'),
    CLAUDE_ROOT: join(fixture.root, 'claude'),
    CLAUDE_CONFIG_DIR: join(fixture.root, 'claude'),
    CODEX_HOME: join(fixture.root, 'config/codex'),
    OPENCODE_CONFIG_DIR: join(fixture.root, 'config/opencode'),
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: inputs.runtime.path,
    CLAUDE_DEV_RUNTIME_CACHE_ROOT: process.env.LEGACY_DESKTOP_DONOR_RUNTIME_CACHE,
    CLAUDE_DEV_RUNTIME_DISABLE_GH: '1',
    NODE_BINARY: fixture.node,
    pnpm_config_verify_deps_before_run: 'warn',
    ANTHROPIC_BASE_URL: model.url,
    ANTHROPIC_API_KEY: 'TEST-donor-saved-only-key',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  assert.ok(
    !Object.keys(env).some((key) => key.includes('BACKEND_DESCRIPTOR')),
    'donor receives no current Host descriptor'
  );
  assert.ok(
    !env.PATH!.split(':').includes(join(fixture.root, 'bin')),
    'actual donor uses its runtime, never the consumer deny-all sentinels'
  );
  const teamName = 'test-donor-saved-' + randomBytes(6).toString('hex');
  const steps: DonorRow[] = [];
  const proof: DonorRow = {
    status: 'INCOMPLETE',
    sourceKind: 'actual-donor-saved-only',
    teamName,
    producer: inputs,
    steps,
    hostDescriptorPresent: false,
    scope:
      'Actual donor Create without Launch; ordinary Quit and original absence before current import',
    excluded: [
      'donor native history/Review',
      'donor attachments/tasks',
      'prior-native import',
      'release qualification',
    ],
  };
  options.evidence.donorSavedProducer = proof;
  let phase = 'connect';
  let failureObservation: DonorRow | undefined;
  const receiptPath = join(fixture.root, 'desktop-donor-saved-producer.json');
  const log = createWriteStream(join(fixture.root, 'desktop-donor-saved-app.log'), { mode: 0o600 });
  const invocation = [
    fixture.node,
    fixture.packageManager.entry,
    'dev:mcp',
  ];
  let donorSpawnAttempted = false, donorAbsenceConfirmed = false, failed = false;
  let firstFailure: unknown;
  proof.codexSentinels = { state: 'original', files: donorPackageManager.sentinels };
  try {
    proof.codexSentinels = { state: 'parked', files: await donorPackageManager.parkCodexSentinels() };
    donorSpawnAttempted = true;
    const app = spawn(invocation[0]!, invocation.slice(1), {
      cwd: inputs.root,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const group = app.pid ?? 0;
    let spawnError = false,
      appIdentity = '',
      quitRequested = false;
    let cdp: DesktopCdpPort | undefined, seed: DonorSavedSeed | undefined;
    const nativeChildren = captureDesktopNativeExecutable(inputs.runtime.path, group);
    const observeOriginalNative = () => nativeChildren.observe();
    const remainingNative = () => nativeChildren.remaining();
    try {
      app.once('error', () => {
        spawnError = true;
      });
      app.stdout.pipe(log, { end: false });
      app.stderr.pipe(log, { end: false });
      assert.ok(group > 0);
      appIdentity = execFileSync('/bin/ps', ['-p', String(group), '-o', 'lstart=,command='], {
        encoding: 'utf8',
        timeout: 3000,
      }).trim();
      proof.app = { pid: group, processGroup: group, identity: appIdentity, invocation };
      const connected = await connectCapturedDesktopApp({
        app,
        group,
        spawnError: () => spawnError,
        packed: undefined,
        cdpLibrary: options.cdpLibrary,
        evidence: proof,
      });
      cdp = connected.cdp;
      const renderer = cdp;
      assert.ok(
        groupMembers(group).some((entry) => {
          const value = command(entry.pid);
          return value === inputs.electron.path || value.startsWith(inputs.electron.path + ' ');
        }),
        'original process group executes the exact donor Electron'
      );
      proof.bundles = await compiledBundleHashes(join(inputs.root, 'dist-electron'));
      const availability = donorRow(JSON.parse(await readFile(donorPackageManager.receiptPath, 'utf8')));
      assert.equal(availability.schemaVersion, 1); assert.equal(availability.kind, 'donor-saved-codex-unavailable');
      assert.equal(availability.cwd, inputs.root); assert.equal(availability.sentinelSha256, fixture.pins.sentinelSha256);
      assert.equal(availability.shellProbeSha256, fixture.pins.shellProbeSha256);
      assert.equal(await fileDigest(donorPackageManager.checkPath), donorPackageManager.checkSha256);
      assert.equal(await fileDigest(join(bin, 'pnpm')), donorPackageManager.shimSha256);
      proof.codexAvailability = { ...donorPackageManager, receipt: availability,
        receiptSha256: await fileDigest(donorPackageManager.receiptPath) };
      const step = (value: DonorRow) =>
        steps.push({ elapsedMs: Math.round(performance.now()), ...value });
      const ui = createDesktopUiControls(renderer, {
        assertOwnedRenderer: () => {
          assertOwnedCdpListener(group);
          observeOriginalNative();
        },
        step,
      });
      const fill = async (selector: string, text: string, label: string) => {
        await ui.scrollTo(selector, label);
        await ui.click(selector, label);
        await renderer.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'a',
          code: 'KeyA',
          modifiers: 4,
          commands: ['selectAll'],
        });
        await renderer.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'a',
          code: 'KeyA',
          modifiers: 4,
        });
        assert.equal(
          await renderer.evaluate(
            '(() => {const e=document.querySelector(' + literal(selector) + ');return ' +
            '(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement)&&' +
            'document.activeElement===e&&e.selectionStart===0&&e.selectionEnd===e.value.length;})()'
          ),
          true,
          label + ': original field is focused and fully selected before the one insertion'
        );
        await renderer.send('Input.insertText', { text });
        await ui.waitRead(
          'document.querySelector(' + literal(selector) + ')?.value===' + literal(text),
          label + ' retained'
        );
      };
      phase = 'create-form';
      await ui.observeInput();
      await ui.waitRead(
        'Boolean(document.querySelector(\'button[aria-label="More actions"]\'))',
        'donor application menu',
        90_000
      );
      await ui.click('button[aria-label="More actions"]', 'open donor original menu');
      await ui.click('button', 'open donor Teams', 'Teams');
      await ui.click(desktopCreateTeamHeaderButtonSelector, 'open donor original Create', 'Create Team');
      const page = '[data-testid="create-team-page"]';
      await ui.waitRead(
        "(() => { const b=document.querySelector('" +
          page +
          ' button[aria-label="Team template"]\');return b&&!b.disabled;})()',
        'donor Create hydration'
      );
      await fill(page + ' #team-name', teamName, 'donor unique name');
      phase = 'model-selection';
      await ui.scrollTo(page + ' button[aria-label*=" provider,"]', 'donor lead model');
      await ui.click(page + ' button[aria-label*=" provider,"]', 'open donor lead model');
      const modelOption =
        page + ' [data-testid="team-model-selector-model-option"][aria-label^="Sonnet 4.6"]';
      await ui.scrollTo(modelOption, 'donor Sonnet4.6 option');
      await ui.click(modelOption, 'select donor Sonnet4.6');
      await ui.waitRead(
        '(() => {const button=document.querySelector(' + literal(page + ' #lead-effort') +
          ');return button instanceof HTMLButtonElement&&button.disabled&&button.textContent.trim()==="Not supported";})()',
        'donor compatible catalogue omits unsupported effort'
      );
      phase = 'member-configuration';
      await ui.scrollTo(page + ' button[aria-label="Add member"]', 'donor Add member');
      await ui.click(page + ' button[aria-label="Add member"]', 'add donor peer once');
      await fill(page + ' input[aria-label="Member 1 name"]', DONOR_SAVED_MEMBER, 'donor peer name');
      const section = donorRow(
        await ui.waitRead(
          "(() => {const b=[...document.querySelectorAll('" +
            page +
            ' button[aria-controls]\')].find(e=>e.textContent.includes("Optional team details"));return b?{id:b.getAttribute("aria-controls"),expanded:b.getAttribute("aria-expanded")}:null;})()',
          'donor original optional team details'
        )
      );
      if (section.expanded !== 'true') {
        const selector = page + ' button[aria-controls=' + JSON.stringify(section.id) + ']';
        await ui.scrollTo(selector, 'donor team details');
        await ui.click(selector, 'expand donor team details once');
      }
      await fill(page + ' #team-description', DONOR_SAVED_DESCRIPTION, 'donor description');
      await ui.scrollTo(page + ' button', 'donor custom path control', 'Custom path');
      await ui.click(page + ' button', 'select donor custom path', 'Custom path');
      await fill(
        page + ' input[aria-label="Custom working directory"]',
        join(fixture.root, 'workspace'),
        'donor working directory'
      );
      phase = 'save';
      await ui.scrollTo(page + ' #launch-team', 'donor Save without Launch');
      assert.equal(
        await renderer.evaluate(
          "document.querySelector('" + page + ' #launch-team\')?.getAttribute("data-state")'
        ),
        'checked'
      );
      await ui.click(page + ' #launch-team', 'uncheck donor Launch once');
      await ui.waitRead(
        "document.querySelector('" +
          page +
          ' #launch-team\')?.getAttribute("data-state")==="unchecked"',
        'donor save-only selection'
      );
      await ui.scrollTo(page + ' button', 'donor Create save-only', 'Create');
      await ui.click(page + ' button', 'save donor Team once', 'Create');
      await ui.waitRead(
        "!document.querySelector('" + page + "')",
        'donor saved Create outcome',
        45_000
      );
      await ui.waitRead(
        'window.electronAPI.teams.list().then(rows=>rows.some(row=>row.teamName===' +
          literal(teamName) +
          '))',
        'ordinary donor Team list observes saved identity'
      );
      const screenshot = donorRow(
        await renderer.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
      );
      const screenshotPath = join(fixture.root, 'desktop-donor-saved-created.png');
      await writeFile(screenshotPath, Buffer.from(String(screenshot.data), 'base64'), {
        mode: 0o600,
        flag: 'wx',
      });
      proof.screenshot = { path: screenshotPath, sha256: await fileDigest(screenshotPath) };
      phase = 'native-drain';
      // Donor's existing model check owns a 60s timeout; observe its original completion,
      // never start another check or signal a detached child from this TEST harness.
      const probeDeadline = Date.now() + 60_000;
      let closingSelected: ReturnType<typeof selectedRuntime>;
      let closingCaptured: ReturnType<typeof remainingNative>;
      for (;;) {
        observeOriginalNative();
        while (selectedRuntime().length && Date.now() < probeDeadline) {
          await tick();
          observeOriginalNative();
        }
        closingSelected = selectedRuntime();
        closingCaptured = remainingNative();
        if ((!closingSelected.length && !closingCaptured.length) || Date.now() >= probeDeadline)
          break;
        await tick();
      }
      assert.deepEqual(
        closingSelected,
        [],
        'original donor metadata/probe processes settle before Quit'
      );
      assert.deepEqual(closingCaptured, []);
      const beforeQuit = groupMembers(group);
      proof.beforeQuit = beforeQuit;
      assert.ok(
        !beforeQuit.some((entry) => command(entry.pid) === fixture.node + ' ' + fixture.hostEntry),
        'no current Host in donor epoch'
      );
      phase = 'quit';
      quitRequested = true;
      await renderer.evaluate('window.electronAPI.windowControls.close()').catch(() => undefined);
      const deadline = Date.now() + 20_000;
      while (
        Date.now() < deadline &&
        (app.exitCode === null ||
          groupMembers(group).length ||
          remainingNative().length ||
          selectedRuntime().length)
      )
        await tick();
      assert.equal(app.exitCode, 0, 'ordinary donor wrapper reaped after Quit');
      assert.equal(app.signalCode, null);
      assert.deepEqual(
        groupMembers(group),
        [],
        'all original donor app processes absent before consumer'
      );
      assert.equal(
        processTable().some((entry) => entry.pid === group),
        false
      );
      assert.equal(await portOccupied(), false);
      assert.deepEqual(remainingNative(), [], 'all captured detached donor births are absent');
      assert.deepEqual(selectedRuntime(), [], 'no unmatched selected donor runtime child remains');
      proof.nativeChildren = { captured: nativeChildren.captured(), remaining: [], unmatched: [] };
      proof.ordinaryQuit = {
        requestedOnce: true,
        exitCode: app.exitCode,
        signalCode: app.signalCode,
        originalGroupAbsent: true,
        remaining: [],
        listenerAbsent: true,
      };
      assert.deepEqual(model.observations, [], 'zero donor native business inputs');
      assert.deepEqual(model.failures, []);
      assert.deepEqual(model.unexpectedNoToolsRequests, []);
      const finishDonor = model.finishDonorSavedProbes;
      assert.ok(finishDonor, 'explicit donor oracle phase');
      const donorProbes = await finishDonor();
      assert.ok(donorProbes.length <= 8, 'finite original read-only model checks only');
      assert.deepEqual(model.probes, [], 'current Host has not started in the donor epoch');
      const sentinelBefore = await lstat(fixture.sentinelLog, { bigint: true });
      assert.ok(sentinelBefore.isFile() && !sentinelBefore.isSymbolicLink() &&
        sentinelBefore.size > 0n && sentinelBefore.size <= 64n * 1024n,
        'bounded original donor sentinel log before current Main');
      const sentinelBytes = await readFile(fixture.sentinelLog);
      const sentinelAfter = await lstat(fixture.sentinelLog, { bigint: true });
      assert.ok(sentinelAfter.isFile() && !sentinelAfter.isSymbolicLink());
      for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const)
        assert.equal(sentinelAfter[key], sentinelBefore[key], 'original sentinel log unchanged during read');
      assert.equal(BigInt(sentinelBytes.length), sentinelBefore.size);
      const sentinelText = sentinelBytes.toString('utf8');
      assert.ok(Buffer.from(sentinelText).equals(sentinelBytes), 'original log is complete UTF-8');
      assert.ok(sentinelText.endsWith('\n'), 'original log contains complete newline-delimited records');
      const sentinelRows = sentinelText.slice(0, -1).split('\n').map(line => donorRow(JSON.parse(line)));
      proof.sentinelBeforeConsumer = {
        bytes: sentinelBytes.length, sha256: createHash('sha256').update(sentinelBytes).digest('hex'),
        count: sentinelRows.length, invocations: sentinelRows,
      };
      phase = 'source-capture';
      const source = await captureDonorSavedCorpus(fixture.root, teamName);
      seed = {
        sourceKind: 'actual-donor-saved-only',
        teamName,
        displayName:
          typeof source.meta.displayName === 'string' && source.meta.displayName.trim()
            ? source.meta.displayName
            : teamName,
        producer: inputs,
        producerProbeCount: donorProbes.length,
        source,
      };
      proof.source = source;
      proof.modelProbes = donorProbes;
      proof.nativeBusinessInputs = 0;
      proof.nativeIdentity = 'empty';
      await writeDonorSavedSeed(fixture.root, seed);
      proof.seedSha256 = await fileDigest(join(fixture.root, 'desktop-donor-saved-seed.json'));
      proof.status = 'PASS';
    } catch (error) {
      if (!failed) { failed = true; firstFailure = error; }
      try {
        failureObservation = {
          phase, source: projectDesktopHarnessFailure(error, join(import.meta.dirname, '../..'), desktopProofSources),
        };
      } catch { failureObservation = { phase, source: { kind: 'unclassified', frames: [] } }; }
      proof.failure = error instanceof Error ? error.message.slice(0, 4000) : 'donor producer failed';
      throw error;
    } finally {
      try {
        if (cdp && !quitRequested && app.exitCode === null && app.signalCode === null) {
          quitRequested = true;
          try {
            assertOwnedCdpListener(group);
            await cdp.evaluate('window.electronAPI.windowControls.close()');
          } catch {
            /* Original cleanup follows. */
          }
        }
        if (cdp) await cdp.close().catch(() => undefined);
        const cleanup = await cleanupCapturedDesktopApp({
          app,
          group,
          fixture,
          evidence: proof,
          appIdentity,
          hostPid: undefined,
          packedRelaunchMode: false,
        });
        proof.cleanup = cleanup;
        const nativeAfterCleanup = {
          captured: nativeChildren.captured(),
          remaining: remainingNative(),
          unmatched: selectedRuntime(),
        };
        proof.nativeChildrenAfterCleanup = nativeAfterCleanup;
        donorAbsenceConfirmed = (app.exitCode !== null || app.signalCode !== null) &&
          !cleanup.cleanupFailure && cleanup.remaining !== null && cleanup.remaining.length === 0 &&
          nativeAfterCleanup.remaining.length === 0 && nativeAfterCleanup.unmatched.length === 0;
        if (nativeAfterCleanup.remaining.length || nativeAfterCleanup.unmatched.length)
          proof.status = 'INCOMPLETE';
        if (cleanup.cleanupFailure || cleanup.remaining === null || cleanup.remaining.length)
          proof.status = 'INCOMPLETE';
        try {
          assert.deepEqual(
            await captureDonorSavedInputs(inputs.root, fixture.node),
            inputs,
            'donor source/lock/toolchain remain frozen'
          );
          proof.sourceFrozen = true;
        } catch (error) {
          proof.status = 'INCOMPLETE';
          proof.freezeFailure =
            error instanceof Error ? error.message.slice(0, 4000) : 'donor freeze failed';
        }
        if (proof.status !== 'PASS') {
          try {
            const observation = {
              diagnostic: 'donor-saved-producer',
              firstModelFailure: model.failures.length === 0 ? null
                : model.failures[0] === 'bounded original legacy catalog reads' ? 'catalogue-limit'
                  : model.failures[0] === 'preconnect belongs to the original producer epoch' ? 'preconnect-epoch'
                    : model.failures[0] === 'bounded original runtime preconnects' ? 'preconnect-limit'
                      : 'unclassified',
              ...(failureObservation ?? { phase: 'cleanup-or-freeze', source: { kind: 'unclassified', frames: [] } }),
              sourceFrozen: proof.sourceFrozen === true, cleanupFailed: cleanup.cleanupFailure !== undefined,
              cleanupEmpty: cleanup.remaining === null ? null : cleanup.remaining.length === 0,
              capturedNativeEmpty: nativeAfterCleanup.remaining.length === 0,
              unmatchedNativeEmpty: nativeAfterCleanup.unmatched.length === 0,
            };
            const encoded = JSON.stringify(observation);
            assert.ok(Buffer.byteLength(encoded) <= 4096);
            proof.failureObservation = observation;
            console.log(encoded);
          } catch { /* Keep the original failure and cleanup. */ }
        }
      } finally {
        app.stdout.unpipe(log);
        app.stderr.unpipe(log);
      }
    }
    assert.ok(seed);
    return seed;
  } catch (error) {
    if (!failed) { failed = true; firstFailure = error; }
    proof.status = 'INCOMPLETE';
    proof.failure ??= error instanceof Error ? error.message.slice(0, 4000) : 'donor producer failed';
    throw firstFailure;
  } finally {
    const restorePermitted = !donorSpawnAttempted || donorAbsenceConfirmed;
    try {
      assert.ok(restorePermitted, 'Original donor absence unconfirmed; restoration withheld');
      proof.codexSentinels = { state: 'restored', files: await donorPackageManager.restoreCodexSentinels(),
        basis: donorSpawnAttempted ? 'original-reaped-and-censuses-empty' : 'before-spawn' };
    } catch (error) {
      proof.status = 'INCOMPLETE';
      proof.codexSentinels = { state: restorePermitted ? 'restore-failed' : 'restoration-withheld',
        files: donorPackageManager.sentinels,
        failure: error instanceof Error ? error.message.slice(0, 4000) : 'sentinel restoration unconfirmed' };
      if (!failed) { failed = true; firstFailure = error; }
    }
    try {
      await new Promise<void>((resolve) => log.end(resolve));
      await writeFile(receiptPath, JSON.stringify(proof, null, 2), { mode: 0o600 });
      assert.equal(
        proof.status,
        'PASS',
        'producer did not finish ordinary Quit, absence and immutable corpus'
      );
    } catch (error) {
      if (!failed) { failed = true; firstFailure = error; }
    }
    // eslint-disable-next-line no-unsafe-finally -- Preserve the first failure and reject a pending seed return when restoration failed.
    if (failed) throw firstFailure;
  }
}
