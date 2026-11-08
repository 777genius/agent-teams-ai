import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPublicationHelper } from '../../../scripts/build/publicationHelper';

let artifact: string | undefined;
let ownsArtifact = true;
const owners: Array<{
  dispose: () => Promise<void>;
  physical: (timeout: number) => Promise<'closed' | 'pending'>;
}> = [];
/** Actual helper source compiled once into a fresh private test artifact, never application dist. */
export async function preparePublicationHelperFixture(): Promise<void> {
  const prebuilt = process.env.AGENT_TEAMS_TEST_PUBLICATION_ARTIFACT;
  if (prebuilt) {
    artifact = await realpath(prebuilt);
    ownsArtifact = false;
    return;
  }

  artifact = await realpath(
    await mkdtemp(path.join(homedir(), 'TEST-publication-helper-')),
  );
  await buildPublicationHelper(
    fileURLToPath(new URL('../../../', import.meta.url)),
    artifact,
  );
}
export async function configurePublicationHelperFixture(): Promise<void> {
  if (!artifact) throw new Error('Missing publication fixture');
  // Dynamic import follows vi.resetModules and configures that exact independent owner.
  const api = await import('@features/local-http-auth/main');
  api.configurePublicationHelper({ directory: artifact, mode: 'node' });
  owners.push({
    dispose: api.disposePublicationHelper,
    physical: api.waitForPublicationHelperRetirement,
  });
}
export async function retirePublicationHelperFixture(
  expectedFailures = 0,
): Promise<void> {
  const retiring = owners.splice(0);
  const results = await Promise.allSettled(
    retiring.map((owner) => owner.dispose()),
  );
  const physical = await Promise.all(
    retiring.map((owner) => owner.physical(0)),
  );
  if (physical.some((status) => status !== 'closed'))
    throw new Error('Publication fixture physical retirement is pending');
  const rejected = results.filter((result) => result.status === 'rejected');
  if (
    rejected.length !== expectedFailures ||
    rejected.some(
      (result) =>
        !(result.reason instanceof Error) ||
        result.reason.message !==
          'API authority publication helper failed; admission closed until owned exit',
    )
  )
    throw new Error('Unexpected publication fixture cleanup result');
}
export async function cleanupPublicationHelperFixture(): Promise<void> {
  await retirePublicationHelperFixture();
  if (artifact && ownsArtifact)
    await rm(artifact, { recursive: true, force: true });
  artifact = undefined;
}
