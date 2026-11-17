/* eslint-disable sonarjs/no-clear-text-protocols -- plain-HTTP LAN URLs are the approval subject */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { captureReadinessSource } from '../../../agent-backend/main/infrastructure/CapturedLocalModelReadiness';

import { JsonLocalProviderPrivateNetworkApprovalStore } from './LocalProviderPrivateNetworkApprovalStore';

describe('JsonLocalProviderPrivateNetworkApprovalStore', () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-provider-approvals-')));
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
    const before = await fs.readFile(storePath);
    const read = (file: string, maximum: number) => captureReadinessSource(file, path.dirname(file), maximum, () => {});
    const captured = await reloaded.capture()([approval, {
      ...approval, configPath: path.join(tempDir, 'other-project', 'opencode.json'),
    }], read);
    expect(captured.approved).toEqual([approval]);
    expect(captured.source).toMatchObject({ root: tempDir, path: storePath, present: true });
    const filesystemRoot = await captureReadinessSource(storePath, path.parse(storePath).root, 131072, () => {});
    expect(filesystemRoot.raw).toBe(before.toString('utf8'));
    expect(await fs.readFile(storePath)).toEqual(before);
    let current = true;
    const late = captureReadinessSource(storePath, tempDir, 131072, () => {
      if (!current) throw new Error('original preparation expired');
    });
    current = false;
    await expect(late).rejects.toThrow('original preparation expired');
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
    const captured = await store.capture()([{
      configPath: path.join(tempDir, 'project', 'opencode.json'),
      providerId: 'home-server', baseUrl: 'http://192.168.1.20:8080/v1',
    }], (file, maximum) => captureReadinessSource(file, path.dirname(file), maximum, () => {}));
    expect(captured.approved).toEqual([]);
    const previous = captured.source.digest;
    await fs.writeFile(storePath, '{"schemaVersion":1,"approvals":[]}');
    const changed = await store.capture()([], (file, maximum) =>
      captureReadinessSource(file, path.dirname(file), maximum, () => {}));
    expect(changed.source.digest).not.toBe(previous);
    await fs.writeFile(storePath, Buffer.alloc(131073));
    await expect(store.capture()([], (file, maximum) =>
      captureReadinessSource(file, path.dirname(file), maximum, () => {}))).rejects.toThrow();

    expect(
      await store.isApproved({
        configPath: path.join(tempDir, 'project', 'opencode.json'),
        providerId: 'home-server',
        baseUrl: 'http://192.168.1.20:8080/v1',
      })
    ).toBe(false);
  });
});

/* eslint-enable sonarjs/no-clear-text-protocols -- re-enable after the LAN approval fixtures */
