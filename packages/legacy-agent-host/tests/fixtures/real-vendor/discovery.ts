import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, realpath, statfs } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import { fileHash } from '../native-host.ts';

const run = promisify(execFile);

export type RealVendor = 'claude' | 'codex';

/** Native `thread/sample` first shipped in Codex 0.169.0; 0.162 reports it as unsupported. */
export const MIN_CODEX_VERSION = '0.169.0';
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol';
const MIN_FREE_BYTES = 1.5 * 1024 ** 3;

/**
 * The vendor, account or machine cannot currently prove the feature. This is neither a pass nor a
 * product failure: it must never be reported as green, and never be reported as a regression.
 */
export type InconclusiveCode =
  | 'binary-missing'
  | 'binary-too-old'
  | 'not-logged-in'
  | 'usage-limit'
  | 'low-disk'
  | 'app-not-built'
  | 'vendor-silent';

export class Inconclusive extends Error {
  readonly code: InconclusiveCode;

  // Node runs these tests with type stripping only: no constructor parameter properties.
  constructor(code: InconclusiveCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RealTarget {
  readonly vendor: RealVendor;
  readonly binary: string;
  readonly sha256: string;
  readonly version: string;
  readonly model: string;
  /** Account credential file that must be copied (never mutated) into isolated members. */
  readonly authSource?: string;
}

const versionParts = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10));
export const versionAtLeast = (actual: string, minimum: string): boolean => {
  const a = versionParts(actual);
  const b = versionParts(minimum);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return true;
};

async function findOnPath(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // continue
    }
  }
  return undefined;
}

async function versionOf(binary: string): Promise<string> {
  const { stdout } = await run(binary, ['--version'], {
    timeout: 15_000,
    env: { PATH: '/usr/bin:/bin', HOME: homedir() },
  });
  const match = /(\d+\.\d+\.\d+)/u.exec(stdout);
  if (!match) throw new Error(`cannot parse a version from ${binary} --version`);
  return match[1]!;
}

/** Best effort: only a clear "not logged in" answer is decisive; any other probe failure stays unknown. */
async function assertLoggedIn(
  vendor: RealVendor,
  binary: string,
  env: Record<string, string>
): Promise<void> {
  const args = vendor === 'claude' ? ['auth', 'status'] : ['login', 'status'];
  try {
    await run(binary, args, { timeout: 20_000, env });
  } catch (error) {
    const text = `${(error as { stdout?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}`;
    if (/not logged in|no credentials|logged out|not signed in|"loggedIn":\s*false/iu.test(text))
      throw new Inconclusive(
        'not-logged-in',
        `${vendor} is not logged in on this machine (run \`${vendor} ${vendor === 'claude' ? 'auth login' : 'login'}\`)`
      );
  }
}

const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex');

async function configuredCodexModel(): Promise<string | undefined> {
  try {
    const text = await readFile(join(codexHome(), 'config.toml'), 'utf8');
    return /^model\s*=\s*"([^"\n]{1,128})"/mu.exec(text)?.[1];
  } catch {
    return undefined;
  }
}

export async function assertFreeDisk(): Promise<void> {
  const stats = await statfs(tmpdir());
  const free = stats.bavail * stats.bsize;
  if (free < MIN_FREE_BYTES)
    throw new Inconclusive(
      'low-disk',
      `only ${(free / 1024 ** 3).toFixed(1)} GiB free in ${tmpdir()}, need ${(MIN_FREE_BYTES / 1024 ** 3).toFixed(1)}`
    );
}

export async function discoverTarget(
  vendor: RealVendor,
  purpose: 'suggestions' | 'autonomous-goal' = 'suggestions'
): Promise<RealTarget> {
  const override = process.env[vendor === 'claude' ? 'REAL_CLAUDE_BIN' : 'REAL_CODEX_BIN'];
  const found = override
    ? await realpath(override).catch(() => undefined)
    : await findOnPath(vendor);
  if (!found)
    throw new Inconclusive(
      'binary-missing',
      `no ${vendor} executable (${override ? `REAL_${vendor.toUpperCase()}_BIN=${override} does not exist` : `not on PATH; set REAL_${vendor.toUpperCase()}_BIN`})`
    );
  const version = await versionOf(found);
  if (vendor === 'codex' && purpose === 'autonomous-goal') {
    // Goal qualification does not call thread/sample. Use the already captured
    // native allowlist before account probing or any profile/Host allocation.
    // Keep this lazy: ordinary discovery also runs before Host compilation.
    const { qualifiedCodexProtocolRevision, RuntimeSourceAdmissionError } =
      await import('../../../dist/composition/runtimeSourceQualification.js');
    try { qualifiedCodexProtocolRevision(version); }
    catch (error) {
      if (!(error instanceof RuntimeSourceAdmissionError) || error.reason !== 'unqualified-version') throw error;
      throw new Inconclusive('app-not-built', 'The captured Host does not qualify Codex ' + version +
        ' on ' + process.platform + '-' + process.arch + '. Select an already qualified native target; no allocation ran.');
    }
  }
  if (vendor === 'codex' && purpose === 'suggestions' && !versionAtLeast(version, MIN_CODEX_VERSION))
    throw new Inconclusive(
      'binary-too-old',
      `codex ${version} cannot sample next prompts, need >= ${MIN_CODEX_VERSION} (set REAL_CODEX_BIN)`
    );
  await assertLoggedIn(vendor, found, {
    PATH: '/usr/bin:/bin',
    HOME: homedir(),
    USER: process.env.USER ?? '',
    LOGNAME: process.env.USER ?? '',
    ...(vendor === 'codex' ? { CODEX_HOME: codexHome() } : {}),
  });
  const authSource = vendor === 'codex' ? join(codexHome(), 'auth.json') : undefined;
  if (authSource) {
    try {
      await access(authSource, constants.R_OK);
    } catch {
      throw new Inconclusive('not-logged-in', `${authSource} is missing; run \`codex login\``);
    }
  }
  return {
    vendor,
    binary: found,
    sha256: await fileHash(found),
    version,
    model:
      process.env[vendor === 'claude' ? 'REAL_CLAUDE_MODEL' : 'REAL_CODEX_MODEL'] ??
      (vendor === 'claude'
        ? DEFAULT_CLAUDE_MODEL
        : ((await configuredCodexModel()) ?? DEFAULT_CODEX_MODEL)),
    ...(authSource ? { authSource } : {}),
  };
}

/** Vendor stderr/diagnostics that mean "account or service", not "our contract is broken". */
export function classifyVendorFailure(text: string): Inconclusive | undefined {
  if (/usage limit|rate.?limit|quota|insufficient credits|try again at/iu.test(text))
    return new Inconclusive(
      'usage-limit',
      'vendor usage limit or quota reached; wait for the reset or switch the account'
    );
  if (
    /not logged in|please run \/login|invalid (api key|token)|unauthori[sz]ed|401|refresh token/iu.test(
      text
    )
  )
    return new Inconclusive('not-logged-in', 'vendor rejected the credentials; log in again');
  return undefined;
}
