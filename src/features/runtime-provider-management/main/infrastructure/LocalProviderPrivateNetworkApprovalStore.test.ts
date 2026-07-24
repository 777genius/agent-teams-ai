import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonLocalProviderPrivateNetworkApprovalStore } from './LocalProviderPrivateNetworkApprovalStore';

describe('JsonLocalProviderPrivateNetworkApprovalStore', () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-provider-approvals-'));
    storePath = path.join(tempDir, 'private-network-approvals.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('persists approval for only the exact config, provider, and URL tuple', async () => {
    const store = new JsonLocalProviderPrivateNetworkApprovalStore(storePath);
    const approval = {
      configPath: path.join(tempDir, 'project', 'opencode.json'),
      providerId: 'home-server',
      baseUrl: 'http://192.168.1.20:8080/v1',
    };

    expect(await store.isApproved(approval)).toBe(false);
    await store.approve(approval);

    const reloaded = new JsonLocalProviderPrivateNetworkApprovalStore(storePath);
    expect(await reloaded.isApproved(approval)).toBe(true);
    expect(
      await reloaded.isApproved({
        ...approval,
        configPath: path.join(tempDir, 'other-project', 'opencode.json'),
      })
    ).toBe(false);
    expect(
      await reloaded.isApproved({
        ...approval,
        baseUrl: 'http://192.168.1.21:8080/v1',
      })
    ).toBe(false);
  });

  it('fails closed for malformed approval state', async () => {
    await fs.writeFile(storePath, '{"schemaVersion":1,"approvals":"all"}', 'utf8');
    const store = new JsonLocalProviderPrivateNetworkApprovalStore(storePath);

    expect(
      await store.isApproved({
        configPath: '/tmp/project/opencode.json',
        providerId: 'home-server',
        baseUrl: 'http://192.168.1.20:8080/v1',
      })
    ).toBe(false);
  });
});
