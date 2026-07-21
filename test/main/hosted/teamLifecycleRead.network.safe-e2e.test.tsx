import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageSchema';
import {
  TEAM_LIFECYCLE_READ_AUTHORIZED_SCOPE,
  TEAM_LIFECYCLE_READ_BOOTSTRAP_FORMAT,
  TeamLifecycleReadBootstrapSource,
} from '@main/composition/hosted/teamLifecycleReadBootstrapSource';
import {
  createMountBindingScopedTeamLifecycleReadPorts,
  createTeamLifecycleReadComposition,
  createTeamLifecycleReadHost,
} from '@main/composition/hosted/teamLifecycleReadComposition';
import { createTeamLifecycleReadOnlyIdentitySource } from '@main/composition/hosted/teamLifecycleReadOnlyIdentitySource';
import { registerTeamRoutes } from '@main/http/teams';
import { createQueryContext } from '@shared/contracts/hosted';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { HttpServices } from '@main/http';

const NOW_MS = Date.parse('2026-07-21T10:00:30.000Z');
const CREATED_AT = '2026-07-21T10:00:00.000Z';
const PUBLISHED_AT = '2026-07-21T10:00:10.000Z';
const COMMITTED_AT = '2026-07-21T10:00:20.000Z';
const TEAM_ID = `team_${'a'.repeat(32)}`;
const ADOPTION_INTENT_ID = `adoption_${'b'.repeat(32)}`;
const WORKSPACE_ID = `workspace_${'c'.repeat(32)}`;
const TEAM_NAME = 'sandbox-hosted-team';
const BOOT_ID = 'boot_team-lifecycle-read-network-e2e';
const DEPLOYMENT_ID = 'deployment_team-lifecycle-read-network-e2e';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function adoptionIntentChecksum(input: {
  readonly directoryFingerprint: string;
  readonly identityChecksum: string;
}): string {
  return sha256(
    JSON.stringify({
      schemaVersion: 1,
      intentId: ADOPTION_INTENT_ID,
      teamId: TEAM_ID,
      legacyKey: TEAM_NAME,
      directoryFingerprint: input.directoryFingerprint,
      workspaceId: WORKSPACE_ID,
      workspaceBindingGeneration: 1,
      expectedIdentityChecksum: input.identityChecksum,
      preparedAt: CREATED_AT,
    })
  );
}

describe('hosted team lifecycle list network E2E', () => {
  it('renders a committed sandbox team through the real hosted read and loopback HTTP path', async () => {
    let app: ReturnType<typeof Fastify> | null = null;
    let database: Database.Database | null = null;
    let reactRoot: ReturnType<(typeof import('react-dom/client'))['createRoot']> | null = null;
    let sandboxRoot: string | null = null;
    let previousLocation: string | null = null;
    const actEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

    try {
      sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-lifecycle-read-network-e2e-'));
      const claudeRoot = path.join(sandboxRoot, 'claude');
      const appDataRoot = path.join(sandboxRoot, 'app-data');
      const workspaceRoot = path.join(sandboxRoot, 'workspace');
      const tempRoot = path.join(sandboxRoot, 'temp');
      const logsRoot = path.join(sandboxRoot, 'logs');
      const teamRoot = path.join(claudeRoot, 'teams', TEAM_NAME);
      const storageRoot = path.join(appDataRoot, 'storage');
      await Promise.all([
        fs.mkdir(teamRoot, { recursive: true }),
        fs.mkdir(storageRoot, { recursive: true }),
        fs.mkdir(workspaceRoot, { recursive: true }),
        fs.mkdir(tempRoot, { recursive: true }),
        fs.mkdir(logsRoot, { recursive: true }),
      ]);

      const canonicalTeamRoot = await fs.realpath(teamRoot);
      const teamRootStat = await fs.lstat(canonicalTeamRoot, { bigint: true });
      const directoryFingerprint = sha256(
        JSON.stringify({
          schemaVersion: 1,
          canonicalPath: canonicalTeamRoot,
          device: teamRootStat.dev.toString(),
          inode: teamRootStat.ino.toString(),
        })
      );
      const serializedIdentity = `${JSON.stringify(
        { schemaVersion: 1, teamId: TEAM_ID, createdAt: CREATED_AT },
        null,
        2
      )}\n`;
      const identityChecksum = sha256(serializedIdentity);
      const intentChecksum = adoptionIntentChecksum({
        directoryFingerprint,
        identityChecksum,
      });
      await Promise.all([
        fs.writeFile(path.join(teamRoot, 'team.identity.json'), serializedIdentity),
        fs.writeFile(path.join(teamRoot, 'config.json'), JSON.stringify({ name: TEAM_NAME })),
      ]);

      database = new Database(path.join(storageRoot, 'app.db'));
      database.pragma('journal_mode = DELETE');
      for (const statement of TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS) {
        database.exec(statement);
      }
      database
        .prepare(
          `INSERT INTO team_identity_records (
            team_id, state, legacy_key, directory_fingerprint, workspace_id,
            workspace_binding_generation, adoption_intent_id, identity_checksum,
            created_at, activated_at, tombstoned_at
          ) VALUES (?, 'active', ?, ?, ?, 1, ?, ?, ?, ?, NULL)`
        )
        .run(
          TEAM_ID,
          TEAM_NAME,
          directoryFingerprint,
          WORKSPACE_ID,
          ADOPTION_INTENT_ID,
          identityChecksum,
          CREATED_AT,
          COMMITTED_AT
        );
      database
        .prepare(
          `INSERT INTO legacy_team_key_reservations (
            legacy_key, team_id, state, reserved_at, tombstoned_at, tombstone_reason
          ) VALUES (?, ?, 'active', ?, NULL, NULL)`
        )
        .run(TEAM_NAME, TEAM_ID, CREATED_AT);
      database
        .prepare(
          `INSERT INTO team_adoption_intents (
            intent_id, team_id, state, legacy_key, directory_fingerprint, workspace_id,
            workspace_binding_generation, expected_identity_checksum, intent_checksum,
            prepared_at, file_published_at, published_identity_checksum,
            committed_at, committed_identity_checksum
          ) VALUES (?, ?, 'committed', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          ADOPTION_INTENT_ID,
          TEAM_ID,
          TEAM_NAME,
          directoryFingerprint,
          WORKSPACE_ID,
          identityChecksum,
          intentChecksum,
          CREATED_AT,
          PUBLISHED_AT,
          identityChecksum,
          COMMITTED_AT,
          identityChecksum
        );

      // The production reader accepts only an immutable SQLite image with no live journal sidecar.
      database.close();
      database = null;

      const bootstrap = await new TeamLifecycleReadBootstrapSource({
        input: {
          readSerializedBootstrap: () =>
            JSON.stringify({
              format: TEAM_LIFECYCLE_READ_BOOTSTRAP_FORMAT,
              issuedAtMs: NOW_MS - 10_000,
              expiresAtMs: NOW_MS + 60_000,
              actorId: 'actor_team-lifecycle-read-network-e2e',
              authorizedScope: TEAM_LIFECYCLE_READ_AUTHORIZED_SCOPE,
              deploymentId: DEPLOYMENT_ID,
              bootId: BOOT_ID,
              workspaceId: WORKSPACE_ID,
              runtimeInstance: {
                deploymentId: DEPLOYMENT_ID,
                bootId: BOOT_ID,
                claudeRoot: { kind: 'claude', reference: claudeRoot },
                appDataRoot: { kind: 'app-data', reference: appDataRoot },
                workspaceRoots: [{ kind: 'workspace', reference: workspaceRoot }],
                tempRoot: { kind: 'temp', reference: tempRoot },
                logsRoot: { kind: 'logs', reference: logsRoot },
              },
              workspaceManifest: {
                version: 1,
                registrations: [
                  {
                    schemaVersion: 1,
                    registrationKey: 'sandbox.team-lifecycle-read.network-e2e',
                    workspaceId: WORKSPACE_ID,
                    displayName: 'Sandbox hosted lifecycle read',
                    registrationRevision: 1,
                    declaredRootHash: 'd'.repeat(64),
                    enabled: true,
                    mountBinding: {
                      bootId: BOOT_ID,
                      mountGeneration: 1,
                      observedAt: NOW_MS - 1_000,
                      health: 'read-only',
                      allowedOperations: [],
                    },
                  },
                ],
              },
            }),
        },
        nowMs: () => NOW_MS,
      }).load();
      const identitySource = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });
      expect(identitySource).not.toBeNull();

      const readPorts = createMountBindingScopedTeamLifecycleReadPorts({
        authority: bootstrap.authority,
        mountBinding: bootstrap.mountBinding,
        runtimeInstance: bootstrap.runtimeInstance,
        teamIdentities: identitySource!,
        nowMs: () => NOW_MS,
      });
      const composition = createTeamLifecycleReadComposition({
        authority: bootstrap.authority,
        ...readPorts,
        nowMs: () => NOW_MS,
      });
      let requestSequence = 0;
      const host = createTeamLifecycleReadHost(composition, (authority, signal) =>
        createQueryContext({
          actorId: authority.actorId,
          sessionId: 'session_team-lifecycle-read-network-e2e',
          deploymentId: authority.deploymentId,
          bootId: authority.bootId,
          requestId: `request_team-lifecycle-read-network-e2e-${++requestSequence}`,
          authorizedScope: authority.authorizedScope,
          deadlineAtMs: NOW_MS + 10_000,
          signal,
        })
      );

      app = Fastify();
      registerTeamRoutes(app, { teamLifecycleReadHost: host } as HttpServices);
      const listenerUrl = await app.listen({ host: '127.0.0.1', port: 0 });

      previousLocation = window.location.href;
      window.location.href = listenerUrl;
      expect(window.location.origin).toBe(new URL(listenerUrl).origin);
      expect(window.electronAPI).toBeUndefined();
      expect(vi.isMockFunction(globalThis.fetch)).toBe(false);
      vi.stubGlobal(
        'EventSource',
        class {
          onopen: (() => void) | null = null;
          onerror: (() => void) | null = null;

          addEventListener(): void {}
          close(): void {}
        }
      );
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

      const [React, ReactDOM, rendererApi, lifecycleRenderer, localizationRenderer] =
        await Promise.all([
          import('react'),
          import('react-dom/client'),
          import('@renderer/api'),
          import('@features/team-lifecycle/renderer'),
          import('@features/localization/renderer'),
        ]);
      const directResult = await rendererApi.api.listTeamLifecycle({
        schemaVersion: 1,
        cursor: null,
        expectedRevision: null,
      });
      expect(directResult).toMatchObject({ kind: 'success', items: [{ displayName: TEAM_NAME }] });
      const container = document.createElement('div');
      document.body.append(container);
      reactRoot = ReactDOM.createRoot(container);

      await React.act(async () => {
        reactRoot!.render(
          React.createElement(localizationRenderer.LocalizationProvider, {
            appConfig: null,
            children: React.createElement(lifecycleRenderer.HostedTeamLifecycleList, {
              transport: rendererApi.api,
            }),
          })
        );
        await Promise.resolve();
      });
      await React.act(async () => {
        await vi.waitFor(() => expect(requestSequence).toBe(2));
        await Promise.resolve();
      });
      await React.act(async () => {
        await vi.waitFor(() => expect(container.textContent).toContain(TEAM_NAME));
      });

      expect(container.querySelectorAll('li')).toHaveLength(1);
      expect(requestSequence).toBe(2);
    } finally {
      if (reactRoot) {
        const React = await import('react');
        React.act(() => reactRoot?.unmount());
      }
      document.body.innerHTML = '';
      if (app) await app.close();
      database?.close();
      if (sandboxRoot) await fs.rm(sandboxRoot, { recursive: true, force: true });
      if (previousLocation) window.location.href = previousLocation;
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      vi.unstubAllGlobals();
    }
  });
});
