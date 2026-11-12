import assert from 'node:assert/strict';
import { ChildProcess, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

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
const { CapturedProcess } = await import('../dist/adapters/providers/CapturedProcess.js');
const { createProcessCustody } = await import('../dist/composition/processCustody.js');

const digest = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

function readReady(child: ChildProcessWithoutNullStreams): Promise<void> {
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
      child: ChildProcessWithoutNullStreams;
    }[] = [];
    let failure: unknown,
      cleanup = false;
    const evidence: Record<string, unknown> = {
      kind: candidateBuild ? 'TEST_DARWIN_CUSTODY_CANDIDATE' : 'TEST_DARWIN_CUSTODY_PRODUCT_PATH',
      sourceHead: process.env.OPENCODE_V2_TEST_SOURCE_HEAD,
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
      if (cleanup)
        await rm(root, { recursive: true, force: true }).catch((error) => {
          failure ??= error;
        });
    }
    if (failure) throw failure;
    assert.equal(cleanup, true, 'only physical owned process cleanup qualifies this native proof');
  }
);
