import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyComposeFailure } from './run.mjs';

test('later Product startup diagnostic survives verbose Compose build output', () => {
  const composeBuild = 'building image\n'.repeat(50_000);
  const productLog = 'hosted-state-startup-refused:state_metadata_invalid\n';
  assert.ok(composeBuild.length > 512 * 1024);
  assert.equal(classifyComposeFailure({ composeOutputs: [composeBuild],
    containerOutputs: [productLog] }),
    'hosted-state-metadata-invalid');
});

test('Caddy container permission error outranks benign OpenCode build evidence', () => {
  const composeBuild = `${'build output\n'.repeat(50_000)}OpenCode SHA256 513f500a\n`;
  const caddyLog = 'Error: loading initial config: loading new config: '
    + 'provision tls: creating storage: mkdir /data/caddy/pki: permission denied\n';
  assert.ok(composeBuild.length > 512 * 1024);
  assert.equal(classifyComposeFailure({ composeOutputs: [composeBuild],
    containerOutputs: [caddyLog] }), 'caddy-data-permission-denied');
  assert.equal(classifyComposeFailure({ composeOutputs: [composeBuild] }), 'unclassified');
});

test('actual OpenCode runtime error is classified without matching a build digest', () => {
  assert.equal(classifyComposeFailure({ containerOutputs: [
    'Error: hosted_opencode_offline_archive_unavailable\n',
  ] }), 'opencode-runtime-unavailable');
});
