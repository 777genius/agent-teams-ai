import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createHostedV1Sandbox, type HostedV1Sandbox } from './createSandbox';

export const DASHBOARD_B_RUNTIME_WORKSPACE_ID = `workspace_${'f'.repeat(32)}`;
export const DASHBOARD_B_PUBLIC_WORKSPACE_ID = `workspace_${'6'.repeat(32)}`;
export const DASHBOARD_C_RUNTIME_WORKSPACE_ID = `workspace_${'8'.repeat(32)}`;
export const DASHBOARD_C_PUBLIC_WORKSPACE_ID = `workspace_${'7'.repeat(32)}`;
export const DASHBOARD_B_TEAM_ID = `team_${'6'.repeat(32)}`;
export const DASHBOARD_B_TEAM_NAME = `draft-${'6'.repeat(32)}`;
export const DASHBOARD_A_ROOT = '/workspaces/sandbox';
export const DASHBOARD_B_ROOT = '/workspaces/dashboard-b';
export const DASHBOARD_C_ROOT = '/workspaces/sandbox/private-c';

export interface HostedDashboardSandbox extends HostedV1Sandbox {
  readonly workspaceBDir: string;
}

function rootHash(root: string): string {
  return createHash('sha256').update(root).digest('hex');
}

/** Every path is created under the fresh, marker-owned Hosted E2E allocation. */
export async function createHostedDashboardSandbox(root: string): Promise<HostedDashboardSandbox> {
  const base = await createHostedV1Sandbox(root);
  const workspaceBDir = join(root, 'workspace-b');
  const nestedCDir = join(base.workspaceDir, 'private-c');
  const teamBDir = join(base.claudeDir, 'teams', DASHBOARD_B_TEAM_NAME);
  const projectsDir = join(base.claudeDir, 'projects');
  await Promise.all([
    mkdir(workspaceBDir),
    mkdir(nestedCDir),
    mkdir(teamBDir),
    mkdir(join(base.claudeDir, 'tasks', DASHBOARD_B_TEAM_NAME)),
    mkdir(join(projectsDir, '-workspaces-dashboard-b')),
    mkdir(join(projectsDir, '-workspaces-sandbox-private-c')),
  ]);
  await Promise.all([
    writeFile(join(workspaceBDir, 'README.md'), '# Marker-owned dashboard B workspace\n'),
    writeFile(join(nestedCDir, 'README.md'), '# Denied nested C workspace\n'),
    writeFile(
      join(teamBDir, 'team.identity.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          teamId: DASHBOARD_B_TEAM_ID,
          createdAt: '2026-08-06T12:00:00.000Z',
        },
        null,
        2
      )}\n`
    ),
    writeFile(
      join(teamBDir, 'config.json'),
      `${JSON.stringify({
        name: DASHBOARD_B_TEAM_NAME,
        members: [{ name: 'team-lead' }],
      })}\n`
    ),
    writeFile(
      join(base.claudeDir, 'tasks', DASHBOARD_B_TEAM_NAME, '1.json'),
      `${JSON.stringify({
        id: '1',
        subject: 'Dashboard B read-only task',
        description: 'Marker-owned B task-board read fixture',
        status: 'pending',
        blockedBy: [],
        blocks: [],
        related: [],
      })}\n`
    ),
    writeFile(
      join(projectsDir, '-workspaces-dashboard-b', '00000000-0000-4000-8000-000000000002.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: DASHBOARD_B_ROOT, message: { content: 'dashboard fixture B' } })}\n`
    ),
    writeFile(
      join(
        projectsDir,
        '-workspaces-sandbox-private-c',
        '00000000-0000-4000-8000-000000000003.jsonl'
      ),
      `${JSON.stringify({ type: 'user', cwd: DASHBOARD_C_ROOT, message: { content: 'dashboard fixture C' } })}\n`
    ),
    ...[
      { root: DASHBOARD_A_ROOT, id: 'a' },
      { root: DASHBOARD_B_ROOT, id: 'b' },
      { root: DASHBOARD_C_ROOT, id: 'c' },
    ].map(({ root, id }) =>
      writeFile(
        join(base.codexMetadataDir, 'sessions', `rollout-dashboard-${id}.jsonl`),
        `${JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-08-06T12:00:00.000Z',
          payload: {
            id: `dashboard-${id}`,
            timestamp: '2026-08-06T12:00:00.000Z',
            cwd: root,
            source: 'cli',
          },
        })}\n`
      )
    ),
  ]);

  const bootstrap = JSON.parse(base.bootstrap) as {
    runtimeInstance: { workspaceRoots: { kind: string; reference: string }[] };
    workspaceManifest: { registrations: Record<string, unknown>[] };
  };
  const owner = bootstrap.workspaceManifest.registrations[0];
  if (!owner || typeof owner.mountBinding !== 'object' || owner.mountBinding === null) {
    throw new Error('hosted_dashboard_owner_registration_missing');
  }
  const binding = owner.mountBinding as Record<string, unknown>;
  bootstrap.runtimeInstance.workspaceRoots = [
    DASHBOARD_A_ROOT,
    DASHBOARD_B_ROOT,
    DASHBOARD_C_ROOT,
  ].map((reference) => ({ kind: 'workspace', reference }));
  bootstrap.workspaceManifest.registrations.push(
    ...[
      {
        key: 'hosted-v1.e2e.dashboard-b',
        id: DASHBOARD_B_RUNTIME_WORKSPACE_ID,
        label: 'Dashboard B',
        root: DASHBOARD_B_ROOT,
      },
      {
        key: 'hosted-v1.e2e.dashboard-c',
        id: DASHBOARD_C_RUNTIME_WORKSPACE_ID,
        label: 'Denied nested C',
        root: DASHBOARD_C_ROOT,
      },
    ].map(({ key, id, label, root }) => ({
      schemaVersion: 1,
      registrationKey: key,
      workspaceId: id,
      displayName: label,
      registrationRevision: 1,
      declaredRootHash: rootHash(root),
      enabled: true,
      mountBinding: { ...binding },
    }))
  );
  return { ...base, bootstrap: JSON.stringify(bootstrap), workspaceBDir };
}
