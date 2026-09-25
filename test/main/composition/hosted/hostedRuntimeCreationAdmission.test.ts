import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeHostedPairingMaterial } from '@features/hosted-access/main';
import { createHostedRuntimeCreationAdmission } from '@main/composition/hosted/hostedRuntimeCreationAdmission';
import { afterEach, describe, expect, it, vi } from 'vitest';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('hosted trusted_process runtime creation admission', () => {
  it('refuses runtime-creating actions under OIDC without consulting pairing material', async () => {
    const reportRefusal = vi.fn();
    const pairingMaterial = vi.fn(() => Promise.resolve('absent' as const));
    const admission = createHostedRuntimeCreationAdmission({
      authMode: 'oidc',
      pairingMaterial,
      reportRefusal,
    });

    expect(reportRefusal).toHaveBeenCalledTimes(1);
    await expect(admission.admit('launch')).resolves.toBe(false);
    await expect(admission.admit('recover')).resolves.toBe(false);
    await expect(admission.admit('stop')).resolves.toBe(true);
    await expect(admission.admit('cancel')).resolves.toBe(true);
    expect(pairingMaterial).not.toHaveBeenCalled();
    expect(reportRefusal).toHaveBeenLastCalledWith(
      expect.stringContaining(
        'code=host_local_runtime_requires_personal_mode detail=host-local agent runtime is limited to personal single-operator mode'
      )
    );
  });

  it('admits personal launch only while no plaintext pairing file is materialized', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hosted-runtime-creation-admission-'));
    directories.push(directory);
    const pairingPath = join(directory, 'pairing.json');
    const reportRefusal = vi.fn();
    const admission = createHostedRuntimeCreationAdmission({
      authMode: 'personal',
      pairingMaterial: () => probeHostedPairingMaterial(pairingPath, { lstat }),
      reportRefusal,
    });

    await expect(admission.admit('launch')).resolves.toBe(true);
    expect(reportRefusal).not.toHaveBeenCalled();

    await writeFile(pairingPath, '{}', { mode: 0o600 });
    await expect(admission.admit('launch')).resolves.toBe(false);
    await expect(admission.admit('recover')).resolves.toBe(false);
    await expect(admission.admit('stop')).resolves.toBe(true);
    expect(reportRefusal).toHaveBeenLastCalledWith(
      expect.stringContaining('code=pairing_material_materialized')
    );

    await rm(pairingPath);
    await expect(admission.admit('launch')).resolves.toBe(true);
  });

  it('fails closed when pairing material cannot be observed', async () => {
    const reportRefusal = vi.fn();
    const unobservable = createHostedRuntimeCreationAdmission({
      authMode: 'personal',
      pairingMaterial: () =>
        probeHostedPairingMaterial('/pairing.json', {
          lstat: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
        }),
      reportRefusal,
    });
    const throwing = createHostedRuntimeCreationAdmission({
      authMode: 'personal',
      pairingMaterial: () => Promise.reject(new Error('probe_failed')),
      reportRefusal,
    });

    await expect(unobservable.admit('launch')).resolves.toBe(false);
    await expect(throwing.admit('launch')).resolves.toBe(false);
    expect(reportRefusal).toHaveBeenCalledTimes(2);
    expect(reportRefusal).toHaveBeenLastCalledWith(
      expect.stringContaining('code=pairing_material_unverifiable')
    );
  });
});
