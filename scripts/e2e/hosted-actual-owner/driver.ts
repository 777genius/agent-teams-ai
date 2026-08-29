import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { assertFileCurrent, assertRootCurrent, descriptorMountId, procFdPath } from './anchors';
import {
  RAW_ORIGINS,
  RUNTIME_CAPTURE_NAMES,
  OPENCODE_IDENTITIES,
  sha256,
  type RawOrigin,
  type RuntimeCaptureName,
} from './contracts';
import {
  executeSupervisor,
  type ProducerCaptureShardEvidence,
  type RawFileEvidence,
  type SupervisorOutcome,
} from './processes';
import { assertOneRunAuthorizationConsumed, type PreflightAdmission } from './preflight';
import { assertSandboxCurrent, type DisposableSandbox } from './sandbox';
import { readStable, verifyClosure, type WrittenFileEvidence } from './secure-files';

export function assertLiveCaptureMode(liveMode: number, sealedMode: number): void {
  if (sealedMode !== 0o400 || liveMode !== sealedMode) {
    throw new Error('p3c_driver_capture_mode_disagreement');
  }
}

export interface DriverResult {
  readonly outcome: SupervisorOutcome;
  readonly raw: Readonly<Record<RawOrigin, Buffer>>;
  readonly captures: Readonly<Record<RuntimeCaptureName, readonly Buffer[]>>;
}

async function readSandboxEvidenceFile(
  sandbox: DisposableSandbox,
  directoryName: 'raw' | 'capture',
  fileName: string,
  expected: RawFileEvidence | ProducerCaptureShardEvidence
): Promise<Buffer> {
  if (expected.path !== `/sandbox/${directoryName}/${fileName}`)
    throw new Error('p3c_driver_evidence_path');
  await assertSandboxCurrent(sandbox);
  const rawDirectory = await open(
    `${procFdPath(sandbox.handle)}/${directoryName}`,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const directoryStat = await rawDirectory.stat({ bigint: true });
    const expectedUid = process.getuid?.();
    if (
      !directoryStat.isDirectory() ||
      Number(directoryStat.mode & 0o777n) !== 0o700 ||
      expectedUid === undefined ||
      directoryStat.uid !== BigInt(expectedUid) ||
      String(directoryStat.dev) !== sandbox.directoryIdentities[directoryName].device ||
      String(directoryStat.ino) !== sandbox.directoryIdentities[directoryName].inode ||
      (await descriptorMountId(rawDirectory)) !== sandbox.mountId
    )
      throw new Error('p3c_driver_raw_directory');
    const file = await open(
      `${procFdPath(rawDirectory)}/${fileName}`,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    );
    try {
      const before = await file.stat({ bigint: true });
      const liveMode = Number(before.mode & 0o777n);
      if ('seal' in expected) assertLiveCaptureMode(liveMode, expected.seal.mode);
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        ('seal' in expected ? liveMode !== expected.seal.mode : ![0o400, 0o600].includes(liveMode)) ||
        expectedUid === undefined ||
        before.uid !== BigInt(expectedUid) ||
        String(before.dev) !== sandbox.device ||
        String(before.dev) !== expected.captureDevice ||
        String(before.ino) !== expected.captureInode ||
        (await descriptorMountId(file)) !== sandbox.mountId ||
        Number(before.size) !== expected.size
      )
        throw new Error('p3c_driver_raw_metadata');
      const bytes = Buffer.alloc(expected.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error('p3c_driver_raw_short_read');
        offset += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mode !== after.mode ||
        before.nlink !== after.nlink ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        sha256(bytes) !== expected.sha256
      )
        throw new Error('p3c_driver_raw_changed');
      return bytes;
    } finally {
      await file.close();
    }
  } finally {
    await rawDirectory.close();
  }
}

async function revalidateBeforeExecution(
  admission: PreflightAdmission,
  sandbox: DisposableSandbox,
  consumedAttempt: WrittenFileEvidence
): Promise<void> {
  await assertSandboxCurrent(sandbox);
  await Promise.all([
    ...Object.values(admission.roots).map(assertRootCurrent),
    ...Object.values(admission.execution).map(assertFileCurrent),
  ]);
  await assertOneRunAuthorizationConsumed(admission, consumedAttempt);
  const freshlyRehashedOpenCode = sha256(await readStable(admission.execution.openCode));
  if (
    freshlyRehashedOpenCode !== OPENCODE_IDENTITIES.linuxX64BinarySha256 ||
    freshlyRehashedOpenCode !== admission.descriptor.openCode.linuxX64Binary.sha256
  ) {
    throw new Error('p3c_driver_candidate_rehash_mismatch');
  }
  const [harness, toolchain, product, browser, owner] = await Promise.all([
    verifyClosure(admission.roots.harness, admission.descriptor.product.harnessClosure),
    verifyClosure(admission.roots.toolchain, admission.descriptor.toolchain.closure),
    verifyClosure(admission.roots.productRuntime, admission.descriptor.product.runtimeClosure),
    verifyClosure(admission.roots.browserBundle, admission.descriptor.product.browserBundle),
    verifyClosure(admission.roots.p3b2, admission.descriptor.p3b2.closure),
  ]);
  if (
    harness.merkleRoot !== admission.closures.harness.merkleRoot ||
    toolchain.merkleRoot !== admission.closures.toolchain.merkleRoot ||
    product.merkleRoot !== admission.closures.productRuntime.merkleRoot ||
    browser.merkleRoot !== admission.closures.browserBundle.merkleRoot ||
    owner.merkleRoot !== admission.closures.p3b2.merkleRoot
  )
    throw new Error('p3c_driver_closure_changed_before_execution');
}

export async function runDriver(
  admission: PreflightAdmission,
  sandbox: DisposableSandbox,
  consumedAttempt: WrittenFileEvidence
): Promise<DriverResult> {
  await revalidateBeforeExecution(admission, sandbox, consumedAttempt);
  const outcome = await executeSupervisor(admission, sandbox, consumedAttempt);
  if (!outcome.zeroOwnedSurvivors) throw new Error('p3c_driver_owned_survivors');
  const raw = {} as Record<RawOrigin, Buffer>;
  for (const origin of RAW_ORIGINS)
    raw[origin] = await readSandboxEvidenceFile(
      sandbox,
      'raw',
      `${origin}.ndjson`,
      outcome.rawFiles[origin]
    );
  const captures = {} as Record<RuntimeCaptureName, readonly Buffer[]>;
  for (const name of RUNTIME_CAPTURE_NAMES) {
    captures[name] = Object.freeze(
      await Promise.all(
        outcome.captureFiles[name].shards.map(async (shard) => {
          const prefix = '/sandbox/capture/';
          if (!shard.path.startsWith(prefix)) throw new Error('p3c_driver_evidence_path');
          const fileName = shard.path.slice(prefix.length);
          if (!/^[a-zA-Z0-9._-]+\.ndjson$/u.test(fileName)) {
            throw new Error('p3c_driver_evidence_path');
          }
          return readSandboxEvidenceFile(sandbox, 'capture', fileName, shard);
        })
      )
    );
  }
  return Object.freeze({ outcome, raw: Object.freeze(raw), captures: Object.freeze(captures) });
}
