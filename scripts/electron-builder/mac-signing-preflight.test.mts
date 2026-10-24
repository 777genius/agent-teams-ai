import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from './dist.mjs';

const unsigned = ['--config.mac.identity=null', '--config.mac.forceCodeSigning=false', '--config.mac.notarize=false'];
const sandbox = mkdtempSync(join(tmpdir(), 'TEST-mac-signing-preflight-'));
const key = join(sandbox, 'dummy.p8');
writeFileSync(key, 'sandbox fixture, not a credential');
const valid = {
  APPLE_TEAM_ID: '86399583GS', APPLE_API_KEY: key,
  APPLE_API_KEY_ID: 'TESTKEY123', APPLE_API_ISSUER: '11111111-2222-3333-4444-555555555555',
};
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));

async function packageProbe(args: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = 'darwin') {
  const calls: string[] = [];
  const result = main(args, {
    platform, arch: 'arm64', env,
    guard: async () => { calls.push('guard'); },
    packageInvocation: async () => { calls.push('builder'); },
  });
  return { result, calls };
}

test('default mac packaging rejects missing API before guard or builder', async () => {
  const probe = await packageProbe(['--mac'], { APPLE_TEAM_ID: '86399583GS' });
  await assert.rejects(probe.result, /Missing APPLE_API_KEY/);
  assert.deepEqual(probe.calls, []);
});

test('implicit host-mac and combined-platform packaging fail closed', async () => {
  for (const args of [[], ['--linux', '--mac']]) {
    const probe = await packageProbe(args, { APPLE_TEAM_ID: '86399583GS' });
    await assert.rejects(probe.result, /Missing APPLE_API_KEY/);
    assert.deepEqual(probe.calls, []);
  }
});

test('intentional three-flag unsigned CI package needs no Apple credentials', async () => {
  for (const args of [unsigned, ['-c.mac.identity', 'null', '-c.mac.forceCodeSigning', 'false', '-c.mac.notarize', 'false']]) {
    const probe = await packageProbe(['--mac', ...args], {});
    await probe.result;
    assert.deepEqual(probe.calls, ['guard', 'builder']);
  }
});

test('partial signing overrides cannot disable notarization', async () => {
  const probe = await packageProbe(['--mac', '--config.mac.notarize=false'], valid);
  await assert.rejects(probe.result, /requires identity=null/);
  assert.deepEqual(probe.calls, []);
});

test('signed mac package requires the new team and usable API metadata/path', async () => {
  for (const [env, error] of [
    [{ ...valid, APPLE_TEAM_ID: 'OLDTEAM123' }, /APPLE_TEAM_ID/],
    [{ ...valid, APPLE_API_KEY: join(sandbox, 'missing.p8') }, /existing readable/],
    [{ ...valid, APPLE_API_KEY: 'relative.p8' }, /absolute/],
    [{ ...valid, APPLE_API_KEY_ID: 'bad' }, /Invalid APPLE_API_KEY_ID/],
    [{ ...valid, APPLE_API_ISSUER: 'bad' }, /Invalid APPLE_API_ISSUER/],
  ] as const) {
    const probe = await packageProbe(['--mac'], env);
    await assert.rejects(probe.result, error);
    assert.deepEqual(probe.calls, []);
  }
  const probe = await packageProbe(['--mac'], valid);
  await probe.result;
  assert.deepEqual(probe.calls, ['guard', 'builder']);
});

test('non-Mac builds retain their credential-independent path', async () => {
  for (const args of [['--win'], ['--linux']]) {
    const probe = await packageProbe(args, {});
    await probe.result;
    assert.deepEqual(probe.calls, ['guard', 'builder']);
  }
});
