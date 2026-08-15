import { HostedApprovalRuntimeProjectionSource } from '@main/composition/hosted/HostedApprovalRuntimeProjectionSource';
import { describe, expect, it } from 'vitest';

const teamId = `team_${'1'.repeat(32)}`;
const owner = {
  teamId,
  ownerAuthority: 'owner-authority_wire-test',
  ownerGeneration: 7,
  ownerSessionId: 'owner-session_wire-test',
  socketPath: '/run/agent-teams/owner.sock',
  socketIdentity: { device: '10', inode: '20', uid: 1000, gid: 1000, mode: 384 },
  processIdentity: { pid: 2345, startIdentity: `start_${'c'.repeat(64)}` },
};
const authority = {
  deploymentId: 'deployment_wire-test',
  bootId: 'boot_wire-test',
  workspaceId: 'workspace_wire-test',
  teamId,
  restoreGeneration: 2,
  mountBinding: { mountGeneration: 3, declaredRootHash: 'e'.repeat(64) },
};

describe('HostedApprovalRuntimeProjectionSource', () => {
  it('pins only local authoritative inputs and detects artifact, owner, and process drift', async () => {
    let artifact: `sha256:${string}` = `sha256:${'a'.repeat(64)}`;
    let currentOwner = structuredClone(owner);
    let client = { pid: 4242, startIdentity: `start_${'d'.repeat(64)}` };
    const source = new HostedApprovalRuntimeProjectionSource({
      readStableAuthority: async () => authority,
      readExpectedOwner: async () => currentOwner,
      readInstalledArtifactDigest: async () => artifact,
      readClientProcessIdentity: async () => client,
    });
    const pin = await source.pin('team-a', { state: 'provisioning', ownerGeneration: 7 });
    expect(pin).not.toBeNull();
    await expect(pin!.assertCurrent()).resolves.toBe(true);
    artifact = `sha256:${'b'.repeat(64)}`;
    await expect(pin!.assertCurrent()).resolves.toBe(false);
    artifact = `sha256:${'a'.repeat(64)}`;
    currentOwner = { ...currentOwner, ownerSessionId: 'owner-session_replaced' };
    await expect(pin!.assertCurrent()).resolves.toBe(false);
    currentOwner = structuredClone(owner);
    client = { ...client, startIdentity: `start_${'f'.repeat(64)}` };
    await expect(pin!.assertCurrent()).resolves.toBe(false);
  });

  it('rejects lifecycle/owner substitution instead of inferring authority', async () => {
    const source = new HostedApprovalRuntimeProjectionSource({
      readStableAuthority: async () => authority,
      readExpectedOwner: async () => owner,
      readInstalledArtifactDigest: async () => `sha256:${'a'.repeat(64)}`,
      readClientProcessIdentity: async () => ({
        pid: 4242,
        startIdentity: `start_${'d'.repeat(64)}`,
      }),
    });
    await expect(
      source.pin('team-a', { state: 'provisioning', ownerGeneration: 8 })
    ).resolves.toBeNull();
    await expect(
      source.pin(' team-a ', { state: 'provisioning', ownerGeneration: 7 })
    ).resolves.toBeNull();
  });
});
