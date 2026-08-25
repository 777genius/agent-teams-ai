import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createHostedStateCompatibilityAdmission,
  type HostedStateCompatibilityRuntime,
  HostedStateStartupRefusedError,
} from '@features/hosted-state-compatibility/main';
import { afterEach, describe, expect, it } from 'vitest';

import { artifactManifest, stateHeader } from '../fixtures';

const roots: string[] = [];

async function fixture(options: { state?: unknown; manifest?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hosted-state-admission-'));
  roots.push(root);
  const artifactDirectory = join(root, 'artifact');
  const stateDirectory = join(root, 'state');
  await mkdir(artifactDirectory);
  await mkdir(stateDirectory);
  const manifestBody = `${JSON.stringify(
    options.manifest ??
      artifactManifest({
        manifestId: 'hosted-state-v1-artifact-test',
        artifactVersion: 'test',
        hostedStateSchemaVersion: 1,
        minimumReadableHostedStateVersion: 1,
        orderedMigrations: [],
      })
  )}\n`;
  await writeFile(join(artifactDirectory, 'manifest.json'), manifestBody);
  await writeFile(
    join(artifactDirectory, 'manifest.json.sha256'),
    `${createHash('sha256').update(manifestBody).digest('hex')}\n`
  );
  if (options.state !== undefined) {
    await writeFile(
      join(stateDirectory, 'hosted-state-header.v1.json'),
      typeof options.state === 'string' ? options.state : JSON.stringify(options.state)
    );
  }
  return { artifactDirectory, stateDirectory, runtime: createTestRuntime() };
}

function createTestRuntime(): HostedStateCompatibilityRuntime {
  return {
    sha256: (body) => createHash('sha256').update(body).digest('hex'),
    ensureDirectory: (path, mode) => mkdir(path, { recursive: true, mode }).then(() => undefined),
    readDirectory: (path) => readdir(path),
    async readRegularBoundedUtf8(path, maximumBytes) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > maximumBytes) {
          throw new Error('hosted_state_metadata_file_invalid');
        }
        const body = await handle.readFile('utf8');
        const after = await handle.stat();
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          Buffer.byteLength(body) !== before.size
        ) {
          throw new Error('hosted_state_metadata_file_changed_during_read');
        }
        return body;
      } finally {
        await handle.close();
      }
    },
    async writeExclusiveDurable(path, body, mode) {
      const staging = `${path}.staging`;
      const handle = await open(
        staging,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        mode
      );
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(staging, path);
    },
    removeFile: (path) => unlink(path),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('hosted state production startup admission', () => {
  it('creates the header only for an empty target and admits compatible state', async () => {
    const paths = await fixture();
    const composition = createHostedStateCompatibilityAdmission({
      ...paths,
      expectedDeploymentId: 'deployment-fixture',
    });

    await expect(composition.admitBeforeListenerExposure()).resolves.toEqual({
      status: 'read_write',
      hostedStateSchemaVersion: 1,
    });
  });

  it.each([
    ['future state', stateHeader(2), 'refused'],
    ['corrupt state', '{not-json', 'state_metadata_invalid'],
    ['cross-snapshot state', stateHeader(1, 'deployment-other'), 'state_deployment_mismatch'],
  ])(
    'fails closed on %s before a caller can expose a listener',
    async (_label, state, diagnostic) => {
      const paths = await fixture({ state });
      const exposeListener = vi.fn();
      const composition = createHostedStateCompatibilityAdmission({
        ...paths,
        expectedDeploymentId: 'deployment-fixture',
      });

      await expect(composition.admitBeforeListenerExposure()).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof HostedStateStartupRefusedError &&
          (diagnostic === 'refused'
            ? error.admission?.status === 'refused'
            : error.diagnostic === diagnostic)
      );
      expect(exposeListener).not.toHaveBeenCalled();
    }
  );

  it('refuses a missing header when persisted state already exists', async () => {
    const paths = await fixture();
    await writeFile(join(paths.stateDirectory, 'foreign-state'), 'present');
    const composition = createHostedStateCompatibilityAdmission({
      ...paths,
      expectedDeploymentId: 'deployment-fixture',
    });

    await expect(composition.admitBeforeListenerExposure()).rejects.toMatchObject({
      diagnostic: 'state_metadata_invalid',
    });
  });

  it('refuses a corrupt built-manifest hash without initializing empty state', async () => {
    const paths = await fixture();
    await writeFile(join(paths.artifactDirectory, 'manifest.json.sha256'), `${'0'.repeat(64)}\n`);
    const composition = createHostedStateCompatibilityAdmission({
      ...paths,
      expectedDeploymentId: 'deployment-fixture',
    });

    await expect(composition.admitBeforeListenerExposure()).rejects.toMatchObject({
      diagnostic: 'artifact_manifest_integrity_failed',
    });
    await expect(readdir(paths.stateDirectory)).resolves.toEqual([]);
  });

  it('refuses symlink-swapped metadata through the descriptor-bound runtime seam', async () => {
    const paths = await fixture();
    const manifestPath = join(paths.artifactDirectory, 'manifest.json');
    await unlink(manifestPath);
    await symlink('/dev/null', manifestPath);
    const composition = createHostedStateCompatibilityAdmission({
      ...paths,
      expectedDeploymentId: 'deployment-fixture',
    });

    await expect(composition.admitBeforeListenerExposure()).rejects.toMatchObject({
      diagnostic: 'state_metadata_invalid',
    });
    await expect(readdir(paths.stateDirectory)).resolves.toEqual([]);
  });

  it('holds restored state until the operations lane proves session, runtime and mount rotation', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const,
      schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture',
      restoreGeneration: 2,
      bootId: 'boot_rotated',
      eventEpoch: 'epoch_rotated',
      browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const,
      freshMountBindingsRequired: true as const,
    };
    await writeFile(
      join(paths.stateDirectory, 'hosted-restore-rotation.v1.json'),
      JSON.stringify(request)
    );
    await writeFile(
      join(paths.stateDirectory, 'hosted-restore-journal.v1.json'),
      JSON.stringify({ phase: 'completed' })
    );
    const composition = createHostedStateCompatibilityAdmission({
      ...paths,
      expectedDeploymentId: 'deployment-fixture',
    });

    await expect(composition.inspectPendingOfflineRestoreRotation()).resolves.toEqual(request);
    await expect(composition.admitBeforeListenerExposure()).rejects.toMatchObject({
      diagnostic: 'offline_restore_rotation_pending',
    });
    await expect(
      composition.completeOfflineRestoreRotation({
        deploymentId: request.deploymentId,
        restoreGeneration: request.restoreGeneration,
        bootId: request.bootId,
        eventEpoch: request.eventEpoch,
        browserSessionsRevoked: true,
        runtimeAuthorityRotated: true,
        mountBindingsRotated: true,
      })
    ).resolves.toBeUndefined();
    await expect(readdir(paths.stateDirectory)).resolves.not.toContain(
      'hosted-restore-journal.v1.json'
    );
    await expect(composition.admitBeforeListenerExposure()).resolves.toMatchObject({
      status: 'read_write',
    });
  });

  it('resumes an interrupted rotation completion after the durable completion marker', async () => {
    const paths = await fixture({ state: stateHeader(1) });
    const request = {
      format: 'hosted-restored-authority-rotation/v1' as const,
      schemaVersion: 1 as const,
      deploymentId: 'deployment-fixture',
      restoreGeneration: 3,
      bootId: 'boot_resumed',
      eventEpoch: 'epoch_resumed',
      browserAuthorityRotated: true as const,
      runtimeAuthorityRotationRequired: true as const,
      freshMountBindingsRequired: true as const,
    };
    const body = JSON.stringify(request);
    await writeFile(join(paths.stateDirectory, 'hosted-restore-rotation.v1.json'), body);
    await writeFile(join(paths.stateDirectory, 'hosted-restore-rotation.completed.v1.json'), body);
    const composition = createHostedStateCompatibilityAdmission({
      ...paths,
      expectedDeploymentId: 'deployment-fixture',
    });

    await expect(
      composition.completeOfflineRestoreRotation({
        deploymentId: request.deploymentId,
        restoreGeneration: request.restoreGeneration,
        bootId: request.bootId,
        eventEpoch: request.eventEpoch,
        browserSessionsRevoked: true,
        runtimeAuthorityRotated: true,
        mountBindingsRotated: true,
      })
    ).resolves.toBeUndefined();
    await expect(composition.admitBeforeListenerExposure()).resolves.toMatchObject({
      status: 'read_write',
    });
  });
});
