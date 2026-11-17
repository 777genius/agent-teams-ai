// REAL Claude/Codex composer proof in the live Electron app (`pnpm dev:mcp`, captured Host mode).
// Usage: node scripts/e2e/native-prompt-suggestions-real/ui.ts [--vendor claude|codex|all] [--turns N] [--shipped-default|--provider-off]
// Exit codes: 0 pass, 1 fail, 3 inconclusive. See README.md.
import { spawn } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  Inconclusive,
  assertFreeDisk,
  discoverTarget,
} from '../../../packages/legacy-agent-host/tests/fixtures/real-vendor/discovery.ts';
import { prepareDesktopBackendFixture } from '../../legacy-agent-host/desktop-backend-fixture.ts';
import {
  applyNativeNextPromptPreference,
  realVendorProfileTransform,
} from '../../legacy-agent-host/desktop-real-vendor-fixture.ts';
import { runUiScenario } from './ui-scenario.ts';

import type { ChildProcess } from 'node:child_process';
import type { RealVendor } from '../../../packages/legacy-agent-host/tests/fixtures/real-vendor/discovery.ts';
import type { UiScenarioReport } from './ui-scenario.ts';

const repo = resolve(import.meta.dirname, '../../..');
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const wanted = option('--vendor', 'claude');
if (!['claude', 'codex', 'all'].includes(wanted))
  throw new Error('--vendor must be claude, codex or all');
const vendors: RealVendor[] = wanted === 'all' ? ['claude', 'codex'] : [wanted as RealVendor];
const maxTurns = Number(option('--turns', '8'));
// Do not seed the setting at all: the app must apply its own default for the proof to pass.
const shippedDefault = args.includes('--shipped-default');
// The user turned the provider setting off: nothing may be offered (negative proof).
const providerOff = args.includes('--provider-off');
const receiptDir = process.env.REAL_RECEIPT_DIR ?? join(homedir(), '.cache/agent-teams-real-e2e');
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Cleanup = () => Promise<void> | void;
const cleanups: Cleanup[] = [];
let finishing: Promise<void> | undefined;
// Cleanups run last-registered first and each one is awaited: the app must really be gone before the
// fixture root (isolated credential copy) is deleted, or the removal races the app's last writes.
const runCleanups = () =>
  (finishing ??= (async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        console.error(`cleanup step failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  })());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.on(signal, () => {
    console.error(`\n${signal}: closing the app and removing credential copies...`);
    void runCleanups().then(() => process.exit(130));
  });

const removeDir = (dir: string) =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
async function stopApp(app: ChildProcess): Promise<void> {
  const alive = () => app.exitCode === null && app.signalCode === null;
  const group = (signal: NodeJS.Signals) => {
    try {
      process.kill(-app.pid!, signal);
    } catch {
      // group already gone
    }
  };
  if (alive()) group('SIGTERM');
  for (const until = Date.now() + 20_000; alive() && Date.now() < until; ) await sleep(200);
  group('SIGKILL'); // also sweeps Electron helpers that outlived the leader
  await sleep(500);
}

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

/**
 * `pnpm install --ignore-scripts` leaves better-sqlite3 unbuilt. The app's command ledger then cannot open,
 * `team.roster.read` answers `hold`, the member never gets its `hostMemberId`, and the composer silently
 * never shows a suggestion: a harness problem that looks exactly like a product bug.
 */
function assertNativeModulesBuilt(): void {
  const require = createRequire(join(repo, 'package.json'));
  const directory = dirname(require.resolve('better-sqlite3/package.json'));
  if (!existsSync(join(directory, 'build/Release/better_sqlite3.node')))
    throw new Inconclusive(
      'app-not-built',
      'native modules are not built for Electron (installed with --ignore-scripts?). Run `node scripts/postinstall-electron.cjs` at the repo root'
    );
}

/** The fixture pins this exact Node under resources/ (gitignored); provide it from the running Node. */
function provideFixtureNode(): void {
  const target = join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node');
  if (existsSync(target)) return;
  if (process.version !== 'v24.21.0' || process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error(
      `the Desktop proof needs Node v24.21.0 on darwin-arm64 (this is ${process.version} ${process.platform}-${process.arch}), or place it at ${target}`
    );
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(process.execPath, target);
}

async function corepackPnpmEntry(): Promise<string> {
  const candidates = [
    process.env.PNPM_ENTRY,
    join(dirname(process.execPath), '../lib/node_modules/corepack/dist/pnpm.js'),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) if (existsSync(candidate)) return realpath(candidate);
  throw new Error('cannot find Corepack dist/pnpm.js; set PNPM_ENTRY to it');
}

async function runVendor(vendor: RealVendor): Promise<{ status: string; reason?: string }> {
  const receipt: Record<string, unknown> = {
    vendor,
    mode: 'desktop-ui',
    status: 'fail',
    startedAt: new Date().toISOString(),
  };
  const out = join(receiptDir, `${stamp}-ui-${vendor}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const mine: Cleanup[] = [];
  let appLog: string | undefined;
  let report: UiScenarioReport | undefined;
  try {
    await assertFreeDisk();
    const target = await discoverTarget(vendor);
    Object.assign(receipt, { binary: target.binary, version: target.version, model: target.model });
    if (!existsSync(join(repo, 'node_modules/electron')))
      throw new Error('app dependencies are missing: run `pnpm install` at the repo root');
    assertNativeModulesBuilt();
    provideFixtureNode();
    const transform = realVendorProfileTransform(target);
    const fixture = await prepareDesktopBackendFixture(repo, {
      seedUiTask: true,
      pnpmEntry: await corepackPnpmEntry(),
      profileTransform: async (context) => {
        // The root exists from here on and (for Codex) will hold the isolated credential copy: remove it
        // even if the rest of fixture preparation throws.
        mine.push(() => removeDir(context.root));
        await transform(context);
      },
    });
    await applyNativeNextPromptPreference(
      fixture.root,
      providerOff ? 'off' : shippedDefault ? 'default' : 'on'
    );

    const port = await freePort();
    const logPath = join(fixture.root, 'app.log');
    appLog = logPath;
    const fd = openSync(logPath, 'a', 0o600);
    // A pipe to a dead parent (SIGPIPE) would kill the app mid-run; a file never does.
    const app = spawn(
      fixture.node,
      [
        await realpath(fixture.packageManager.entry),
        'dev:mcp',
        '--remoteDebuggingPort',
        String(port),
      ],
      {
        cwd: repo,
        env: { ...fixture.appEnvironment, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
        stdio: ['ignore', fd, fd],
        detached: true,
      }
    );
    closeSync(fd);
    let exited = false;
    app.on('exit', () => {
      exited = true;
    });
    mine.push(() => stopApp(app));
    cleanups.push(async () => {
      for (const cleanup of mine.splice(0).reverse()) await cleanup();
    });

    let ready = false;
    for (
      const end = Date.now() + 300_000;
      Date.now() < end && !ready && !exited;
      await sleep(1_500)
    ) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
          type: string;
        }[];
        ready = targets.some((candidate) => candidate.type === 'page');
      } catch {
        // not listening yet
      }
    }
    if (!ready)
      throw new Error(
        `the app never exposed a renderer on :${port} (${exited ? 'it exited' : 'timeout'}); log tail:\n${readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')}`
      );
    await sleep(3_000);
    report = await runUiScenario({
      port,
      root: fixture.root,
      handleId: fixture.handleId,
      out,
      maxTurns,
      vendor,
      providerOff,
    });
    Object.assign(receipt, {
      status: report.status,
      reason: report.reason,
      report: {
        steps: report.steps,
        turns: report.turns,
        interactions: report.interactions,
        explicitSends: report.explicitSends,
      },
    });
  } catch (error) {
    if (error instanceof Inconclusive)
      Object.assign(receipt, {
        status: 'inconclusive',
        reasonCode: error.code,
        reason: error.message,
      });
    else
      Object.assign(receipt, {
        status: 'fail',
        reason: error instanceof Error ? error.message : String(error),
      });
  } finally {
    // Keep the whole app log for any failure (it holds no credentials), before the fixture root is removed.
    if (receipt.status === 'fail' && appLog && existsSync(appLog))
      copyFileSync(appLog, join(out, 'app.log'));
    for (const cleanup of mine.splice(0).reverse()) await cleanup();
    writeFileSync(join(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  const label =
    { pass: 'PASS', fail: 'FAIL', inconclusive: 'INCONCLUSIVE' }[receipt.status as string] ??
    String(receipt.status);
  console.log(`${label}  ${vendor} desktop UI  ${receipt.version ? `v${receipt.version}` : ''}`);
  if (receipt.reason) console.log(`      reason: ${String(receipt.reason).split('\n')[0]}`);
  for (const [name, value] of Object.entries(report?.interactions ?? {}))
    console.log(`      ${name}: ${JSON.stringify(value)}`);
  console.log(`      receipt + screenshots: ${out}`);
  return { status: String(receipt.status), reason: receipt.reason as string | undefined };
}

await assertFreeDisk().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(3);
});
const statuses: string[] = [];
for (const vendor of vendors) statuses.push((await runVendor(vendor)).status);
await runCleanups();
process.exit(statuses.includes('fail') ? 1 : statuses.includes('inconclusive') ? 3 : 0);
