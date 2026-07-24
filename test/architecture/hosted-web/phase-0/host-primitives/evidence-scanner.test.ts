// @vitest-environment node

import { cp, mkdtemp, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  scanEvidence,
  verifyW4Handoff,
} from '../../../../../scripts/hosted-web/phase-0/host-primitives/scan-evidence.mjs';

const evidenceDirectory = 'docs/research/hosted-web/phase-0/host-primitives';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('Phase 0 W4 evidence scanner', () => {
  it('accepts the exact V6 handoff provenance and r3 narrowing', async () => {
    await expect(verifyW4Handoff()).resolves.toEqual({ failures: [], ok: true });
  });

  it('accepts the complete characterized evidence bundle', async () => {
    await expect(scanEvidence(evidenceDirectory)).resolves.toEqual({ failures: [], ok: true });
  });

  it('rejects a deliberately incomplete bundle', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'atg-w4-scanner-negative-'));
    temporaryDirectories.push(fixture);
    await cp(evidenceDirectory, fixture, { recursive: true });
    await unlink(path.join(fixture, 'process-anchor-spike.md'));
    const result = await scanEvidence(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('missing process-anchor-spike.md');
  });

  it.each([
    'instance-lock.protocol.json',
    'process-anchor.protocol.json',
    'workspace-guard.protocol.json',
    'native-protocol.schema.json',
    'probe-results.schema.json',
    'native-artifact-contract.json',
  ])('rejects a bundle missing required protocol/schema artifact %s', async (requiredFile) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'atg-w4-scanner-json-negative-'));
    temporaryDirectories.push(fixture);
    await cp(evidenceDirectory, fixture, { recursive: true });
    await unlink(path.join(fixture, requiredFile));
    const result = await scanEvidence(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain(`missing ${requiredFile}`);
  });
});
