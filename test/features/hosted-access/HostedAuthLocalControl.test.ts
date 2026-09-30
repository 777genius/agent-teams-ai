/* eslint-disable @typescript-eslint/require-await -- Async test doubles implement local-control ports synchronously. */

import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { HostedLocalAdministration } from '@features/hosted-access';
import { executeHostedAuthLocalControlRequest } from '@features/hosted-access/main/adapters/input/local/HostedAuthLocalControlServer';
import { FileHostedPairingDrainProof } from '@features/hosted-access/main/infrastructure/NodePersonalAuthorityAdapters';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  HostedAccessAuthority,
  HostedAuthHostPlatform,
  HostedIdentityRepositoryPort,
  HostedIdentityService,
} from '@features/hosted-access';

const directories: string[] = [];
const proofPlatform = {
  uid: process.getuid?.(),
  pid: process.pid,
  join,
  dirname,
  isAbsolute,
  lstat: (path: string) => Promise.resolve(lstatSync(path)),
  openReadOnlyNoFollow: async (path: string) => {
    const handle = await open(path, 'r');
    return {
      stat: () => handle.stat(),
      readTextBounded: async (maximumBytes: number) => {
        const stat = await handle.stat();
        if (stat.size > maximumBytes) throw new Error('test_file_too_large');
        return handle.readFile('utf8');
      },
      close: () => handle.close(),
    };
  },
} as unknown as HostedAuthHostPlatform;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function directory(): string {
  // Unix socket paths are capped at roughly 108 bytes on Linux.
  const value = mkdtempSync(join(process.cwd(), '.hatc-'));
  directories.push(value);
  return value;
}

function externalDirectory(): string {
  const value = mkdtempSync(join(tmpdir(), 'hosted-auth-cli-'));
  directories.push(value);
  return value;
}

describe.skipIf(process.platform === 'win32')('hosted auth local control', () => {
  it('preflights an external secrets directory and rejects repository build-context paths', () => {
    const scriptPath = join(process.cwd(), 'scripts/hosted-auth-cli.mjs');
    const doubleDotPrefixDirectory = mkdtempSync(join(process.cwd(), '..hosted-auth-cli-'));
    directories.push(doubleDotPrefixDirectory);
    const runPreflight = (secretsDirectory: string) =>
      spawnSync(process.execPath, [scriptPath, 'preflight'], {
        encoding: 'utf8',
        env: { ...process.env, HOSTED_SECRETS_DIR: secretsDirectory },
      });
    const errorMessage =
      'Hosted authentication preflight failed: HOSTED_SECRETS_DIR must resolve to an existing absolute directory outside the repository Docker build context.\n';

    for (const rejectedPath of [
      'docker/secrets',
      process.cwd(),
      join(process.cwd(), 'docker'),
      doubleDotPrefixDirectory,
    ]) {
      const rejected = runPreflight(rejectedPath);
      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).toBe(errorMessage);
    }

    const external = runPreflight(externalDirectory());
    expect(external.status, external.stderr).toBe(0);
    expect(external.stdout).toBe('{\n  "ready": true\n}\n');
    expect(external.stderr).toBe('');
  });

  it('reads pairing delivery through a bounded no-follow CLI boundary', () => {
    const root = directory();
    const deliveryPath = join(root, 'pairing.json');
    const pairingCode = 'x'.repeat(43);
    const challengeId = 'pch_synthetic-cli-1234';
    const runPairingCode = () =>
      spawnSync(
        process.execPath,
        [join(process.cwd(), 'scripts/hosted-auth-cli.mjs'), 'pairing-code'],
        {
          encoding: 'utf8',
          env: { ...process.env, PAIRING_CODE_FILE: deliveryPath },
        }
      );
    writeFileSync(
      deliveryPath,
      JSON.stringify({
        challengeId,
        pairingCode,
        expiresAt: Date.now() + 60_000,
      }),
      { mode: 0o600 }
    );

    const success = runPairingCode();
    expect(success.status, success.stderr).toBe(0);
    expect(success.stdout).toBe(`${pairingCode}\n`);
    expect(success.stderr).toBe('');

    rmSync(deliveryPath);
    const linkedTarget = join(root, 'linked-target.json');
    writeFileSync(
      linkedTarget,
      JSON.stringify({ challengeId, pairingCode, expiresAt: Date.now() + 60_000 }),
      { mode: 0o600 }
    );
    symlinkSync(linkedTarget, deliveryPath);
    const linked = runPairingCode();
    expect(linked.status).toBe(1);
    expect(linked.stdout).toBe('');
    expect(linked.stderr).toBe('Pairing challenge is unavailable or expired.\n');
    expect(linked.stderr).not.toContain(pairingCode);

    rmSync(deliveryPath);
    writeFileSync(deliveryPath, 'x'.repeat(4 * 1024 + 1), { mode: 0o600 });
    const oversized = runPairingCode();
    expect(oversized.status).toBe(1);
    expect(oversized.stdout).toBe('');
    expect(oversized.stderr).toBe('Pairing challenge is unavailable or expired.\n');
  });

  it('dispatches an exact local-only command inventory', async () => {
    const administration = {
      listUsers: vi.fn(async () => []),
      setUserStatus: vi.fn(async () => true),
      setLocalRole: vi.fn(async () => undefined),
      clearLocalRole: vi.fn(async () => true),
      listWorkspaces: vi.fn(async () => []),
      registerWorkspace: vi.fn(async () => ({
        workspaceId: '-synthetic',
        displayName: 'Synthetic',
        status: 'active',
        registeredAt: 100,
        registeredBy: null,
      })),
      disableWorkspace: vi.fn(async () => true),
      grantWorkspace: vi.fn(async () => ({
        workspaceId: 'workspace_0123456789abcdef0123456789abcdef',
      })),
      revokeWorkspaceGrant: vi.fn(async () => true),
      resetPersonal: vi.fn(async (resetGeneration: number) => ({ resetGeneration })),
      resetAuthMode: vi.fn(async (mode: 'personal' | 'oidc', resetGeneration: number) => ({
        mode,
        resetGeneration,
        restartRequired: true as const,
      })),
    } as unknown as HostedLocalAdministration;
    await expect(
      executeHostedAuthLocalControlRequest(
        administration,
        JSON.stringify({
          version: 1,
          command: 'roles.set',
          arguments: { userId: 'usr_synthetic-1234', role: 'owner' },
        })
      )
    ).resolves.toEqual({
      updated: true,
      effectiveAfter: 'reauthentication',
    });
    expect(administration.setLocalRole).toHaveBeenCalledWith('usr_synthetic-1234', 'owner');
    await expect(
      executeHostedAuthLocalControlRequest(
        administration,
        JSON.stringify({
          version: 1,
          command: 'users.disable',
          arguments: { userId: 'usr_synthetic-1234' },
        })
      )
    ).resolves.toEqual({ changed: true });
    expect(administration.setUserStatus).toHaveBeenCalledWith('usr_synthetic-1234', 'disabled');
    await expect(
      executeHostedAuthLocalControlRequest(
        administration,
        JSON.stringify({
          version: 1,
          command: 'auth-mode.reset',
          arguments: { targetMode: 'personal', resetGeneration: 9 },
        })
      )
    ).resolves.toEqual({
      mode: 'personal',
      resetGeneration: 9,
      restartRequired: true,
    });
    expect(administration.resetAuthMode).toHaveBeenCalledWith('personal', 9);
    await expect(
      executeHostedAuthLocalControlRequest(
        administration,
        JSON.stringify({
          version: 1,
          command: 'workspaces.grant',
          arguments: {
            userId: 'usr_synthetic-1234',
            workspaceId: 'runtime-synthetic',
          },
        })
      )
    ).resolves.toEqual({ workspaceId: 'workspace_0123456789abcdef0123456789abcdef' });
    expect(administration.grantWorkspace).toHaveBeenCalledWith(
      'usr_synthetic-1234',
      'runtime-synthetic'
    );
    await expect(
      executeHostedAuthLocalControlRequest(
        administration,
        JSON.stringify({
          version: 1,
          command: 'workspaces.revoke',
          arguments: {
            userId: 'usr_synthetic-1234',
            workspaceId: 'runtime-synthetic',
          },
        })
      )
    ).resolves.toEqual({ revoked: true });
    expect(administration.revokeWorkspaceGrant).toHaveBeenCalledWith(
      'usr_synthetic-1234',
      'runtime-synthetic'
    );
    await expect(
      executeHostedAuthLocalControlRequest(
        administration,
        JSON.stringify({ version: 1, command: 'unknown', arguments: {} })
      )
    ).rejects.toThrow('hosted_local_control_command_unknown');
    await expect(
      executeHostedAuthLocalControlRequest(
        administration,
        JSON.stringify({
          version: 1,
          command: 'users.list',
          arguments: { ignored: true },
        })
      )
    ).rejects.toThrow('hosted_local_control_argument_invalid');
  });

  it('accepts host reset only with exact, current AR drain evidence', async () => {
    const root = directory();
    const evidencePath = join(root, 'drain-proof.json');
    const proof = new FileHostedPairingDrainProof(
      evidencePath,
      {
        noRuntimeMutationAtStartup: true,
        now: () => 1_000,
      },
      proofPlatform
    );
    const binding = {
      deploymentId: 'deployment_synthetic-1234' as never,
      restoreGeneration: 3,
    };

    await expect(
      proof.confirmDrained({ binding, purpose: 'initial_pairing', resetGeneration: 0 })
    ).resolves.toMatchObject({ status: 'drained' });
    await expect(
      proof.confirmDrained({ binding, purpose: 'host_reset', resetGeneration: 4 })
    ).resolves.toEqual({ status: 'unavailable' });

    writeFileSync(
      evidencePath,
      JSON.stringify({
        format: 'agent-teams-runtime-drain/v1',
        deploymentId: binding.deploymentId,
        restoreGeneration: 3,
        purpose: 'host_reset',
        resetGeneration: 4,
        outcome: 'drained',
        evidenceRef: 'ar:drain:synthetic-4',
        observedAt: 900,
        expiresAt: 1_500,
      }),
      { mode: 0o600 }
    );
    await expect(
      proof.confirmDrained({ binding, purpose: 'host_reset', resetGeneration: 4 })
    ).resolves.toEqual({ status: 'drained', evidenceRef: 'ar:drain:synthetic-4' });
    await expect(
      proof.confirmDrained({ binding, purpose: 'host_reset', resetGeneration: 5 })
    ).resolves.toEqual({ status: 'unclassified' });
    writeFileSync(
      evidencePath,
      JSON.stringify({
        format: 'agent-teams-runtime-drain/v1',
        deploymentId: binding.deploymentId,
        restoreGeneration: 3,
        purpose: 'auth_mode_reset',
        targetAuthMode: 'personal',
        resetGeneration: 8,
        outcome: 'drained',
        evidenceRef: 'ar:drain:auth-mode-personal-8',
        observedAt: 900,
        expiresAt: 1_500,
      }),
      { mode: 0o600 }
    );
    await expect(
      proof.confirmDrained({
        binding,
        purpose: 'auth_mode_reset',
        targetAuthMode: 'personal',
        resetGeneration: 8,
      })
    ).resolves.toEqual({
      status: 'drained',
      evidenceRef: 'ar:drain:auth-mode-personal-8',
    });
    await expect(
      proof.confirmDrained({
        binding,
        purpose: 'auth_mode_reset',
        targetAuthMode: 'oidc',
        resetGeneration: 8,
      })
    ).resolves.toEqual({ status: 'unclassified' });
    chmodSync(evidencePath, 0o644);
    await expect(
      proof.confirmDrained({ binding, purpose: 'host_reset', resetGeneration: 4 })
    ).resolves.toEqual({ status: 'unclassified' });
  });

  it('drains browser streams and requests around the complete personal reset transition', async () => {
    let browserDrainCalls = 0;
    const sequence: string[] = [];
    const runWithBrowserStreamsDrained = async <Value>(
      operation: () => Promise<Value>
    ): Promise<Value> => {
      browserDrainCalls += 1;
      return operation();
    };
    const auditLocalControl = vi.fn(async () => {
      sequence.push('audit');
    });
    const consumeResetGeneration = vi.fn(async () => {
      sequence.push('reset');
      return {
        ok: true as const,
        code: 'reset_completed' as const,
        value: {
          resetGeneration: 2,
          challengeId: 'pch_synthetic-1234' as never,
        },
      };
    });
    const administration = new HostedLocalAdministration({
      mode: 'personal',
      binding: {
        deploymentId: 'deployment_synthetic-1234' as never,
        restoreGeneration: 0,
      },
      authority: { consumeResetGeneration } as unknown as HostedAccessAuthority,
      identities: { auditLocalControl } as unknown as HostedIdentityService,
      repository: {} as HostedIdentityRepositoryPort,
      now: () => 1_000,
      runWithBrowserStreamsDrained,
      drainProof: {
        confirmDrained: async () => ({
          status: 'drained',
          evidenceRef: 'ar:drain:personal-reset-2',
        }),
      },
      blockPublicAccess: async () => {
        sequence.push('block');
      },
      restorePublicAccess: () => {
        sequence.push('restore');
      },
      performAuthModeReset: async () => 'authority_conflict',
    });

    await expect(administration.resetPersonal(2)).resolves.toEqual({ resetGeneration: 2 });
    expect(browserDrainCalls).toBe(1);
    expect(consumeResetGeneration).toHaveBeenCalledOnce();
    expect(auditLocalControl).toHaveBeenCalledWith('auth.local.personal-reset', 'success', {
      resetGeneration: 2,
    });
    expect(sequence).toEqual(['block', 'reset', 'audit', 'restore']);
  });

  it('serializes personal resets before either operation can reopen public access', async () => {
    let releaseBlock = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseBlock = resolve;
    });
    const blockPublicAccess = vi.fn(() => blocked);
    const restorePublicAccess = vi.fn();
    const administration = new HostedLocalAdministration({
      mode: 'personal',
      binding: {
        deploymentId: 'deployment_synthetic-1234' as never,
        restoreGeneration: 0,
      },
      authority: {
        consumeResetGeneration: () =>
          Promise.resolve({
            ok: true as const,
            code: 'reset_completed' as const,
            value: {
              resetGeneration: 2,
              challengeId: 'pch_synthetic-1234' as never,
            },
          }),
      } as unknown as HostedAccessAuthority,
      identities: {
        auditLocalControl: () => Promise.resolve(),
      } as unknown as HostedIdentityService,
      repository: {} as HostedIdentityRepositoryPort,
      now: () => 1_000,
      runWithBrowserStreamsDrained: (operation) => operation(),
      drainProof: {
        confirmDrained: () =>
          Promise.resolve({
            status: 'drained',
            evidenceRef: 'ar:drain:personal-reset-2',
          }),
      },
      blockPublicAccess,
      restorePublicAccess,
      performAuthModeReset: () => Promise.resolve('authority_conflict'),
    });

    const first = administration.resetPersonal(2);
    await vi.waitFor(() => expect(blockPublicAccess).toHaveBeenCalledOnce());
    await expect(administration.resetPersonal(2)).rejects.toThrow(
      'hosted_local_control_personal_reset_in_progress'
    );
    releaseBlock();
    await expect(first).resolves.toEqual({ resetGeneration: 2 });
    expect(restorePublicAccess).toHaveBeenCalledOnce();
  });

  it('keeps public requests blocked when a personal reset cannot reach a determinate completion', async () => {
    const blockPublicAccess = vi.fn(() => Promise.resolve());
    const restorePublicAccess = vi.fn();
    const auditLocalControl = vi.fn(() => Promise.resolve());
    const administration = new HostedLocalAdministration({
      mode: 'personal',
      binding: {
        deploymentId: 'deployment_synthetic-1234' as never,
        restoreGeneration: 0,
      },
      authority: {
        consumeResetGeneration: () =>
          Promise.resolve({
            ok: false as const,
            code: 'pairing_drain_unconfirmed' as const,
          }),
      } as unknown as HostedAccessAuthority,
      identities: { auditLocalControl } as unknown as HostedIdentityService,
      repository: {} as HostedIdentityRepositoryPort,
      now: () => 1_000,
      runWithBrowserStreamsDrained: (operation) => operation(),
      drainProof: {
        confirmDrained: () =>
          Promise.resolve({
            status: 'drained',
            evidenceRef: 'ar:drain:personal-reset-2',
          }),
      },
      blockPublicAccess,
      restorePublicAccess,
      performAuthModeReset: () => Promise.resolve('authority_conflict'),
    });

    await expect(administration.resetPersonal(2)).rejects.toThrow(
      'hosted_local_control_pairing_drain_unconfirmed'
    );
    expect(blockPublicAccess).toHaveBeenCalledOnce();
    expect(restorePublicAccess).not.toHaveBeenCalled();
    expect(auditLocalControl).toHaveBeenCalledWith('auth.local.personal-reset', 'denied', {
      resetGeneration: 2,
      reason: 'pairing_drain_unconfirmed',
    });
  });

  it('rejects missing personal-reset drain evidence before blocking public access', async () => {
    const consumeResetGeneration = vi.fn();
    const blockPublicAccess = vi.fn();
    const auditLocalControl = vi.fn(() => Promise.resolve());
    const administration = new HostedLocalAdministration({
      mode: 'personal',
      binding: {
        deploymentId: 'deployment_synthetic-1234' as never,
        restoreGeneration: 0,
      },
      authority: { consumeResetGeneration } as unknown as HostedAccessAuthority,
      identities: { auditLocalControl } as unknown as HostedIdentityService,
      repository: {} as HostedIdentityRepositoryPort,
      now: () => 1_000,
      runWithBrowserStreamsDrained: (operation) => operation(),
      drainProof: { confirmDrained: () => Promise.resolve({ status: 'unavailable' }) },
      blockPublicAccess,
      restorePublicAccess: vi.fn(),
      performAuthModeReset: () => Promise.resolve('authority_conflict'),
    });

    await expect(administration.resetPersonal(2)).rejects.toThrow(
      'hosted_local_control_pairing_drain_unconfirmed'
    );
    expect(blockPublicAccess).not.toHaveBeenCalled();
    expect(consumeResetGeneration).not.toHaveBeenCalled();
    expect(auditLocalControl).toHaveBeenCalledWith('auth.local.personal-reset', 'denied', {
      resetGeneration: 2,
      reason: 'drain_unavailable',
    });
  });

  it('requires target-bound drain proof and keeps public access closed after auth-mode commit', async () => {
    const sequence: string[] = [];
    let publicAccessActive = true;
    const auditEvent = {
      eventId: 'aud_auth-mode-reset-1',
      occurredAt: 1_000,
      userId: null,
      sessionId: null,
      action: 'auth.local.auth-mode-reset',
      outcome: 'success',
      sourceIpHash: null,
      details: {},
    };
    const administration = new HostedLocalAdministration({
      mode: 'oidc',
      binding: {
        deploymentId: 'deployment_synthetic-1234' as never,
        restoreGeneration: 2,
      },
      authority: null,
      identities: {
        auditLocalControl: vi.fn(async () => undefined),
        createLocalControlAuditEvent: vi.fn(async () => auditEvent),
      } as unknown as HostedIdentityService,
      repository: {
        readAuthConfiguration: async () => ({
          mode: 'oidc',
          configuredAt: 1,
          resetGeneration: 3,
          secretsRotatedGeneration: 3,
          pendingPersonalKeyringId: null,
        }),
      } as HostedIdentityRepositoryPort,
      drainProof: {
        confirmDrained: async (input) => {
          expect(input).toEqual({
            binding: {
              deploymentId: 'deployment_synthetic-1234',
              restoreGeneration: 2,
            },
            purpose: 'auth_mode_reset',
            resetGeneration: 4,
            targetAuthMode: 'personal',
          });
          return { status: 'drained', evidenceRef: 'ar:drain:auth-mode-4' };
        },
      },
      now: () => 1_000,
      runWithBrowserStreamsDrained: async (operation) => {
        sequence.push('streams-drained');
        return operation();
      },
      blockPublicAccess: async () => {
        sequence.push('public-blocked');
        publicAccessActive = false;
      },
      restorePublicAccess: () => {
        publicAccessActive = true;
      },
      performAuthModeReset: async (input) => {
        sequence.push('storage-committed');
        expect(input.auditEvent).toBe(auditEvent);
        return 'committed';
      },
    });

    await expect(administration.resetAuthMode('personal', 4)).resolves.toEqual({
      mode: 'personal',
      resetGeneration: 4,
      restartRequired: true,
    });
    expect(sequence).toEqual(['streams-drained', 'public-blocked', 'storage-committed']);
    expect(publicAccessActive).toBe(false);
  });
});
