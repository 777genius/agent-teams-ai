import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocateCoreLivePorts, classifyComposeFailure } from './run.mjs';

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

test('Docker host-port bind failure outranks unrelated admission text', () => {
  const dockerStderr = 'building image\nowner.admission binding\n'
    + 'Error response from daemon: failed to bind host port '
    + '0.0.0.0:42546/tcp: address already in use';
  assert.equal(classifyComposeFailure({
    daemonOutputs: [dockerStderr],
    composeOutputs: [dockerStderr],
  }), 'port-unavailable');
});

test('port allocation excludes the host ephemeral range and occupied candidates', async () => {
  const checked = [];
  let next = 0;
  const ports = await allocateCoreLivePorts({
    ephemeralRange: [20_000, 29_999],
    isPortAvailable: async port => {
      checked.push(port);
      return checked.length > 1;
    },
    randomIndex: limit => next++ % limit,
  });
  assert.equal(ports.length, 2);
  assert.equal(checked.length, 3);
  assert.ok(checked.every(port => port >= 61_000 && port <= 65_000));
  assert.notEqual(ports[0], ports[1]);
});
