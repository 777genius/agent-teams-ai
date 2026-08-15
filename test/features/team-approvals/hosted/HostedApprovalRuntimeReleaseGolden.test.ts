import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const roots: string[] = [];
const script = resolve('scripts/verify-hosted-approval-runtime-admission-authority.mjs');
const goldenPath = resolve(
  'test/fixtures/hosted-approval-runtime-admission-v1.release-golden.json'
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function admissionPath(tamper = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'approval-release-golden-'));
  roots.push(root);
  const golden = JSON.parse(await readFile(goldenPath, 'utf8')) as {
    canonicalJson: string;
  };
  const snapshot = JSON.parse(golden.canonicalJson) as {
    authorities: readonly Record<string, unknown>[];
  };
  const authority = { ...snapshot.authorities[0] };
  if (tamper) authority.sessionId = 'session_tampered';
  const path = join(root, 'hosted-approval-runtime-admission.v1.json');
  await writeFile(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      admissionGeneration: 'approval-admission-generation_1_owner_1',
      outerAuthority: {},
      routes: [{ routeId: 'route-golden', authority }],
      actorMembers: {},
    })}\n`,
    { mode: 0o600 }
  );
  return path;
}

describe('hosted approval runtime release golden verifier', () => {
  it('is exercised against the orchestrator release/tag/attestation pin and exact authority', async () => {
    const { stdout } = await run(process.execPath, [script, await admissionPath()]);
    expect(JSON.parse(stdout)).toMatchObject({
      verified: true,
      sourceRepository: '777genius/agent_teams_orchestrator',
      releaseRepository: '777genius/agent_teams_orchestrator_binaries',
      releaseTag: 'runtime-v0.0.73',
      sourceCommit: '1f9a7ffc00715e2434eb7549ac2c53880d9f6f83',
      manifestAttestationSha256: '0b1036e1f110eefeed5b12c9637a7efa3bf35d6b09a8eb20519909e86bed2bcb',
    });
  });

  it('rejects authority bytes that drift from the immutable release golden', async () => {
    await expect(run(process.execPath, [script, await admissionPath(true)])).rejects.toMatchObject({
      stderr: expect.stringContaining('cross-repository-authority-mismatch'),
    });
  });
});
