import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { hashFile } from './inputs.mts';
import { captureNativeWindow, processIdentity } from './native-window.mts';

export interface SandboxSample {
  stage: string;
  command: string[];
  noSandbox: boolean;
}
const execute = promisify(execFile);

export async function wrapperProvenance(
  stage: string,
  executable: string,
  command: string[],
  output: string,
  evidence: Record<string, unknown>,
  sandboxSamples: SandboxSample[]
) {
  const appRun = path.join(path.dirname(executable), 'AppRun');
  const bytes = await readFile(appRun);
  const source = bytes.toString('utf8');
  const saved = path.join(output, `${stage}-AppRun.txt`);
  await writeFile(saved, bytes);
  const noSandbox = command.some((argument) => /^--no-sandbox(?:=|$)/.test(argument));
  sandboxSamples.push({ stage, command, noSandbox });
  evidence.sandboxEnabled = sandboxSamples.every((sample) => !sample.noSandbox);
  evidence.sandbox = {
    harnessRequestedNoSandbox: false,
    canonicalGatePassed: evidence.sandboxEnabled,
    samples: sandboxSamples,
    limitation: sandboxSamples.some((sample) => sample.noSandbox)
      ? 'Official AppRun supplied --no-sandbox; native installation facts do not pass the canonical sandbox gate'
      : undefined,
  };
  return {
    path: appRun,
    saved,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    relevantLines: source.split('\n').filter((line) => /unshare|NO_SANDBOX|no-sandbox/.test(line)),
  };
}

export async function automaticDesktop(
  owner: NonNullable<Awaited<ReturnType<typeof processIdentity>>>,
  directory: string,
  evidence: Record<string, unknown>
) {
  const deadline = Date.now() + 45_000;
  const env = {
    PATH: '/usr/bin:/bin',
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
    LC_ALL: 'C',
    OMP_THREAD_LIMIT: '1',
  };
  const run = (command: string, parameters: string[]) => {
    assert(Date.now() < deadline, 'Automatic desktop did not paint within 45 seconds');
    const started = Date.now();
    return execute(command, parameters, {
      env,
      timeout: Math.min(10_000, deadline - Date.now()),
      maxBuffer: 1_048_576,
    }).catch((error: unknown) => {
      const failure = error as Error & {
        code?: string | number;
        killed?: boolean;
        signal?: string;
        stdout?: string;
        stderr?: string;
      };
      evidence.nativeToolFailure = {
        command,
        parameters,
        elapsedMs: Date.now() - started,
        code: failure.code,
        killed: failure.killed,
        signal: failure.signal,
        stdout: failure.stdout,
        stderr: failure.stderr,
      };
      throw error;
    });
  };
  const native = await captureNativeWindow(owner, directory);
  const attempts: Record<string, unknown>[] = [];
  evidence.automaticDesktop = { ready: false, timeoutMs: 45_000, attempts };
  while (Date.now() < deadline) {
    const identity = await processIdentity(owner.pid);
    assert.equal(identity?.start, owner.start, 'Automatic desktop PID changed');
    assert.equal(identity?.group, owner.group, 'Automatic desktop group changed');
    const { stdout: property } = await run('/usr/bin/xprop', ['-id', native.id, '_NET_WM_PID']);
    assert.equal(
      Number(/=\s*(\d+)/.exec(property)?.[1]),
      native.identity.pid,
      'Native window owner changed'
    );
    const { stdout: info } = await run('/usr/bin/xwininfo', ['-id', native.id, '-stats']);
    assert(/Map State:\s*IsViewable/.test(info), 'Automatic native window is hidden');
    const name = `attempt-${String(attempts.length + 1).padStart(3, '0')}`;
    const screenshot = path.join(directory, `${name}.png`);
    await run('/usr/bin/import', ['-window', native.id, screenshot]);
    const { stdout, stderr } = await run('/usr/bin/tesseract', [
      screenshot,
      'stdout',
      '--psm',
      '11',
    ]);
    const ocr = path.join(directory, `${name}.ocr.txt`);
    await writeFile(ocr, stdout);
    await writeFile(path.join(directory, `${name}.ocr.stderr.txt`), stderr);
    const image = await hashFile(screenshot);
    const current = await processIdentity(owner.pid);
    assert.equal(current?.start, owner.start, 'Automatic desktop PID changed during capture');
    assert.equal(current?.group, owner.group);
    const ready =
      /Providers\s*&\s*plans/i.test(stdout) &&
      /\bTasks\b/.test(stdout) &&
      !/Preparing\s+workspace|splash/i.test(stdout);
    attempts.push({
      capturedAt: new Date().toISOString(),
      screenshot,
      sha256: image.sha256,
      ocr,
      ocrSha256: createHash('sha256').update(stdout).digest('hex'),
      stdout,
      stderr,
      ready,
    });
    if (ready) {
      assert(Date.now() <= deadline, 'Automatic desktop did not paint within 45 seconds');
      evidence.automaticDesktop = { ready: true, timeoutMs: 45_000, attempts };
      await copyFile(screenshot, native.screenshot);
      return { ...native, identity: current, property, info, sha256: image.sha256, ocr };
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now())))
    );
  }
  throw new Error(
    'Automatic desktop did not show Providers & plans and Tasks without Preparing workspace within 45 seconds'
  );
}
