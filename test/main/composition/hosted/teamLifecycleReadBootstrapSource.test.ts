import {
  readTeamLifecycleReadBootstrapEnvironment,
  TEAM_LIFECYCLE_READ_AUTHORIZED_SCOPE,
  TEAM_LIFECYCLE_READ_BOOTSTRAP_ENV,
  TEAM_LIFECYCLE_READ_BOOTSTRAP_FORMAT,
  TeamLifecycleReadBootstrapSource,
} from '@main/composition/hosted/teamLifecycleReadBootstrapSource';
import { describe, expect, it, vi } from 'vitest';

const NOW_MS = Date.parse('2026-07-18T12:00:00.000Z');
const WORKSPACE_ID = `workspace_${'1'.repeat(32)}`;
const FOREIGN_WORKSPACE_ID = `workspace_${'2'.repeat(32)}`;
const ROOT_HASH = '3'.repeat(64);

function runtimeInstance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deploymentId: 'deployment_team-lifecycle-read-bootstrap',
    bootId: 'boot_team-lifecycle-read-bootstrap',
    claudeRoot: { kind: 'claude', reference: 'runtime://claude' },
    appDataRoot: { kind: 'app-data', reference: 'runtime://app-data' },
    workspaceRoots: [{ kind: 'workspace', reference: 'runtime://workspace' }],
    tempRoot: { kind: 'temp', reference: 'runtime://temp' },
    logsRoot: { kind: 'logs', reference: 'runtime://logs' },
    ...overrides,
  };
}

function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    registrationKey: 'operator.workspace.one',
    workspaceId: WORKSPACE_ID,
    displayName: 'Workspace One',
    registrationRevision: 1,
    declaredRootHash: ROOT_HASH,
    enabled: true,
    mountBinding: {
      bootId: 'boot_team-lifecycle-read-bootstrap',
      mountGeneration: 1,
      observedAt: NOW_MS - 1_000,
      health: 'healthy',
      allowedOperations: [],
    },
    ...overrides,
  };
}

function bootstrap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: TEAM_LIFECYCLE_READ_BOOTSTRAP_FORMAT,
    issuedAtMs: NOW_MS - 2_000,
    expiresAtMs: NOW_MS + 2_000,
    actorId: 'actor_team-lifecycle-read-bootstrap',
    authorizedScope: TEAM_LIFECYCLE_READ_AUTHORIZED_SCOPE,
    deploymentId: 'deployment_team-lifecycle-read-bootstrap',
    bootId: 'boot_team-lifecycle-read-bootstrap',
    workspaceId: WORKSPACE_ID,
    runtimeInstance: runtimeInstance(),
    workspaceManifest: { version: 1, registrations: [registration()] },
    ...overrides,
  };
}

function serialized(value: Record<string, unknown> = bootstrap()): string {
  return JSON.stringify(value);
}

function source(...values: [] | [unknown]) {
  const readSerializedBootstrap = vi.fn(() => (values.length === 0 ? serialized() : values[0]));
  return {
    adapter: new TeamLifecycleReadBootstrapSource({
      input: { readSerializedBootstrap },
      nowMs: () => NOW_MS,
    }),
    readSerializedBootstrap,
  };
}

function manifestOf(value: Record<string, unknown>): Record<string, unknown> {
  return value.workspaceManifest as Record<string, unknown>;
}

function registrationsOf(value: Record<string, unknown>): Record<string, unknown>[] {
  return manifestOf(value).registrations as Record<string, unknown>[];
}

function mountBindingOf(value: Record<string, unknown>): Record<string, unknown> {
  return registrationsOf(value)[0].mountBinding as Record<string, unknown>;
}

describe('TeamLifecycleReadBootstrapSource', () => {
  it('exports only stable bootstrap identifiers', () => {
    expect(TEAM_LIFECYCLE_READ_BOOTSTRAP_ENV).toBe(
      'AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP'
    );
    expect(TEAM_LIFECYCLE_READ_BOOTSTRAP_FORMAT).toBe(
      'agent-teams.team-lifecycle-read-bootstrap/v1'
    );
  });

  it('prefers the stable bootstrap env and uses the compatibility env only as fallback', () => {
    expect(
      readTeamLifecycleReadBootstrapEnvironment({
        AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP: 'stable-envelope',
        AGENT_TEAMS_HOSTED_PHASE2_READ_BOOTSTRAP: 'legacy-envelope',
      })
    ).toBe('stable-envelope');
    expect(
      readTeamLifecycleReadBootstrapEnvironment({
        AGENT_TEAMS_HOSTED_PHASE2_READ_BOOTSTRAP: 'legacy-envelope',
      })
    ).toBe('legacy-envelope');
  });

  it('reads the injected launcher value once and creates one immutable admitted authority', async () => {
    const harness = source();

    const admitted = await harness.adapter.load();

    expect(harness.readSerializedBootstrap).toHaveBeenCalledTimes(1);
    expect(admitted).toMatchObject({
      actorId: 'actor_team-lifecycle-read-bootstrap',
      authorizedScope: TEAM_LIFECYCLE_READ_AUTHORIZED_SCOPE,
      deploymentId: 'deployment_team-lifecycle-read-bootstrap',
      bootId: 'boot_team-lifecycle-read-bootstrap',
      workspaceId: WORKSPACE_ID,
      mountBinding: {
        workspaceId: WORKSPACE_ID,
        bootId: 'boot_team-lifecycle-read-bootstrap',
        mountGeneration: 1,
        health: 'healthy',
      },
      authority: {
        actorId: 'actor_team-lifecycle-read-bootstrap',
        authorizedScope: TEAM_LIFECYCLE_READ_AUTHORIZED_SCOPE,
        workspaceId: WORKSPACE_ID,
        workspaceGeneration: 1,
        deploymentId: 'deployment_team-lifecycle-read-bootstrap',
        bootId: 'boot_team-lifecycle-read-bootstrap',
      },
    });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.runtimeInstance)).toBe(true);
    await expect(harness.adapter.load()).rejects.toThrow(
      'team-lifecycle-read-bootstrap-source-already-read'
    );
    expect(harness.readSerializedBootstrap).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['stable', TEAM_LIFECYCLE_READ_BOOTSTRAP_FORMAT],
    ['compatibility read alias', 'agent-teams.phase2-read-bootstrap/v1'],
  ])(
    'reads the %s serialized format while builders write the stable format',
    async (_name, format) => {
      const harness = source(serialized(bootstrap({ format })));

      await expect(harness.adapter.load()).resolves.toMatchObject({
        actorId: 'actor_team-lifecycle-read-bootstrap',
      });
      expect(bootstrap().format).toBe('agent-teams.team-lifecycle-read-bootstrap/v1');
      expect(bootstrap().format).not.toBe('agent-teams.phase2-read-bootstrap/v1');
    }
  );

  it('captures the injected launcher reader once before the one allowed read', async () => {
    const firstReader = vi.fn(() => serialized());
    const secondReader = vi.fn(() => serialized(bootstrap({ actorId: 'actor_foreign' })));
    let readerPropertyReads = 0;
    const input = Object.defineProperty({}, 'readSerializedBootstrap', {
      enumerable: true,
      get: () => (++readerPropertyReads === 1 ? firstReader : secondReader),
    }) as { readSerializedBootstrap(): unknown };
    const adapter = new TeamLifecycleReadBootstrapSource({ input, nowMs: () => NOW_MS });

    await expect(adapter.load()).resolves.toMatchObject({
      actorId: 'actor_team-lifecycle-read-bootstrap',
    });
    expect(readerPropertyReads).toBe(1);
    expect(firstReader).toHaveBeenCalledTimes(1);
    expect(secondReader).not.toHaveBeenCalled();
  });

  it.each([
    ['missing input', undefined],
    ['non-string input', bootstrap()],
    ['malformed JSON', '{'],
    ['empty JSON', '{}'],
  ])('fails closed for %s without retrying the launcher read', async (_name, value) => {
    const harness = source(value);

    await expect(harness.adapter.load()).rejects.toThrow('team-lifecycle-read-bootstrap-invalid');
    await expect(harness.adapter.load()).rejects.toThrow(
      'team-lifecycle-read-bootstrap-source-already-read'
    );
    expect(harness.readSerializedBootstrap).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'unknown envelope field',
      (value: Record<string, unknown>) => {
        value.projectPath = '/foreign/project';
      },
    ],
    [
      'invalid actor',
      (value: Record<string, unknown>) => {
        value.actorId = 'user_team-lifecycle-read-bootstrap';
      },
    ],
    [
      'foreign scope',
      (value: Record<string, unknown>) => {
        value.authorizedScope = 'scope_team-lifecycle.write';
      },
    ],
    [
      'foreign deployment',
      (value: Record<string, unknown>) => {
        value.deploymentId = 'deployment_foreign';
      },
    ],
    [
      'foreign boot',
      (value: Record<string, unknown>) => {
        value.bootId = 'boot_foreign';
      },
    ],
    [
      'expired envelope',
      (value: Record<string, unknown>) => {
        value.expiresAtMs = NOW_MS;
      },
    ],
    [
      'future envelope',
      (value: Record<string, unknown>) => {
        value.issuedAtMs = NOW_MS + 1;
      },
    ],
    [
      'unknown runtime field',
      (value: Record<string, unknown>) => {
        (value.runtimeInstance as Record<string, unknown>).localProjectsDir = '/foreign/project';
      },
    ],
    [
      'unknown manifest field',
      (value: Record<string, unknown>) => {
        manifestOf(value).root = '/foreign/project';
      },
    ],
    [
      'unknown registration field',
      (value: Record<string, unknown>) => {
        registrationsOf(value)[0].identityRow = 'foreign';
      },
    ],
    [
      'unknown mount field',
      (value: Record<string, unknown>) => {
        mountBindingOf(value).previousMountGeneration = 0;
      },
    ],
    [
      'unavailable binding',
      (value: Record<string, unknown>) => {
        mountBindingOf(value).health = 'unavailable';
      },
    ],
    [
      'stale binding boot',
      (value: Record<string, unknown>) => {
        mountBindingOf(value).bootId = 'boot_stale';
      },
    ],
    [
      'foreign binding workspace',
      (value: Record<string, unknown>) => {
        registrationsOf(value)[0].workspaceId = FOREIGN_WORKSPACE_ID;
      },
    ],
    [
      'non-initial mount generation',
      (value: Record<string, unknown>) => {
        mountBindingOf(value).mountGeneration = 2;
      },
    ],
    [
      'ambiguous workspace registration',
      (value: Record<string, unknown>) => {
        registrationsOf(value).push(structuredClone(registrationsOf(value)[0]));
      },
    ],
  ])('fails closed for %s', async (_name, mutate) => {
    const value = bootstrap();
    mutate(value);

    await expect(source(serialized(value)).adapter.load()).rejects.toThrow(
      'team-lifecycle-read-bootstrap-invalid'
    );
  });

  it('accepts a deployment manifest with one exact selected binding and unrelated registrations', async () => {
    const value = bootstrap();
    registrationsOf(value).push(
      registration({
        registrationKey: 'operator.workspace.two',
        workspaceId: FOREIGN_WORKSPACE_ID,
        displayName: 'Workspace Two',
        declaredRootHash: '4'.repeat(64),
      })
    );

    await expect(source(serialized(value)).adapter.load()).resolves.toMatchObject({
      workspaceId: WORKSPACE_ID,
      mountBinding: { workspaceId: WORKSPACE_ID },
    });
  });
});
