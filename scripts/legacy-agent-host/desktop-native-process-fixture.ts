import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  prepareDesktopBackendFixture,
  desktopBackendEnvironment,
  digest,
  fileDigest,
} from './desktop-backend-fixture.ts';
import { createFilesystemTeamOwner } from '../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import { acquireProfileWriterLease } from '../../packages/legacy-agent-host/dist/adapters/profile/ProfileWriterLease.js';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { Service } from './desktop-native-process-model.ts';

export const PROCESS_ARTIFACT = {
  directory: '/private/tmp/TEST-m19-native-ancestry-artifact-20261024-a0HlV7IZ',
  manifestSha256: '17cc2429f59a5261dfd65c2af414ed307f669bc271a2bb5f51c131be05cd2278',
};
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export async function readProcessServices(
  root: string
): Promise<{ primary: Service; neighbor: Service }> {
  const seed = JSON.parse(await readFile(join(root, 'process-ui-seed.json'), 'utf8')) as {
    roles: Record<string, { nonce: string }>;
  };
  const read = async (role: string): Promise<Service> => {
    const row = JSON.parse(
      await readFile(join(root, 'workspace', `process-${role}.json`), 'utf8')
    ) as Service;
    assert.equal(row.role, role);
    assert.equal(row.nonce, seed.roles[role]!.nonce);
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 1);
    assert.ok(Number.isInteger(row.port) && row.port > 0 && row.port < 65536);
    assert.equal(row.url, `http://127.0.0.1:${row.port}/${row.nonce}`);
    return row;
  };
  const [primary, neighbor] = await Promise.all([read('primary'), read('neighbor')]);
  assert.notEqual(primary.pid, neighbor.pid);
  return { primary, neighbor };
}
export async function probeProcessService(service: Service) {
  const url = new URL(service.url);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.pathname, `/${service.nonce}`);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(2000),
    redirect: 'error',
  });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.deepEqual(body, {
    role: service.role,
    nonce: service.nonce,
    pid: service.pid,
  });
  return body;
}
/** Private TEST setup only, before the first Host opens the immutable profile. */
export async function prepareProcessFixture(
  repo: string,
  options: {
    pnpmEntry: string;
    nativeClaude: { path: string; sha256: string; modelUrl: string };
  }
) {
  assert.equal(
    await fileDigest(join(PROCESS_ARTIFACT.directory, 'manifest.json')),
    PROCESS_ARTIFACT.manifestSha256
  );
  const fixture = await prepareDesktopBackendFixture(repo, {
    ...options,
    seedUiTask: false,
  });
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8')) as TeamHostProfile;
  profile.processCustody = PROCESS_ARTIFACT;
  const team = profile.teams[0]!;
  for (const grant of team.grants)
    if (!grant.permissions.includes('process.write')) grant.permissions.push('process.write');
  const seed = {
    schemaVersion: 1,
    node: fixture.node,
    roles: {
      primary: { nonce: `TEST-${randomUUID()}` },
      neighbor: { nonce: `TEST-${randomUUID()}` },
    },
    ttlMs: 45_000,
    nativeActions: { bash: 2, register: 1 },
  };
  await writeFile(join(fixture.root, 'process-ui-seed.json'), JSON.stringify(seed), {
    mode: 0o600,
    flag: 'wx',
  });
  const scripts: Record<string, string> = {};
  for (const name of ['process-foreground-service.ts']) {
    const from = join(import.meta.dirname, 'fixtures', name),
      to = join(fixture.root, 'workspace', name);
    await copyFile(from, to);
    scripts[name] = await fileDigest(to);
  }
  await writeFile(
    join(fixture.root, 'claude/agent-teams-config.json'),
    JSON.stringify({
      general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark' },
    }),
    { mode: 0o600 }
  );
  const lease = acquireProfileWriterLease(profile.owner.storageRoot);
  let uiSeed: { taskId: string; subject: string; commandId: string };
  try {
    lease.assertCurrent();
    const owner = createFilesystemTeamOwner({
      root: profile.owner.storageRoot,
      binding: team.binding,
      members: team.members,
      grants: team.grants,
    }).connect(profile.principalId);
    const subject = 'TEST native process cold-owner sidebar seed',
      commandId = 'TEST-process-ui-seed';
    const receipt = owner.execute({
      commandId,
      operation: 'task.create',
      payload: { subject },
    });
    assert.equal(receipt.phase, 'completed');
    const tasks = owner.listTasks();
    assert.equal(tasks.length, 1);
    uiSeed = { taskId: tasks[0]!.id, subject, commandId };
    await writeFile(join(fixture.root, 'ui-seed-receipt.json'), JSON.stringify(receipt, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
  } finally {
    lease.release();
  }
  const profileBytes = JSON.stringify(profile);
  await writeFile(fixture.profilePath, profileBytes, { mode: 0o600 });
  readTeamHostProfile(fixture.profilePath, digest(profileBytes));
  const descriptor = JSON.parse(await readFile(fixture.descriptorPath, 'utf8')) as {
    owners: { profile: { env: Record<string, string> } }[];
  };
  descriptor.owners[0]!.profile.env.LEGACY_AGENT_HOST_PROFILE_SHA256 = digest(profileBytes);
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(fixture.descriptorPath, descriptorBytes, { mode: 0o600 });
  const pins = {
    ...fixture.pins,
    profileSha256: digest(profileBytes),
    descriptorSha256: digest(descriptorBytes),
  };
  await writeFile(
    join(fixture.root, 'process-prepared-source-pins.json'),
    JSON.stringify(
      {
        scripts,
        profileSha256: pins.profileSha256,
        descriptorSha256: pins.descriptorSha256,
        processArtifact: PROCESS_ARTIFACT,
      },
      null,
      2
    ),
    { mode: 0o600, flag: 'wx' }
  );
  return {
    ...fixture,
    uiSeed,
    pins,
    appEnvironment: desktopBackendEnvironment(
      fixture.root,
      fixture.node,
      fixture.descriptorPath,
      pins.descriptorSha256
    ),
    bashCommand: `${quote(fixture.node)} ${quote(join(fixture.root, 'workspace/process-foreground-service.ts'))} ${quote(fixture.root)}`,
  };
}
export type ProcessFixture = Awaited<ReturnType<typeof prepareProcessFixture>>;

/** Narrow the original prepared fixture before any M19 native or UI action. */
export function assertProcessFixture(
  fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>
): asserts fixture is ProcessFixture {
  assert.ok(fixture.uiSeed, 'original process sidebar seed');
  assert.equal(typeof (fixture as Partial<ProcessFixture>).bashCommand, 'string');
}

export function processFixtureBashCommand(
  fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>
): string {
  assertProcessFixture(fixture);
  return fixture.bashCommand;
}
