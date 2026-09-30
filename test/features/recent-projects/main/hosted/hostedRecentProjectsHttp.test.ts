import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerHostedRecentProjectsHttp } from '@features/recent-projects/main/hosted';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  WorkspaceMountBinding,
  WorkspaceRegistration,
  WorkspaceRegistrationRegistry,
} from '@features/workspace-registry';
import { createHostedRecentProjectsComposition } from '@main/composition/hosted/hostedRecentProjectsComposition';
import { classifyStandaloneHostedAuthorization } from '@main/standaloneHostedAuthorizationPolicy';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('admits only the exact hosted POST and denies the legacy recent GET', () => {
  expect(classifyStandaloneHostedAuthorization('GET', '/api/dashboard/recent-projects')).toEqual({
    kind: 'forbidden',
  });
  expect(classifyStandaloneHostedAuthorization('POST', '/api/hosted/v1/dashboard/recent-projects')).toMatchObject({
    kind: 'authenticated', permission: 'hosted.query', csrfRequired: true,
  });
  expect(classifyStandaloneHostedAuthorization('GET', '/api/hosted/v1/dashboard/recent-projects')).toEqual({
    kind: 'forbidden',
  });
});

it('returns a typed unavailable response when the metadata read passes its deadline', async () => {
  const app = Fastify();
  registerHostedRecentProjectsHttp(app, {
    list: async () => new Promise(() => undefined),
  }, 10);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/hosted/v1/dashboard/recent-projects',
      payload: { schemaVersion: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schemaVersion: 1, kind: 'unavailable', code: 'source_unavailable' });
  } finally {
    await app.close();
  }
});

describe.skipIf(process.platform !== 'linux')('hosted recent HTTP composition', () => {
  it('uses deepest signed root and A-only fence; missing Codex mount is typed partial', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-recent-http-'));
    roots.push(root);
    const a = join(root, 'A');
    const b = join(a, 'B');
    const claudeRoot = join(root, 'claude');
    const projectsDir = join(claudeRoot, 'projects');
    await Promise.all([mkdir(b, { recursive: true }), mkdir(join(projectsDir, 'encoded'), { recursive: true })]);
    const ids = [`workspace_${'a'.repeat(32)}`, `workspace_${'b'.repeat(32)}`] as const;
    const publicIds = [`workspace_${'1'.repeat(32)}`, `workspace_${'2'.repeat(32)}`] as const;
    const bootId = `boot_${'b'.repeat(32)}`;
    const deploymentId = `deployment_${'d'.repeat(32)}`;
    const registrations = [a, b].map((path, index) => new WorkspaceRegistration({
      schemaVersion: 1,
      registrationKey: `root-${index}`,
      workspaceId: ids[index] as never,
      displayName: `Root ${index}`,
      registrationRevision: 1,
      declaredRootHash: createHash('sha256').update(path).digest('hex'),
      enabled: true,
    }));
    const snapshot = {
      registry: new WorkspaceRegistrationRegistry(registrations),
      bindings: registrations.map((registration) => new WorkspaceMountBinding({
        registration,
        bootId: bootId as never,
        mountGeneration: 1,
        declaredRootHash: registration.declaredRootHash,
        observedAt: Date.now(),
        health: 'healthy',
        allowedOperations: [],
      })),
    };
    const runtimeInstance = createRuntimeInstanceContext({
      deploymentId, bootId,
      claudeRoot: { kind: 'claude', reference: claudeRoot },
      appDataRoot: { kind: 'app-data', reference: root },
      workspaceRoots: [a, b].map((reference) => ({ kind: 'workspace' as const, reference })),
      tempRoot: { kind: 'temp', reference: root },
      logsRoot: { kind: 'logs', reference: root },
    });
    await writeFile(join(projectsDir, 'encoded', 'b.jsonl'), JSON.stringify({ type: 'user', cwd: b }) + '\n');
    let captureCalls = 0;
    let grantGeneration = 0;
    let simulateRegrant = false;
    let grantSetFingerprint = 'f'.repeat(64);
    const authentication = {
      authenticatedPrincipalFor: () => ({
        principal: { userId: 'user-test' }, authenticatedSessionId: 'session-test',
      }) as never,
      isHostedQueryAuthorized: async () => true,
      projectGrantedPublicWorkspaceId: async (_request: object, runtimeId: string) =>
        runtimeId === ids[0] ? publicIds[0] : runtimeId === ids[1] ? publicIds[1] : null,
      captureWorkspaceReadGrantFence: async (_request: object, publicId: string) => {
        captureCalls++;
        if (simulateRegrant && captureCalls === 2) grantGeneration++;
        const capturedGeneration = grantGeneration;
        return {
          runtimeWorkspaceId: publicId === publicIds[0] ? ids[0] : ids[1],
          grantSetFingerprint,
          revalidate: async () => capturedGeneration === grantGeneration,
        };
      },
    };
    const app = Fastify();
    createHostedRecentProjectsComposition({
      authentication, snapshot, runtimeInstance, expectedDeploymentId: deploymentId,
      primaryRuntimeWorkspaceId: ids[0],
      metadataMounts: { claudeProjectsDir: projectsDir },
    }).register(app);
    try {
      const request = { method: 'POST' as const, url: '/api/hosted/v1/dashboard/recent-projects', payload: { schemaVersion: 1 } };
      const hidden = await app.inject(request);
      expect(hidden.statusCode).toBe(200);
      expect(hidden.json()).toMatchObject({ kind: 'recent-projects', completeness: 'partial', projects: [] });
      grantSetFingerprint = 'e'.repeat(64);
      await writeFile(join(projectsDir, 'encoded', 'a.jsonl'), JSON.stringify({ type: 'user', cwd: a }) + '\n');
      const visible = await app.inject(request);
      expect(visible.json().projects.map((project: { workspaceId: string }) => project.workspaceId)).toEqual([publicIds[0]]);
      expect(visible.json().projects[0].label).toBe('Workspace 1');
      await rm(join(projectsDir, 'encoded', 'a.jsonl'));
      const cached = await app.inject(request);
      expect(cached.json().projects.map((project: { workspaceId: string }) => project.workspaceId)).toEqual([publicIds[0]]);
      captureCalls = 0;
      simulateRegrant = true;
      const regranted = await app.inject(request);
      expect(regranted.json()).toEqual({ schemaVersion: 1, kind: 'unavailable', code: 'authority_changed' });
      expect((await app.inject({ ...request, payload: { schemaVersion: 1, root: b } })).statusCode).toBe(400);
      simulateRegrant = false;
      grantSetFingerprint = 'd'.repeat(64);
      await rm(projectsDir, { recursive: true });
      expect((await app.inject(request)).json()).toEqual({ schemaVersion: 1, kind: 'unavailable', code: 'source_unavailable' });
      expect((await app.inject(request)).json()).toEqual({ schemaVersion: 1, kind: 'unavailable', code: 'source_unavailable' });
      await mkdir(join(projectsDir, 'encoded'), { recursive: true });
      await writeFile(join(projectsDir, 'encoded', 'restored.jsonl'), JSON.stringify({ type: 'user', cwd: a }) + '\n');
      expect((await app.inject(request)).json().projects.map((project: { workspaceId: string }) => project.workspaceId)).toEqual([publicIds[0]]);
    } finally {
      await app.close();
    }
  });
});
