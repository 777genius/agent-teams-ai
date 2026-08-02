/* eslint-disable @typescript-eslint/require-await -- Async test doubles implement promise-based composition ports synchronously. */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import {
  createHostedAccessFeature,
  type CreateHostedAccessFeatureDependencies,
} from '@features/hosted-access/main';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { TEAM_LIFECYCLE_READ_SCHEMA_VERSION } from '@features/team-lifecycle/contracts';
import { resolveHostedTeamWorkspaceId } from '@main/standalone';
import {
  parseCursor,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import Database from 'better-sqlite3-node';
import { describe, expect, it } from 'vitest';

import type { PairingDrainProofPort } from '@features/hosted-access';
import type { HostedAuthStorageGateway } from '@features/internal-storage/contracts';
import type { TeamLifecycleReadHost } from '@main/composition/hosted/teamLifecycleReadComposition';

function hostPlatform(): CreateHostedAccessFeatureDependencies['hostPlatform'] {
  return {
    uid: process.getuid?.(),
    pid: process.pid,
    join,
    dirname,
    isAbsolute,
    byteLength: Buffer.byteLength,
    mkdir: async (path, mode) => {
      await mkdir(path, { recursive: true, mode });
    },
    lstat,
    openReadOnlyNoFollow: async (path) => {
      const handle = await open(path, 'r');
      return {
        stat: () => handle.stat(),
        readTextBounded: async (maximumBytes) => {
          const stat = await handle.stat();
          if (stat.size > maximumBytes) throw new Error('test_secret_too_large');
          return handle.readFile('utf8');
        },
        close: () => handle.close(),
      };
    },
    chmod,
    writeTextDurable: async (path, body, options) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(path, options.exclusive ? 'wx' : 'w', options.mode);
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    rename,
    remove: (path, options) => rm(path, options),
    randomBytes,
    base64UrlEncode: (bytes) => Buffer.from(bytes).toString('base64url'),
    base64UrlDecode: (value) => Buffer.from(value, 'base64url'),
    hmacSha256: (key, parts, encoding) => {
      const hmac = createHmac('sha256', key);
      for (const part of parts) hmac.update(part);
      return hmac.digest(encoding);
    },
    hkdfSha256: (input, salt, info, length) =>
      new Uint8Array(hkdfSync('sha256', input, salt, Buffer.from(info), length)),
    sha256Base64Url: (value) => createHash('sha256').update(value).digest('base64url'),
    verifyOidcSignature: () => false,
    encryptAes256Gcm: (input) => {
      const cipher = createCipheriv('aes-256-gcm', input.key, input.nonce);
      cipher.setAAD(Buffer.from(input.aad));
      return {
        ciphertext: Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]),
        tag: cipher.getAuthTag(),
      };
    },
    decryptAes256Gcm: (input) => {
      const decipher = createDecipheriv('aes-256-gcm', input.key, input.nonce);
      decipher.setAAD(Buffer.from(input.aad));
      decipher.setAuthTag(Buffer.from(input.tag));
      return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString('utf8');
    },
    secureEqual: (left, right) => {
      const leftBytes = Buffer.from(left);
      const rightBytes = Buffer.from(right);
      return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
    },
  };
}

const unusedLocalControlTransport: CreateHostedAccessFeatureDependencies['localControlTransportFactory'] =
  {
    create: () => ({
      start: async () => undefined,
      close: async () => undefined,
    }),
  };

describe('hosted access composition', () => {
  it('resolves a team workspace from one bounded revision-pinned lifecycle snapshot', async () => {
    const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
    const otherTeamId = parseTeamId(`team_${'b'.repeat(32)}`);
    const workspaceId = parseWorkspaceId(`workspace_${'c'.repeat(32)}`);
    const otherWorkspaceId = parseWorkspaceId(`workspace_${'d'.repeat(32)}`);
    const revision = parseRevision('revision_synthetic-task-board-attribution');
    const nextCursor = parseCursor('cursor_synthetic-task-board-page-2');
    const observedRequests: unknown[] = [];
    const host: TeamLifecycleReadHost = {
      listTeamLifecycle: (request) => {
        observedRequests.push(request);
        if (observedRequests.length === 1) {
          return Promise.resolve({
            schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
            kind: 'success',
            snapshotRevision: revision,
            items: [
              {
                workspaceId: otherWorkspaceId,
                teamId: otherTeamId,
                displayName: 'Other',
                lifecycle: 'running',
                revision,
              },
            ],
            nextCursor,
          });
        }
        return Promise.resolve({
          schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
          kind: 'success',
          snapshotRevision: revision,
          items: [
            {
              workspaceId,
              teamId,
              displayName: 'Target',
              lifecycle: 'running',
              revision,
            },
          ],
          nextCursor: null,
        });
      },
    };

    await expect(resolveHostedTeamWorkspaceId(host, teamId)).resolves.toBe(workspaceId);
    expect(observedRequests).toEqual([
      {
        schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
        cursor: null,
        expectedRevision: null,
      },
      {
        schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
        cursor: nextCursor,
        expectedRevision: revision,
      },
    ]);
  });

  it('rejects ambiguous team attribution across lifecycle pages', async () => {
    const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
    const firstWorkspaceId = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);
    const secondWorkspaceId = parseWorkspaceId(`workspace_${'c'.repeat(32)}`);
    const revision = parseRevision('revision_synthetic-task-board-duplicate');
    const nextCursor = parseCursor('cursor_synthetic-task-board-duplicate-page');
    let page = 0;
    const host: TeamLifecycleReadHost = {
      listTeamLifecycle: () =>
        Promise.resolve({
          schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
          kind: 'success',
          snapshotRevision: revision,
          items: [
            {
              workspaceId: page++ === 0 ? firstWorkspaceId : secondWorkspaceId,
              teamId,
              displayName: 'Duplicate',
              lifecycle: 'running',
              revision,
            },
          ],
          nextCursor: page === 1 ? nextCursor : null,
        }),
    };

    await expect(resolveHostedTeamWorkspaceId(host, teamId)).resolves.toBeNull();
  });

  it('fails closed on cyclic and overlong lifecycle pagination', async () => {
    const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
    const revision = parseRevision('revision_synthetic-task-board-bounds');
    const cursor = parseCursor('cursor_synthetic-task-board-cycle');
    const cyclicHost: TeamLifecycleReadHost = {
      listTeamLifecycle: () =>
        Promise.resolve({
          schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
          kind: 'success',
          snapshotRevision: revision,
          items: [],
          nextCursor: cursor,
        }),
    };
    let pages = 0;
    const overlongHost: TeamLifecycleReadHost = {
      listTeamLifecycle: () =>
        Promise.resolve({
          schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
          kind: 'success',
          snapshotRevision: revision,
          items: [],
          nextCursor: parseCursor(`cursor_synthetic-task-board-page-${++pages}`),
        }),
    };

    await expect(resolveHostedTeamWorkspaceId(cyclicHost, teamId)).resolves.toBeNull();
    await expect(resolveHostedTeamWorkspaceId(overlongHost, teamId)).resolves.toBeNull();
    expect(pages).toBe(16);
  });

  it('forces explicit AUTH_MODE standalone deployments through hosted root admission', async () => {
    const source = await readFile('src/main/standalone.ts', 'utf8');

    expect(source).toContain(
      'serializedHostedBootstrap !== undefined || process.env.AUTH_MODE !== undefined'
    );
    expect(source).toContain('setClaudeBasePathOverride(admitHostedReadRoot(CLAUDE_ROOT))');
    expect(source).toContain('if (hostedMode) localContext.startCacheOnly()');
    expect(source).toContain('else localContext.start()');
  });

  it('rejects OIDC client secrets supplied through the process environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hosted-auth-composition-'));
    const storage: HostedAuthStorageGateway = {
      hostedAuthCall: async (operation) => {
        if (operation === 'configuration.claimMode') return true;
        throw new Error(`unexpected_storage_operation:${operation}`);
      },
    };
    const drainProof: PairingDrainProofPort = {
      confirmDrained: async () => ({ status: 'unavailable' }),
    };

    try {
      await expect(
        createHostedAccessFeature({
          environment: {
            AUTH_MODE: 'oidc',
            AUTH_PUBLIC_ORIGIN: 'https://agent-teams.example.test',
            OIDC_ISSUER: 'https://identity.example.test',
            OIDC_CLIENT_ID: 'agent-teams',
            OIDC_CLIENT_SECRET: 'must-not-enter-the-process-environment',
          },
          storage,
          dataDirectory: directory,
          hostPlatform: hostPlatform(),
          localControlTransportFactory: unusedLocalControlTransport,
          drainProof,
          runWithBrowserStreamsDrained: (operation) => operation(),
        })
      ).rejects.toThrow('hosted_auth_config_forbidden:OIDC_CLIENT_SECRET');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous OIDC role mappings before claiming the durable auth mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hosted-auth-role-mapping-'));
    const storage: HostedAuthStorageGateway = {
      hostedAuthCall: async () => {
        throw new Error('storage_must_not_be_touched_for_invalid_role_mapping');
      },
    };

    try {
      await expect(
        createHostedAccessFeature({
          environment: {
            AUTH_MODE: 'oidc',
            AUTH_PUBLIC_ORIGIN: 'https://agent-teams.example.test',
            OIDC_ISSUER: 'https://identity.example.test',
            OIDC_CLIENT_ID: 'agent-teams',
            OIDC_OWNER_ROLE_VALUES: 'shared-provider-role',
            OIDC_MEMBER_ROLE_VALUES: 'shared-provider-role',
          },
          storage,
          dataDirectory: directory,
          hostPlatform: hostPlatform(),
          localControlTransportFactory: unusedLocalControlTransport,
          runWithBrowserStreamsDrained: (operation) => operation(),
        })
      ).rejects.toThrow('hosted_auth_config_invalid:oidc_role_mapping_ambiguous');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['AUTH_SESSION_IDLE_MS', '0', 'hosted_auth_config_invalid:AUTH_SESSION_IDLE_MS'],
    [
      'AUTH_SESSION_IDLE_MS',
      String(60 * 60_000 + 1),
      'hosted_auth_config_invalid:AUTH_SESSION_IDLE_MS',
    ],
    [
      'AUTH_SESSION_ABSOLUTE_MS',
      String(5 * 60_000 - 1),
      'hosted_auth_config_invalid:AUTH_SESSION_ABSOLUTE_MS',
    ],
    [
      'AUTH_SESSION_ABSOLUTE_MS',
      String(24 * 60 * 60_000 + 1),
      'hosted_auth_config_invalid:AUTH_SESSION_ABSOLUTE_MS',
    ],
  ])('bounds OIDC session policy when %s=%s', async (name, value, expectedError) => {
    const directory = await mkdtemp(join(tmpdir(), 'hosted-auth-session-policy-'));
    const storage: HostedAuthStorageGateway = {
      hostedAuthCall: async () => {
        throw new Error('storage_must_not_be_touched_for_invalid_session_policy');
      },
    };

    try {
      await expect(
        createHostedAccessFeature({
          environment: {
            AUTH_MODE: 'oidc',
            AUTH_PUBLIC_ORIGIN: 'https://agent-teams.example.test',
            OIDC_ISSUER: 'https://identity.example.test',
            OIDC_CLIENT_ID: 'agent-teams',
            [name]: value,
          },
          storage,
          dataDirectory: directory,
          hostPlatform: hostPlatform(),
          localControlTransportFactory: unusedLocalControlTransport,
          runWithBrowserStreamsDrained: (operation) => operation(),
        })
      ).rejects.toThrow(expectedError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an OIDC idle session lifetime longer than its absolute lifetime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hosted-auth-session-policy-'));
    const storage: HostedAuthStorageGateway = {
      hostedAuthCall: async () => {
        throw new Error('storage_must_not_be_touched_for_invalid_session_policy');
      },
    };

    try {
      await expect(
        createHostedAccessFeature({
          environment: {
            AUTH_MODE: 'oidc',
            AUTH_PUBLIC_ORIGIN: 'https://agent-teams.example.test',
            OIDC_ISSUER: 'https://identity.example.test',
            OIDC_CLIENT_ID: 'agent-teams',
            AUTH_SESSION_IDLE_MS: String(30 * 60_000),
            AUTH_SESSION_ABSOLUTE_MS: String(10 * 60_000),
          },
          storage,
          dataDirectory: directory,
          hostPlatform: hostPlatform(),
          localControlTransportFactory: unusedLocalControlTransport,
          runWithBrowserStreamsDrained: (operation) => operation(),
        })
      ).rejects.toThrow('hosted_auth_config_invalid:AUTH_SESSION_IDLE_MS');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a public origin that disagrees with the hosted HTTPS listener port', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hosted-auth-origin-port-'));
    const storage: HostedAuthStorageGateway = {
      hostedAuthCall: async () => {
        throw new Error('storage_must_not_be_touched_for_invalid_origin_port');
      },
    };

    try {
      await expect(
        createHostedAccessFeature({
          environment: {
            AUTH_MODE: 'oidc',
            AUTH_PUBLIC_ORIGIN: 'https://agent-teams.example.test',
            HOSTED_HTTPS_PORT: '8443',
            OIDC_ISSUER: 'https://identity.example.test',
            OIDC_CLIENT_ID: 'agent-teams',
          },
          storage,
          dataDirectory: directory,
          hostPlatform: hostPlatform(),
          localControlTransportFactory: unusedLocalControlTransport,
          runWithBrowserStreamsDrained: (operation) => operation(),
        })
      ).rejects.toThrow('hosted_auth_config_invalid:HOSTED_HTTPS_PORT');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['identity-key', 'staged-keyring'] as const)(
    'rejects an AUTH_KEYRING_FILE collision with the %s recovery path',
    async (collision) => {
      const directory = await mkdtemp(join(tmpdir(), 'hosted-auth-keyring-path-'));
      const identityKeyPath = join(directory, 'hosted-auth-secrets', 'identity.key');
      const keyringPath =
        collision === 'identity-key'
          ? identityKeyPath
          : join(directory, 'hosted-auth-secrets', 'staged', 'active.json');
      const storage: HostedAuthStorageGateway = {
        hostedAuthCall: () =>
          Promise.reject(new Error('storage_must_not_be_touched_for_invalid_keyring_path')),
      };

      try {
        await expect(
          createHostedAccessFeature({
            environment: {
              AUTH_MODE: 'oidc',
              AUTH_PUBLIC_ORIGIN: 'https://agent-teams.example.test',
              AUTH_IDENTITY_KEY_FILE: identityKeyPath,
              AUTH_KEYRING_FILE: keyringPath,
              OIDC_ISSUER: 'https://identity.example.test',
              OIDC_CLIENT_ID: 'agent-teams',
            },
            storage,
            dataDirectory: directory,
            hostPlatform: hostPlatform(),
            localControlTransportFactory: unusedLocalControlTransport,
            runWithBrowserStreamsDrained: (operation) => operation(),
          })
        ).rejects.toThrow('hosted_auth_config_invalid:AUTH_KEYRING_FILE');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('recovers crash-safely across explicit OIDC/personal mode resets and rotates both key stores', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hosted-auth-mode-reset-'));
    const identityKeyPath = join(directory, 'secrets', 'identity.key');
    const personalKeyringPath = join(directory, 'secrets', 'personal-keyring.json');
    const pairingCodePath = join(directory, 'pairing.json');
    await mkdir(dirname(identityKeyPath), { recursive: true, mode: 0o700 });
    const originalIdentityKey = Buffer.alloc(32, 7).toString('base64url');
    await writeFile(identityKeyPath, originalIdentityKey, { mode: 0o600 });
    const core = new InternalStorageWorkerCore({
      databasePath: join(directory, 'internal.sqlite'),
      createDatabase: (path, options) => new Database(path, options),
    });
    const storage: HostedAuthStorageGateway = {
      hostedAuthCall: async (operation, payload) =>
        core.handle('hostedAuth.call', { operation, payload }),
    };
    const observedDrainProofs: unknown[] = [];
    let hostResetDrainedResponsesRemaining = Number.POSITIVE_INFINITY;
    const drainProof: PairingDrainProofPort = {
      confirmDrained: async (input) => {
        observedDrainProofs.push(input);
        if (input.purpose === 'host_reset') {
          if (hostResetDrainedResponsesRemaining <= 0) return { status: 'unavailable' };
          hostResetDrainedResponsesRemaining -= 1;
        }
        return {
          status: 'drained',
          evidenceRef: `synthetic:${input.purpose}:${input.targetAuthMode ?? 'none'}:${input.resetGeneration}`,
        };
      },
    };
    const common = {
      storage,
      dataDirectory: directory,
      hostPlatform: hostPlatform(),
      localControlTransportFactory: unusedLocalControlTransport,
      drainProof,
      noRuntimeMutationAtStartup: true as const,
      runWithBrowserStreamsDrained: <Value>(operation: () => Promise<Value>) => operation(),
      now: () => 10_000,
    };
    const oidcEnvironment = {
      NODE_ENV: 'test',
      AUTH_ALLOW_INSECURE_HTTP_FOR_TESTS: '1',
      AUTH_MODE: 'oidc',
      AUTH_PUBLIC_ORIGIN: 'http://agent-teams.test',
      AUTH_DEPLOYMENT_ID: 'deployment_mode-reset-e2e',
      AUTH_IDENTITY_KEY_FILE: identityKeyPath,
      AUTH_KEYRING_FILE: personalKeyringPath,
      PAIRING_CODE_FILE: pairingCodePath,
      OIDC_ISSUER: 'https://identity.example.test',
      OIDC_CLIENT_ID: 'agent-teams',
    } as const;
    const personalEnvironment = {
      NODE_ENV: 'test',
      AUTH_ALLOW_INSECURE_HTTP_FOR_TESTS: '1',
      AUTH_MODE: 'personal',
      AUTH_PUBLIC_ORIGIN: 'http://agent-teams.test',
      AUTH_DEPLOYMENT_ID: 'deployment_mode-reset-e2e',
      AUTH_IDENTITY_KEY_FILE: identityKeyPath,
      AUTH_KEYRING_FILE: personalKeyringPath,
      PAIRING_CODE_FILE: pairingCodePath,
    } as const;

    try {
      const oidc = await createHostedAccessFeature({ ...common, environment: oidcEnvironment });
      expect(oidc.deploymentId).toBe('deployment_mode-reset-e2e');
      await expect(oidc.localAdministration.resetAuthMode('personal', 1)).resolves.toEqual({
        mode: 'personal',
        resetGeneration: 1,
        restartRequired: true,
      });
      expect(await readFile(identityKeyPath, 'utf8')).toBe(originalIdentityKey);
      const pendingConfiguration = (await storage.hostedAuthCall('configuration.read', {})) as {
        readonly pendingPersonalKeyringId: string;
      };
      const interruptedActivationPath = `${personalKeyringPath}.activate-${process.pid}`;
      await writeFile(
        interruptedActivationPath,
        await readFile(
          join(
            directory,
            'hosted-auth-secrets',
            'staged',
            `${pendingConfiguration.pendingPersonalKeyringId}.json`
          )
        ),
        { mode: 0o600 }
      );
      await expect(
        createHostedAccessFeature({ ...common, environment: oidcEnvironment })
      ).rejects.toThrow('hosted_auth_mode_change_requires_host_reset');

      const personal = await createHostedAccessFeature({
        ...common,
        environment: personalEnvironment,
      });
      expect(await readFile(identityKeyPath, 'utf8')).not.toBe(originalIdentityKey);
      await expect(lstat(interruptedActivationPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const firstKeyring = JSON.parse(await readFile(personalKeyringPath, 'utf8')) as {
        keyringId: string;
      };
      expect(JSON.parse(await readFile(pairingCodePath, 'utf8'))).toMatchObject({
        expiresAt: 10_000 + 10 * 60_000,
      });
      expect(await storage.hostedAuthCall('configuration.read', {})).toMatchObject({
        authMode: 'personal',
        resetGeneration: 1,
        secretsRotatedGeneration: 1,
        pendingPersonalKeyringId: null,
      });

      const pairingBeforeInterruptedReset = await readFile(pairingCodePath, 'utf8');
      // Local administration preflights the evidence before blocking public
      // access. Expire it at the authority's second validation to model the
      // indeterminate transition that startup must recover.
      hostResetDrainedResponsesRemaining = 1;
      await expect(personal.localAdministration.resetPersonal(2)).rejects.toThrow(
        'hosted_local_control_pairing_drain_unconfirmed'
      );
      hostResetDrainedResponsesRemaining = Number.POSITIVE_INFINITY;
      const recoveredPersonal = await createHostedAccessFeature({
        ...common,
        environment: personalEnvironment,
      });
      expect(await readFile(pairingCodePath, 'utf8')).not.toBe(pairingBeforeInterruptedReset);

      await expect(recoveredPersonal.localAdministration.resetAuthMode('oidc', 3)).resolves.toEqual(
        {
          mode: 'oidc',
          resetGeneration: 3,
          restartRequired: true,
        }
      );
      const oidcAfterRestart = await createHostedAccessFeature({
        ...common,
        environment: oidcEnvironment,
      });
      expect(oidcAfterRestart.mode).toBe('oidc');
      const secondKeyring = JSON.parse(await readFile(personalKeyringPath, 'utf8')) as {
        keyringId: string;
      };
      expect(secondKeyring.keyringId).not.toBe(firstKeyring.keyringId);
      expect(await storage.hostedAuthCall('configuration.read', {})).toMatchObject({
        authMode: 'oidc',
        resetGeneration: 3,
        secretsRotatedGeneration: 3,
        pendingPersonalKeyringId: null,
      });
      expect(observedDrainProofs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            purpose: 'auth_mode_reset',
            targetAuthMode: 'personal',
            resetGeneration: 1,
          }),
          expect.objectContaining({
            purpose: 'host_reset',
            resetGeneration: 2,
          }),
          expect.objectContaining({
            purpose: 'auth_mode_reset',
            targetAuthMode: 'oidc',
            resetGeneration: 3,
          }),
        ])
      );
    } finally {
      core.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
