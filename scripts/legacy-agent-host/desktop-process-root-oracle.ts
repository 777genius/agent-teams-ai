import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProcessNativeArtifact } from '../../packages/legacy-agent-host/dist/process/loadProcessNativeArtifact.js';
import { readPackagedLinuxProcessArtifact } from '../../packages/legacy-agent-host/dist/process/readPackagedProcessArtifact.js';
import { validateProcessCapture } from '../../packages/legacy-agent-host/dist/process/validateProcessRecords.js';
import type { PackagedProcessArtifactSelection } from '../../packages/legacy-agent-host/dist/process/readPackagedProcessArtifact.js';
import type { LinuxProcessIdentity, ProcessObservation, RegisteredProcessCapture }
  from '../../packages/legacy-agent-host/dist/process/registeredProcessContracts.js';

/** Read-only TEST actor: the existing native loader remains single-load in each Node process. */
export function createDesktopProcessRootOracle(input: {
  node: string;
  capture: RegisteredProcessCapture;
  selection: PackagedProcessArtifactSelection;
  observe(capture: RegisteredProcessCapture): ProcessObservation;
}) {
  validateProcessCapture(input.capture);
  const original = structuredClone(input.capture);
  assert.ok(original.version !== 4 && original.version !== 5, 'Cold POSIX original-root oracle requires durable kernel identity');
  const rootCapture: RegisteredProcessCapture | undefined = original.version === 3 ? undefined
    : { ...original, target: structuredClone(original.root) };
  const args = [import.meta.filename, '--observe-linux-root', JSON.stringify(input.selection), JSON.stringify(original)];
  let reads = 0;
  return {
    rootCapture,
    rootIdentity: original.root,
    observe(deadlineMs: number): ProcessObservation {
      const remaining = Math.floor(deadlineMs - Date.now());
      assert.ok(Number.isFinite(deadlineMs) && ++reads <= 12 && remaining > 0,
        'bounded original-root oracle; original caller deadline and no busy spawn loop');
      const output = rootCapture ? input.observe(rootCapture)
        : execFileSync(input.node, args, { encoding: 'utf8', timeout: Math.min(5_000, remaining),
          maxBuffer: 8192, env: { NODE_NO_WARNINGS: '1' } }).trim();
      assert.ok(Date.now() < deadlineMs, 'original-root oracle reply exceeded its original caller deadline');
      assert.ok(['same-live', 'absent', 'stale', 'unknown'].includes(output));
      return output as ProcessObservation;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  const [mode, selectionText, captureText, ...extra] = process.argv.slice(2);
  assert.equal(mode, '--observe-linux-root'); assert.equal(extra.length, 0);
  assert.ok(selectionText && captureText && selectionText.length < 4096 && captureText.length < 8192);
  const selection = JSON.parse(selectionText) as PackagedProcessArtifactSelection;
  const capture = JSON.parse(captureText) as RegisteredProcessCapture;
  validateProcessCapture(capture);
  assert.equal(capture.version, 3);
  assert.ok(capture.version === 3 && capture.platform === 'linux');
  const artifact = readPackagedLinuxProcessArtifact(selection);
  const { native, assertBinary } = loadProcessNativeArtifact<{
    observeOriginal(original: LinuxProcessIdentity): ProcessObservation;
  }>(artifact);
  const observed = native.observeOriginal(capture.root);
  assertBinary();
  assert.ok(['same-live', 'absent', 'stale', 'unknown'].includes(observed));
  console.log(observed);
}
