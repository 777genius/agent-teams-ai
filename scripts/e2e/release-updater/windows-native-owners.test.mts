import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { uniqueWindowsOwners } from './windows-native.mts';
import { observerFailureReceipt } from './windows-observer-receipt.mts';
import { observeInstallerChild, windowsObserverJsonSource } from './windows-ota-observer.mts';
import { selectedWindowsPowerShell, windowsShellTestEnvironment } from './windows-powershell.mts';
import type { WindowsProcess } from './windows-native.mts';
import type { NativeNames } from './windows-ota-observer.mts';

async function actualBulletReceipt() {
  const directory = new URL('./fixtures/', import.meta.url);
  const raw = gunzipSync(
    await readFile(new URL('w9-observer-bullet-invalid-stdout.txt.gz', directory))
  ).toString('utf8');
  assert.equal(
    createHash('sha256').update(raw).digest('hex'),
    '2070334ad30e879de9308c4d2c1348ed467b23537bf00f2d5fbf78a08431e7fb'
  );
  const expected = JSON.parse(
    gunzipSync(await readFile(new URL('w9-observer-bullet-receipt.json.gz', directory))).toString(
      'utf8'
    )
  ) as NativeNames;
  return { raw, expected };
}
void test('actual W9 observer bullet receipt is malformed JSON, not a newline or schema failure', async () => {
  const { raw, expected } = await actualBulletReceipt();
  assert.equal(raw.charCodeAt(1734), 7);
  assert.throws(() => JSON.parse(raw), SyntaxError);
  assert.equal(expected.Error, null);
  assert.equal(expected.Visited, 178);
  assert.equal(expected.Names.filter((name) => name === '\u0007 ').length, 10);
  assert(expected.Names.includes('Download'));
});
void test(
  'selected PS7 observer producer serializes actual UIA bullet names and every control losslessly',
  {
    skip:
      process.platform !== 'win32'
        ? 'Requires selected installed PS7 on disposable GitHub Windows VM'
        : false,
  },
  async () => {
    const { expected } = await actualBulletReceipt();
    const shell = await selectedWindowsPowerShell();
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-updater-windows-json-'));
    try {
      const env = await windowsShellTestEnvironment(root, shell);
      const input = {
        shell,
        value: {
          ...expected,
          Names: [
            ...expected.Names,
            ...Array.from({ length: 32 }, (_, i) => `control:${String.fromCharCode(i)}:end`),
            'quotes:" backslash:\\ newline:\n Unicode:Привіт 😀',
          ],
        },
      };
      const file = path.join(root, 'input.json');
      await writeFile(file, JSON.stringify(input));
      const script = path.join(root, 'serialize.ps1');
      await writeFile(
        script,
        String.raw`
param([string]$InputFile)
$ErrorActionPreference='Stop'
$data=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($InputFile))
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.ToString() -ne $data.shell.version -or $PSHOME -ne $data.shell.psHome -or [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ne $data.shell.executable) { throw 'Selected installed PS7 identity changed' }
$result=$data.value; $result.Names=[string[]]$result.Names
${windowsObserverJsonSource}`
      );
      const result = await promisify(execFile)(
        shell.executable,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-InputFile',
          file,
        ],
        { env, timeout: 20_000, windowsHide: true, maxBuffer: 4_194_304 }
      );
      assert.equal(result.stderr, '');
      assert(
        /^[\x20-\x7e]+$/u.test(result.stdout),
        'Producer must emit encoded JSON without console control characters'
      );
      assert.deepEqual(JSON.parse(result.stdout), input.value);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

const owner: WindowsProcess = {
  pid: 2468,
  parent: 9856,
  executable: 'C:\\TEST-updater-windows-owned\\install\\AgentTeamsAI.exe',
  command: 'TEST-owned-app',
  start: '2026-10-07T10:42:33.6598600Z',
  session: 2,
  sid: 'TEST-owner-SID',
};
void test('initial owner plus scanned alias is signalled only once after the first stop removes its PID', () => {
  const children = [8424, 4112, 9520].map((pid) => ({ ...owner, pid, parent: owner.pid }));
  const discovered = [{ ...owner }, ...children];
  const live = new Set([owner.pid, ...children.map((child) => child.pid)]);
  const signals: number[] = [];
  // Models only the consumer list contract, not native Windows stop acceptance.
  for (const selected of uniqueWindowsOwners([owner, ...discovered])) {
    assert(live.delete(selected.pid), 'A removed PID must never be signalled again');
    signals.push(selected.pid);
  }
  assert.deepEqual(signals, [2468, 8424, 4112, 9520]);
  assert.equal(live.size, 0);
  assert.equal(discovered.length, 4);
});
for (const [field, value] of Object.entries({
  start: '2026-10-07T10:42:33.6598601Z',
  sid: 'OTHER-owner-SID',
  session: 3,
  executable: 'C:\\TEST-updater-windows-other\\install\\AgentTeamsAI.exe',
})) {
  void test(
    'same PID with changed ' + field + ' rejects the entire batch before any signal',
    () => {
      const signals: number[] = [];
      assert.throws(() => {
        for (const selected of uniqueWindowsOwners([owner, { ...owner, [field]: value }])) {
          signals.push(selected.pid);
        }
      }, /Conflicting TEST PID identity/u);
      assert.deepEqual(signals, []);
    }
  );
}
void test('empty owner list stays empty and invalid PIDs fail before preparing a signal', () => {
  assert.deepEqual(uniqueWindowsOwners([]), []);
  assert.throws(() => uniqueWindowsOwners([{ ...owner, pid: 0 }]), /Invalid TEST PID/u);
});
void test('real portable child events retain spawn PID and nonzero exit without adopting missing identity', async () => {
  const records: unknown[] = [];
  const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { env: {}, stdio: 'ignore' });
  const finish = observeInstallerChild(
    child,
    process.execPath,
    {
      processes: () => Promise.resolve([]),
      installerLineage: () =>
        Promise.reject(new Error('Exited child must not be inspected at25seconds')),
    },
    (receipt) => {
      records.push(structuredClone(receipt));
      return Promise.resolve();
    }
  );
  await once(child, 'exit');
  await finish();
  const record = records.at(-1) as {
    qualifying: boolean;
    identity: unknown;
    lineage: unknown;
    closeObserved: boolean;
    events: { event: string; pid?: number; code?: number; signal?: string | null }[];
  };
  assert.equal(record.qualifying, false);
  assert.equal(record.identity, null);
  assert.equal(record.lineage, null);
  assert.equal(record.events.find((event) => event.event === 'spawn')?.pid, child.pid);
  assert.equal(record.events.find((event) => event.event === 'exit')?.code, 7);
  assert.equal(record.events.find((event) => event.event === 'exit')?.signal, null);
  assert.equal(
    record.closeObserved,
    record.events.some((event) => event.event === 'close')
  );
  assert(record.events.some((event) => event.event === 'observation-finalized'));
});
void test('failed portable spawn records the error and never queries an undefined installer PID', async () => {
  const records: unknown[] = [];
  const child = spawn('/TEST-nonexistent-installer-observer', [], { env: {}, stdio: 'ignore' });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error('No spawn means no native query'));
  const finish = observeInstallerChild(
    child,
    '/TEST-nonexistent-installer-observer',
    {
      processes: unavailable,
      installerLineage: unavailable,
    },
    (receipt) => {
      records.push(structuredClone(receipt));
      return Promise.resolve();
    }
  );
  await closed;
  await finish();
  const record = records.at(-1) as {
    identity: unknown;
    diagnosticError: unknown;
    events: { event: string; error?: string }[];
  };
  assert.equal(record.identity, null);
  assert.equal(record.diagnosticError, null);
  assert(!record.events.some((event) => event.event === 'spawn'));
  assert.match(record.events.find((event) => event.event === 'error')?.error ?? '', /ENOENT/u);
});

void test('diagnostic save failure preserves installer exit and allows later receipt saves', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { env: {}, stdio: 'ignore' });
  const records: unknown[] = [];
  let writes = 0;
  const finish = observeInstallerChild(
    child,
    process.execPath,
    {
      processes: () => Promise.resolve([]),
      installerLineage: () => Promise.reject(new Error('Exited child must not be inspected')),
    },
    (receipt) => {
      if (++writes === 1) return Promise.reject(new Error('TEST receipt first write failed'));
      records.push(structuredClone(receipt));
      return Promise.resolve();
    }
  );
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  await finish();
  assert.equal(code, 7);
  const final = records.at(-1) as {
    persistenceError: string;
    events: { event: string; code?: number }[];
  };
  assert.match(final.persistenceError, /TEST receipt first write failed/u);
  assert.equal(final.events.find((event) => event.event === 'exit')?.code, 7);
  assert(final.events.some((event) => event.event === 'observation-finalized'));
  assert(writes > 1);
});

void test('malformed observer JSON preserves every control character and parse failure in its receipt', () => {
  for (let code = 0; code < 32; code++) {
    const stdout = `{"Names":["before${String.fromCharCode(code)}after"]}\r\n`;
    let parseError: unknown;
    try {
      JSON.parse(stdout.trim());
    } catch (error) {
      parseError = error;
    }
    assert(parseError instanceof SyntaxError);
    const completed = { stdout, stderr: 'TEST diagnostic stderr\r\n' };
    const receipt = observerFailureReceipt(parseError, 'json-parse', completed);
    // The persisted JSON must round-trip raw evidence; never repair the malformed payload.
    const persisted = JSON.parse(JSON.stringify(receipt)) as typeof receipt;
    assert.equal(persisted.stdout, stdout);
    assert.equal(persisted.stderr, completed.stderr);
    assert.equal(persisted.phase, 'json-parse');
    assert.equal(persisted.error, String(parseError));
    assert.throws(() => JSON.parse(persisted.stdout!), SyntaxError);
  }
});

void test('observer execution failure retains child output and termination metadata', () => {
  const error = Object.assign(new Error('TEST observer timed out'), {
    stdout: 'TEST partial stdout\r\n',
    stderr: 'TEST partial stderr\r\n',
    code: 'ETIMEDOUT',
    signal: 'SIGTERM',
    killed: true,
  });
  assert.deepEqual(observerFailureReceipt(error, 'execution'), {
    phase: 'execution',
    error: String(error),
    stdout: error.stdout,
    stderr: error.stderr,
    code: error.code,
    signal: error.signal,
    killed: error.killed,
  });
});

void test('observer receipt persistence failure retains successfully completed transport output', () => {
  const error = new Error('TEST receipt persistence failed');
  const completed = { stdout: '{"Names":["TEST"]}\r\n', stderr: '' };
  const receipt = observerFailureReceipt(error, 'receipt', completed);
  assert.equal(receipt.phase, 'receipt');
  assert.equal(receipt.stdout, completed.stdout);
  assert.equal(receipt.stderr, '');
});
