import { access } from 'node:fs/promises';

import { DescriptorAnchoredHostedApprovalRuntimeAdmissionStateStore } from '../../HostedApprovalRuntimeAdmissionStateStore';
import {
  descriptorAnchoredReplace,
  openTrustedDirectoryCapability,
} from '../../HostedApprovalRuntimeDescriptorStorage';

const [stateDirectory, teamDirectory, teamId, fingerprint, gatePath, delayText] = process.argv.slice(2);
if (
  !stateDirectory ||
  !teamDirectory ||
  !teamId ||
  !gatePath ||
  !/^[0-9a-f]{64}$/u.test(fingerprint ?? '') ||
  !/^\d{1,3}$/u.test(delayText ?? '')
) {
  throw new Error('invalid-child-cas-input');
}

while (await access(gatePath).then(() => false, () => true)) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const store = new DescriptorAnchoredHostedApprovalRuntimeAdmissionStateStore(() =>
  openTrustedDirectoryCapability(stateDirectory)
);
const outcome = await store.withCommitLock(teamId, async (locked) => {
  const current = await locked.load(teamId);
  const next = {
    schemaVersion: 1 as const,
    revision: (current?.revision ?? 0) + 1,
    generationHighWater: (current?.generationHighWater ?? 0) + 1,
    authoritativeFingerprint: fingerprint,
  };
  if (!(await locked.compareAndSwap(teamId, current?.revision ?? null, next))) {
    throw new Error('child-cas-conflict');
  }
  await new Promise((resolve) => setTimeout(resolve, Number(delayText)));
  const directory = await openTrustedDirectoryCapability(teamDirectory);
  try {
    await descriptorAnchoredReplace(
      directory,
      'child-publication.json',
      `${JSON.stringify({ generation: next.generationHighWater, fingerprint })}\n`,
      { beforeRename: async () => undefined }
    );
  } finally {
    await directory.handle.close();
  }
  return next;
});
process.stdout.write(`${JSON.stringify(outcome)}\n`);
