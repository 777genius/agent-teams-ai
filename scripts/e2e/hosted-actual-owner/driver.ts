import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { assertFileCurrent, assertRootCurrent, descriptorMountId, procFdPath } from './anchors';
import { RAW_ORIGINS, sha256, type RawOrigin } from './contracts';
import { executeSupervisor, type RawFileEvidence, type SupervisorOutcome } from './processes';
import { assertOneRunAuthorizationConsumed, type PreflightAdmission } from './preflight';
import { assertSandboxCurrent, type DisposableSandbox } from './sandbox';
import { verifyClosure, type WrittenFileEvidence } from './secure-files';

export interface DriverResult {
  readonly outcome: SupervisorOutcome;
  readonly raw: Readonly<Record<RawOrigin, Buffer>>;
}

async function readRawFile(
  sandbox: DisposableSandbox,
  origin: RawOrigin,
  expected: RawFileEvidence
): Promise<Buffer> {
  if (expected.path !== `/sandbox/raw/${origin}.ndjson`) throw new Error('p3c_driver_raw_path');
  await assertSandboxCurrent(sandbox);
  const rawDirectory = await open(
    `${procFdPath(sandbox.handle)}/raw`,
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
      String(directoryStat.dev) !== sandbox.device ||
      (await descriptorMountId(rawDirectory)) !== sandbox.mountId
    )
      throw new Error('p3c_driver_raw_directory');
    const file = await open(
      `${procFdPath(rawDirectory)}/${origin}.ndjson`,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    );
    try {
      const before = await file.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        ![0o400, 0o600].includes(Number(before.mode & 0o777n)) ||
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
    raw[origin] = await readRawFile(sandbox, origin, outcome.rawFiles[origin]);
  return Object.freeze({ outcome, raw: Object.freeze(raw) });
}
