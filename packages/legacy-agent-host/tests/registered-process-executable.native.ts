import assert from 'node:assert/strict';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { assertNativeV1Build, assertNativeV1Source, buildNativeV1Host } from './opencode-v1-version-source.ts';
import type { ObservableNativeProcess } from '../dist/owned-process/processFacade.js';

const candidateBuild = process.env.OPENCODE_V2_EMBEDDED_DARWIN_CANDIDATE_BUILD;
if (candidateBuild) {
  assert.equal(process.env.OPENCODE_V2_EMBEDDED_DARWIN_CUSTODY_GO, '1');
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, process.env.OPENCODE_V2_EMBEDDED_DARWIN_CANDIDATE_ARCH);
  assert.match(candidateBuild, /^\d{2}[A-Z]\d{2,5}$/);
  assert.equal(
    execFileSync('/usr/sbin/sysctl', ['-n', 'kern.osversion'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim(),
    candidateBuild
  );
  // Only this isolated Node test worker admits the exact prospective tuple.
  // Native addon calls, original-child capture and physical cleanup stay real.
  mock.module('../dist/process/qualifiedDarwinBuild.js', {
    namedExports: { isQualifiedDarwinBuild: (value: unknown) => value === candidateBuild },
  });
}

const digest = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

function readReady(child: ObservableNativeProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const done = (error?: Error) => {
      clearTimeout(timer);
      child.stdout.off('data', output);
      child.off('exit', exited);
      child.off('error', failed);
      if (error) reject(error);
      else resolve();
    };
    const failed = () => done(new Error('Original TEST Bun startup failed'));
    const exited = () => failed();
    const output = (part: Buffer) => {
      bytes = Buffer.concat([bytes, part]);
      if (bytes.length > 1024) return failed();
      if (!bytes.includes(10)) return;
      try {
        const ready = JSON.parse(bytes.toString('utf8').trim());
        assert.deepEqual(ready, { pid: child.pid, version: '1.4.4' });
        done();
      } catch {
        failed();
      }
    };
    const timer = setTimeout(failed, 15_000);
    child.stdout.on('data', output);
    child.once('exit', exited);
    child.once('error', failed);
  });
}

test(
  'Darwin audit-bound executable measurement rejects replacement and preserves sibling custody',
  {
    timeout: 120_000,
    skip: process.env.OPENCODE_V2_EMBEDDED_DARWIN_CUSTODY_GO !== '1',
  },
  async () => {
    assert.equal(process.platform, 'darwin');
    assert.ok(['arm64', 'x64'].includes(process.arch));
    assert.equal(process.version, 'v24.21.0');
    const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
    const repo = join(import.meta.dirname, '../../..');
    const hostBuild = await buildNativeV1Host(repo, sourceHead);
    const { CapturedProcess } = await import('../dist/adapters/providers/CapturedProcess.js');
    const { createProcessCustody } = await import('../dist/composition/processCustody.js');
    const bun = await realpath(process.env.OPENCODE_V2_EMBEDDED_BUN!);
    const bunSha256 = process.env.OPENCODE_V2_EMBEDDED_BUN_SHA256!;
    assert.match(bunSha256, /^[a-f0-9]{64}$/);
    assert.equal(await digest(bun), bunSha256);
    const processCustody = createProcessCustody({
      directory: process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_DIRECTORY!,
      manifestSha256: process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_MANIFEST_SHA256!,
    })!;
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-darwin-executable-')));
    const owned: {
      custody: InstanceType<typeof CapturedProcess>;
      child: ChildProcess & ObservableNativeProcess;
    }[] = [];
    let failure: unknown,
      cleanup = false;
    const evidence: Record<string, unknown> = {
      kind: candidateBuild ? 'TEST_DARWIN_CUSTODY_CANDIDATE' : 'TEST_DARWIN_CUSTODY_PRODUCT_PATH',
      sourceHead,
      hostBuild,
      platform: process.platform,
      arch: process.arch,
      osBuild:
        candidateBuild ??
        execFileSync('/usr/sbin/sysctl', ['-n', 'kern.osversion'], {
          encoding: 'utf8',
          timeout: 5000,
        }).trim(),
      productQualified: false,
      bunSha256,
      processArtifactManifestSha256:
        process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_MANIFEST_SHA256,
    };
    try {
      await mkdir(join(root, 'home'));
      const selectedPath = join(root, 'bun');
      await copyFile(bun, selectedPath);
      await chmod(selectedPath, 0o700);
      const start = (executable: { path: string; sha256: string }) => {
        const custody = new CapturedProcess(
          {
            provider: 'opencode',
            executable,
            cwd: root,
            environment: { HOME: join(root, 'home'), PATH: '/usr/bin:/bin', NO_COLOR: '1' },
          },
          () => true,
          processCustody
        );
        const child = custody.launch({
          command: executable.path,
          cwd: root,
          args: [
            '--no-env-file',
            '--config=/dev/null',
            '--no-install',
            '-e',
            "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setTimeout(()=>process.exit(1),60000).unref();process.stdout.write(JSON.stringify({pid:process.pid,version:Bun.version})+'\\n');",
          ],
        });
        assert.ok(child instanceof ChildProcess, 'Darwin native capture requires the actual Node child');
        child.stdin.on('error', () => {});
        const row = { custody, child };
        owned.push(row);
        return row;
      };
      const selected = { path: selectedPath, sha256: bunSha256 };
      const target = start(selected),
        sibling = start({ path: bun, sha256: bunSha256 });
      await Promise.all([readReady(target.child), readReady(sibling.child)]);
      const before = processCustody.readRootExecutable(target.child, selected);
      const neighbor = processCustody.readRootExecutable(sibling.child, {
        path: bun,
        sha256: bunSha256,
      });
      assert.equal(before.pid, target.child.pid);
      assert.equal(before.executablePath, selectedPath);
      assert.equal(before.executableSha256, bunSha256);
      assert.notEqual(before.startIdentity, neighbor.startIdentity);
      evidence.original = before;
      evidence.sibling = neighbor;
      const forged = new ChildProcess();
      Object.defineProperty(forged, 'pid', { value: target.child.pid });
      assert.throws(() => processCustody.readRootExecutable(forged, selected));
      await rename(selectedPath, join(root, 'original-running-bun'));
      await copyFile(process.execPath, selectedPath);
      await chmod(selectedPath, 0o700);
      assert.throws(
        () => processCustody.readRootExecutable(target.child, selected),
        'a valid signed replacement file cannot attest the still-running original image'
      );
      target.child.stdin.end();
      assert.equal(await target.custody.confirmStopped(), true);
      assert.throws(() => processCustody.readRootExecutable(target.child, selected));
      assert.deepEqual(
        processCustody.readRootExecutable(sibling.child, { path: bun, sha256: bunSha256 }),
        neighbor
      );
      evidence.replacementRefused = true;
      evidence.siblingSurvivedTargetStop = true;
      await assertNativeV1Build(repo, sourceHead, hostBuild);
    } catch (error) {
      failure = error;
    } finally {
      const results = await Promise.all(
        owned.map(async ({ child, custody }) => {
          if (!child.stdin.destroyed) child.stdin.end();
          return custody.confirmStopped().catch(() => false);
        })
      );
      cleanup = results.length > 0 && results.every(Boolean);
      if (!cleanup)
        for (const { child } of owned) {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
        }
      if (cleanup)
        await rm(root, { recursive: true, force: true }).catch((error) => {
          failure ??= error;
        });
      evidence.cleanup = cleanup ? 'confirmed' : 'unknown';
      evidence.status = !failure && cleanup ? 'PASS' : 'HOLD';
      const receipt = process.env.OPENCODE_V2_EMBEDDED_DARWIN_CUSTODY_RECEIPT;
      if (receipt)
        await writeFile(receipt, JSON.stringify(evidence, null, 2) + '\n', {
          mode: 0o600,
          flag: 'wx',
        }).catch((error) => {
          failure ??= error;
        });
    }
    if (failure) throw failure;
    assert.equal(cleanup, true, 'only physical owned process cleanup qualifies this native proof');
  }
);

type PosixExecObservation = {
  stage: string;
  errno: number;
  execErrno: number;
  stoppedBeforeUser: boolean;
  payloadMarkersAbsentBeforeGate: boolean;
  kernelImageObserved: boolean;
  imageMatched: boolean;
  resumed: boolean;
  mutationAfterCheckErrno: number;
  codeSigningFlags: number;
  originalPid: number;
  originalBirth: string;
  originalDev: string;
  originalIno: string;
  kernelDev: string;
  kernelIno: string;
  originalSha256: string;
  kernelSha256: string;
  exitCode: number;
  exitSignal: number;
  originalReaped: boolean;
  originalGroupAbsent: boolean;
  cleanup: boolean;
};

function readPosixExecObservation(bytes: string): PosixExecObservation {
  assert.ok(Buffer.byteLength(bytes) < 4096);
  const value: unknown = JSON.parse(bytes);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  const booleans = ['stoppedBeforeUser', 'payloadMarkersAbsentBeforeGate', 'kernelImageObserved',
    'imageMatched', 'resumed', 'originalReaped', 'originalGroupAbsent', 'cleanup'];
  const numbers = ['errno', 'execErrno', 'mutationAfterCheckErrno', 'codeSigningFlags',
    'originalPid', 'exitCode', 'exitSignal'];
  const identities = ['originalBirth', 'originalDev', 'originalIno', 'kernelDev', 'kernelIno'];
  const hashes = ['originalSha256', 'kernelSha256'];
  assert.deepEqual(Object.keys(row).sort(), ['stage', ...booleans, ...numbers, ...identities, ...hashes].sort());
  for (const key of booleans) assert.equal(typeof row[key], 'boolean');
  for (const key of numbers) assert.ok(Number.isSafeInteger(row[key]) && Number(row[key]) >= -1);
  for (const key of identities) { assert.equal(typeof row[key], 'string'); assert.match(String(row[key]), /^\d{1,20}$/); }
  for (const key of hashes) { assert.equal(typeof row[key], 'string'); assert.match(String(row[key]), /^(?:[a-f0-9]{64})?$/); }
  assert.ok(['capture', 'pre-exec-mutation', 'spawn', 'spawn-suspended', 'trace-initial',
    'trace-exec', 'plain-exit', 'original-identity', 'kernel-image', 'rejected-image',
    'resume', 'exit'].includes(String(row.stage)));
  return value as PosixExecObservation;
}

/** The controller retains/reaps its direct children. Node retains only this original controller. */
function runPosixExecActor(file: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number;
}): Promise<{ stdout: string; code: number | null; signal: NodeJS.Signals | null; interrupted: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', bytes = 0, interrupted = false, escalation: NodeJS.Timeout | undefined;
    const stop = () => {
      if (interrupted) return;
      interrupted = true;
      child.kill('SIGTERM');
      // The TEST controller first kills/reaps its original children; never adopt their numeric PIDs here.
      escalation = setTimeout(() => child.kill('SIGKILL'), 4000);
    };
    const timer = setTimeout(stop, options.timeoutMs);
    options.signal.addEventListener('abort', stop, { once: true });
    if (options.signal.aborted) stop();
    child.stdout.on('data', (part: Buffer) => {
      bytes += part.length;
      if (bytes > 8192) stop();
      else stdout += part.toString('utf8');
    });
    child.stderr.on('data', (part: Buffer) => { bytes += part.length; if (bytes > 8192) stop(); });
    const retire = () => {
      clearTimeout(timer); clearTimeout(escalation);
      options.signal.removeEventListener('abort', stop);
    };
    child.once('error', error => { retire(); reject(error); });
    child.once('close', (code, signal) => { retire(); resolve({ stdout, code, signal, interrupted }); });
  });
}

test('POSIX original-path pre-user image gate keeps explicit mutation counterexamples', {
  timeout: 120_000,
  skip: process.env.OPENCODE_V2_POSIX_EXEC_GO !== '1',
}, async t => {
  assert.ok(process.platform === 'linux' || process.platform === 'darwin');
  assert.equal(process.version, 'v24.21.0');
  const repo = join(import.meta.dirname, '../../..');
  const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
  assertNativeV1Source(repo, sourceHead);
  const source = join(import.meta.dirname, 'fixtures/posix-exec-native.c');
  const sourceSha256 = await digest(source);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-posix-native-exec-')));
  const deadline = performance.now() + 100_000;
  const remaining = () => {
    assert.equal(t.signal.aborted, false, 'original TEST deadline remains current');
    const value = Math.floor(deadline - performance.now());
    assert.ok(value > 4000, 'original TEST budget leaves time for owned cleanup');
    return Math.min(20_000, value - 4000);
  };
  const env = { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), TMPDIR: root,
    TEST_POSIX_VALUE: 'TEST_EXACT_ENV' };
  const compiler = await realpath('/usr/bin/cc');
  const hashTool = process.platform === 'linux' ? '/usr/bin/sha256sum' : '/usr/bin/shasum';
  const toolsBefore = { compiler: await digest(compiler), hashTool: await digest(hashTool),
    node: await digest(process.execPath) };
  const observations: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown> = {
    kind: 'TEST_POSIX_PRE_USER_EXEC_IMAGE', sourceHead, sourceSha256,
    platform: process.platform, arch: process.arch, nodeVersion: process.version,
    osBuild: process.platform === 'darwin'
      ? execFileSync('/usr/sbin/sysctl', ['-n', 'kern.osversion'], { encoding: 'utf8', timeout: 5000 }).trim()
      : execFileSync('/usr/bin/uname', ['-r'], { encoding: 'utf8', timeout: 5000 }).trim(),
    tools: toolsBefore, observations, productQualified: false, installedRuntimeQualified: false,
    customExecutableQualified: false, scriptQualified: false,
  };
  let failure: unknown, cleanup = true, nativeQualified = true;
  let actorFailure: Record<string, unknown> | undefined;
  try {
    await mkdir(env.HOME, { mode: 0o700 });
    const controller = join(root, 'controller');
    const compile = (args: string[]) => execFileSync(compiler, args, {
      cwd: root, env, timeout: Math.min(15_000, remaining()), maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const flags = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2'];
    compile([...flags, source, '-o', controller,
      ...(process.platform === 'darwin' ? ['-framework', 'Security', '-framework', 'CoreFoundation'] : [])]);
    const defaults = join(root, 'compiler-default');
    await mkdir(defaults, { mode: 0o700 });
    const libraryName = process.platform === 'darwin' ? 'libTESTsibling.dylib' : 'libTESTsibling.so';
    compile([...flags, '-DTEST_LIBRARY', source, '-o', join(defaults, libraryName),
      ...(process.platform === 'darwin'
        ? ['-dynamiclib', '-Wl,-install_name,@rpath/libTESTsibling.dylib'] : ['-shared', '-fPIC'])]);
    for (const tag of ['A', 'B']) compile([...flags, `-DTEST_PAYLOAD_TAG="${tag}"`, source,
      '-L', defaults, '-lTESTsibling',
      process.platform === 'darwin' ? '-Wl,-rpath,@executable_path' : '-Wl,-rpath,$ORIGIN',
      '-o', join(defaults, tag)]);
    const variants: { name: string; directory: string; modes: string[] }[] = [
      { name: 'compiler-default', directory: defaults,
        modes: process.platform === 'darwin' ? ['plain', 'baseline']
          : ['plain', 'baseline', 'rename', 'inplace', 'after-check', 'writer-open'] },
    ];
    if (process.platform === 'darwin') {
      const signed = join(root, 'adhoc-test-only');
      await mkdir(signed, { mode: 0o700 });
      const signer = '/usr/bin/codesign';
      const signerSha256 = await digest(signer);
      for (const name of [libraryName, 'A', 'B']) {
        const destination = join(signed, name);
        await copyFile(join(defaults, name), destination);
        execFileSync(signer, ['--force', '--sign', '-', destination], {
          cwd: root, env, timeout: Math.min(15_000, remaining()), maxBuffer: 64 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
      assert.equal(await digest(signer), signerSha256);
      evidence.adhocSignerSha256 = signerSha256;
      variants.push({ name: 'adhoc-test-only', directory: signed,
        modes: ['plain', 'baseline', 'rename', 'inplace', 'after-check', 'writer-open'] });
    }
    const pins = [controller, ...variants.flatMap(variant =>
      [libraryName, 'A', 'B'].map(name => join(variant.directory, name)))];
    const pinHashes = await Promise.all(pins.map(digest));
    evidence.binaryDigests = Object.fromEntries(pins.map((path, index) =>
      [path.slice(root.length + 1), pinHashes[index]]));
    const script = (tag: string) => `#!/bin/sh\nprintf 'SCRIPT:${tag}\\n' >> "$TEST_POSIX_MARKER"\n` +
      `IFS= read -r asset < "\${0%/*}/payload-root.txt"\n` +
      `printf 'tag=${tag}\\nargv0=%s\\narg1=%s\\narg2=%s\\nenv=%s\\n' "$0" "$1" "$2" "$TEST_POSIX_VALUE"\n` +
      `printf 'cwd='; pwd\nprintf 'asset=%s\\n' "$asset"\n`;
    const cases = [
      ...variants.flatMap(variant => variant.modes.map(mode => ({ variant, mode, script: false }))),
      ...['plain', 'script-negative'].map(mode => ({ variant: variants[0]!, mode, script: true })),
    ];
    for (const item of cases) {
      const label = `${item.script ? 'script' : item.variant.name}:${item.mode}`;
      const directory = join(root, `case-${observations.length}`);
      await mkdir(directory, { mode: 0o700 });
      const selected = join(directory, 'selected'), replacement = join(directory, 'replacement');
      const marker = join(directory, 'markers'), output = join(directory, 'output');
      await writeFile(join(directory, 'payload-root.txt'), 'TEST_SIBLING_ASSET\n', { flag: 'wx', mode: 0o600 });
      if (item.script) {
        await writeFile(selected, script('A'), { flag: 'wx', mode: 0o700 });
        await writeFile(replacement, script('B'), { flag: 'wx', mode: 0o700 });
      } else {
        await copyFile(join(item.variant.directory, 'A'), selected);
        await copyFile(join(item.variant.directory, 'B'), replacement);
        await copyFile(join(item.variant.directory, libraryName), join(directory, libraryName));
        await chmod(selected, 0o700); await chmod(replacement, 0o700);
      }
      const expected = await digest(selected), replacementHash = await digest(replacement);
      let result: Awaited<ReturnType<typeof runPosixExecActor>>, fact: PosixExecObservation;
      try {
        result = await runPosixExecActor(controller,
          [item.mode, selected, replacement, expected, marker, output, directory],
          { cwd: root, env: { ...env, TEST_POSIX_MARKER: marker }, signal: t.signal, timeoutMs: remaining() });
        fact = readPosixExecObservation(result.stdout);
      } catch (error) { cleanup = false; throw error; }
      cleanup = cleanup && fact.cleanup;
      const readOutput = async (path: string) => {
        try { assert.ok((await lstat(path)).size <= 8192); return await readFile(path, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
      };
      const markers = await readOutput(marker), text = await readOutput(output);
      const markerLines = markers.trim().split('\n').filter(Boolean);
      assert.ok(markerLines.length <= 8 && markerLines.every(line =>
        ['LIB', 'BIN:A', 'BIN:B', 'MAIN:A', 'MAIN:B', 'SCRIPT:A', 'SCRIPT:B'].includes(line)));
      const observation = { label, expectedSha256: expected, replacementSha256: replacementHash,
        ...fact, markerLines,
        outputBytes: Buffer.byteLength(text), outputSha256: createHash('sha256').update(text).digest('hex'),
        controllerInterrupted: result.interrupted, result: 'INCOMPLETE' };
      observations.push(observation);
      assert.ok(fact.cleanup && result.code === 0 && result.signal === null && !result.interrupted,
        'original actor and all original selected children must complete cleanup');
      const outputMatches = (tag: string) => {
        const pairs = text.trim().split('\n').filter(Boolean).map(line => {
          const at = line.indexOf('='); assert.ok(at > 0); return [line.slice(0, at), line.slice(at + 1)];
        });
        assert.equal(new Set(pairs.map(pair => pair[0])).size, pairs.length);
        assert.deepEqual(Object.fromEntries(pairs), {
          tag, argv0: selected, arg1: '--version', arg2: 'TEST argument with spaces',
          env: 'TEST_EXACT_ENV', cwd: directory, asset: 'TEST_SIBLING_ASSET',
          ...(!item.script ? { shared: '17', ...(process.platform === 'linux' ? { execfn: selected } : {}) } : {}),
        });
      };
      try {
        assert.equal(fact.originalSha256, expected);
        if (item.mode === 'plain') {
          assert.equal(fact.errno, 0); assert.equal(fact.exitCode, 0); outputMatches('A');
          assert.equal(markers, item.script ? 'SCRIPT:A\n' : 'LIB\nBIN:A\nMAIN:A\n');
        } else if (item.mode === 'writer-open' && process.platform === 'linux') {
          assert.equal(fact.execErrno, constants.errno.ETXTBSY);
          assert.equal(fact.resumed, false); assert.equal(markers, '');
        } else {
          assert.equal(fact.errno, 0);
          assert.ok(fact.stoppedBeforeUser && fact.payloadMarkersAbsentBeforeGate && fact.kernelImageObserved);
          assert.ok(fact.originalPid > 1 && fact.originalBirth !== '0');
          if (item.mode === 'rename' || item.mode === 'inplace') {
            assert.equal(fact.imageMatched, false); assert.equal(fact.resumed, false);
            assert.equal(markers, ''); assert.equal(fact.kernelSha256, replacementHash);
            assert.equal(fact.originalIno === fact.kernelIno, item.mode === 'inplace');
          } else if (item.script) {
            assert.equal(fact.imageMatched, false, 'interpreter identity cannot validate script bytes');
            assert.notEqual(fact.kernelSha256, expected); assert.equal(fact.mutationAfterCheckErrno, 0);
            assert.equal(fact.exitCode, 0); assert.equal(markers, 'SCRIPT:B\n'); outputMatches('B');
          } else {
            assert.equal(fact.imageMatched, true); assert.equal(fact.originalIno, fact.kernelIno);
            assert.equal(fact.originalDev, fact.kernelDev); assert.equal(fact.kernelSha256, expected);
            if (item.mode === 'after-check' || item.mode === 'writer-open') {
              if (fact.mutationAfterCheckErrno === constants.errno.ETXTBSY) {
                assert.equal(fact.exitCode, 0); outputMatches('A');
                assert.equal(markers, 'LIB\nBIN:A\nMAIN:A\n');
              } else {
                assert.equal(fact.mutationAfterCheckErrno, 0);
                assert.equal(markers, '', 'no selected library or payload constructor may run after byte mutation');
                assert.equal(fact.exitCode, -1); assert.ok(fact.exitSignal > 0);
              }
            } else {
              assert.equal(fact.exitCode, 0); outputMatches('A');
              assert.equal(markers, 'LIB\nBIN:A\nMAIN:A\n');
            }
          }
        }
        observation.result = item.script && item.mode === 'script-negative' ? 'COUNTEREXAMPLE' : 'PASS';
      } catch (error) {
        const firstFailure = failure === undefined || failure === null;
        failure ??= error;
        if (!item.script) nativeQualified = false;
        if (firstFailure) {
          try {
            // Case labels are local finite constants; fact/markers passed the original closed decoder.
            if (/^[a-f0-9]{40}$/.test(sourceHead) && ['x64', 'arm64'].includes(process.arch))
              actorFailure = {
                kind: 'TEST_POSIX_EXEC_FAILURE', sourceHead, platform: process.platform, arch: process.arch,
                label, stage: fact.stage, errno: fact.errno, execErrno: fact.execErrno,
                mutationAfterCheckErrno: fact.mutationAfterCheckErrno,
                stoppedBeforeUser: fact.stoppedBeforeUser,
                payloadMarkersAbsentBeforeGate: fact.payloadMarkersAbsentBeforeGate,
                kernelImageObserved: fact.kernelImageObserved, imageMatched: fact.imageMatched,
                resumed: fact.resumed, actorCleanup: fact.cleanup, markerLines: [...markerLines],
                exitCode: fact.exitCode, exitSignal: fact.exitSignal, controllerInterrupted: result.interrupted,
              };
          } catch { /* Diagnostic projection cannot replace the first original assertion failure. */ }
        }
        // Retain every bounded original observation; a failed primitive never becomes a skipped PASS.
      }
    }
    assert.equal(await digest(source), sourceSha256);
    assert.deepEqual(await Promise.all(pins.map(digest)), pinHashes);
    assert.deepEqual({ compiler: await digest(compiler), hashTool: await digest(hashTool),
      node: await digest(process.execPath) }, toolsBefore);
    assertNativeV1Source(repo, sourceHead);
  } catch (error) { failure ??= error; }
  finally {
    if (cleanup) await rm(root, { recursive: true, force: true }).catch(error => { failure ??= error; cleanup = false; });
    Object.assign(evidence, { cleanup, nativeFixtureQualified: nativeQualified && !failure,
      status: !failure && cleanup ? 'PASS_NATIVE_FIXTURE_ONLY' : 'INCOMPLETE' });
    const receipt = process.env.OPENCODE_V2_POSIX_EXEC_RECEIPT;
    assert.ok(receipt, 'explicit TEST receipt path is required');
    const serialized = JSON.stringify(evidence, null, 2) + '\n';
    assert.ok(Buffer.byteLength(serialized) <= 64 * 1024);
    await writeFile(receipt, serialized, { mode: 0o600, flag: 'wx' });
  }
  if (actorFailure) {
    try {
      const line = JSON.stringify({ ...actorFailure, cleanup }) + '\n';
      if (Buffer.byteLength(line) <= 2048) process.stdout.write(line);
    } catch { /* Original cleanup, receipt-write and assertion failure precedence stays unchanged. */ }
  }
  if (failure) throw failure;
  assert.equal(cleanup, true);
});
