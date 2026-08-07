import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import {
  assertHostedV1MarkerOwnedRoot,
  createHostedV1Sandbox,
  E2E_RUNTIME_WORKSPACE_ID,
  E2E_WORKSPACE_ID,
} from '../../fixtures/hosted-v1/createSandbox';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('hosted v1 browser E2E sandbox', () => {
  it('uses the production image and the CI-preinstalled browser without a divergent app build', async () => {
    const [compose, runner, spec, seed, workflow] = await Promise.all([
      readFile('docker/docker-compose.e2e.yml', 'utf8'),
      readFile('scripts/e2e/hosted-v1/run.ts', 'utf8'),
      readFile('test/e2e/hosted-v1/hosted-v1.spec.ts', 'utf8'),
      readFile('test/fixtures/hosted-v1/seedContainer.ts', 'utf8'),
      readFile('.github/workflows/ci.yml', 'utf8'),
    ]);
    expect(compose).toContain('dockerfile: docker/Dockerfile');
    expect(compose).not.toContain('docker/e2e/Dockerfile');
    expect(compose).toContain('COMPOSE_PROJECT_NAME');
    expect(compose).toContain('E2E_APP_IMAGE');
    expect(compose).toContain('HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET');
    const parsedCompose = YAML.parse(compose) as {
      services: { caddy: { ports: unknown } };
    };
    expect(parsedCompose.services.caddy.ports).toEqual([
      {
        host_ip: '127.0.0.1',
        protocol: 'tcp',
        target: 443,
      },
    ]);
    expect(runner).not.toMatch(/playwright["', ]+install/u);
    expect(runner).toContain('PLAYWRIGHT_BROWSERS_PATH');
    expect(runner).toContain('COMPOSE_FILE: composeFile');
    expect(spec).toContain('composeFile !== runtime.composeFile');
    expect(spec).toContain('composeProject !== runtime.composeProject');
    expect(spec).toContain('runtimeState.activeRuns).toEqual([])');
    expect(spec).toContain("'launch',\n    'stop',\n    'recover',\n    'stop'");
    expect(seed).not.toContain('event_hosted-v1-e2e-seeded');
    expect(workflow).toContain('hosted-v1-e2e:');
    const hostedWorkflow = workflow.slice(
      workflow.indexOf('  hosted-v1-e2e:'),
      workflow.indexOf('\n  lint:')
    );
    expect(hostedWorkflow.indexOf('Install dependencies')).toBeLessThan(
      hostedWorkflow.indexOf('Rebuild test SQLite native module for Node')
    );
    expect(hostedWorkflow.indexOf('Rebuild test SQLite native module for Node')).toBeLessThan(
      hostedWorkflow.indexOf('Cache Chromium')
    );
    expect(workflow).toContain('Install Chromium once');
    expect(workflow).toContain(
      'sudo --preserve-env=CI,PATH,CADDY_IMAGE_DIGEST,HOSTED_E2E_ARTIFACT_DIR,KEYCLOAK_IMAGE_DIGEST,NODE_IMAGE_DIGEST,PLAYWRIGHT_BROWSERS_PATH'
    );
    expect(workflow).toContain('"$(command -v pnpm)" test:hosted:e2e');
    expect(workflow.match(/'docker\/\*\*'/gu)).toHaveLength(2);
    expect(runner).toContain('await chown(canonical, artifactOwner.uid, artifactOwner.gid)');
    expect(runner).toContain('await chmod(canonical, 0o700)');
    expect(spec.match(/process\.kill\(controllerPid, 'SIGTERM'\)/gu)).toHaveLength(1);
    expect(spec).toContain('match(/Shutting down\\.\\.\\./gu)).toHaveLength(1)');
    expect(spec).toContain('match(/Shutdown complete/gu)).toHaveLength(1)');
    expect(spec).toContain("docker('inspect', '--format', '{{ .State.ExitCode }}', controllerId)");
    expect(spec).not.toContain("join(runtime.runDir, 'drain-proof.json')");
  });

  it('rejects a non-sandbox root before changing it', async () => {
    await expect(createHostedV1Sandbox(process.cwd())).rejects.toThrow(
      'hosted_e2e_root_outside_temp'
    );
  });

  it('creates only fresh marker-owned state and a committed sandbox repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-harness-test-'));
    roots.push(root);

    const sandbox = await createHostedV1Sandbox(root);
    const marker = JSON.parse(await readFile(sandbox.markerPath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(marker).toMatchObject({ schemaVersion: 1, purpose: 'hosted-v1-browser-e2e' });
    expect(marker.marker).toMatch(/^[0-9a-f]{48}$/);
    expect(sandbox.marker).toBe(marker.marker);
    await expect(
      assertHostedV1MarkerOwnedRoot(sandbox.root, sandbox.markerPath, sandbox.marker)
    ).resolves.toBeUndefined();
    await expect(
      assertHostedV1MarkerOwnedRoot(sandbox.root, sandbox.markerPath, '0'.repeat(48))
    ).rejects.toThrow('hosted_e2e_cleanup_marker_invalid');
    await expect(readFile(join(sandbox.workspaceDir, 'README.md'), 'utf8')).resolves.toContain(
      'Marker-owned'
    );
    await expect(
      readFile(join(sandbox.claudeDir, 'tasks', 'sandbox-hosted-team', '1.json'), 'utf8')
    ).resolves.toContain('Marker-owned browser E2E task');
    await expect(
      lstat(join(sandbox.claudeDir, 'tasks', 'sandbox-hosted-team')).then((stat) =>
        stat.isDirectory()
      )
    ).resolves.toBe(true);
    await expect(
      lstat(join(sandbox.appDataDir, 'logs')).then((stat) => stat.isDirectory())
    ).resolves.toBe(true);
    await expect(
      lstat(join(sandbox.oidcAppDataDir, 'logs')).then((stat) => stat.isDirectory())
    ).resolves.toBe(true);
    await expect(lstat(sandbox.caddyDataDir).then((stat) => stat.isDirectory())).resolves.toBe(
      true
    );
    await expect(
      execFileAsync('git', ['status', '--porcelain=v1'], { cwd: sandbox.workspaceDir })
    ).resolves.toMatchObject({ stdout: '' });

    const bootstrap = JSON.parse(sandbox.bootstrap) as Record<string, unknown>;
    expect(JSON.stringify(bootstrap)).not.toContain(root);
    expect(bootstrap).toMatchObject({
      workspaceId: E2E_WORKSPACE_ID,
      runtimeInstance: {
        claudeRoot: { reference: '/data/.claude' },
        appDataRoot: { reference: '/data/.agent-teams' },
        workspaceRoots: [{ reference: '/workspaces/sandbox' }],
      },
    });
    expect(E2E_RUNTIME_WORKSPACE_ID).toBe('-workspaces-sandbox');
  });
});
