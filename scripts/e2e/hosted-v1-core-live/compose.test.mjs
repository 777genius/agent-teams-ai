import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sandboxProductionCompose } from './compose.mjs';

const name = 'at-core-live-0123456789abcdef01234567';
const sandbox = {
  claudeRoot: '/tmp/core/claude', runDirectory: '/tmp/core/run',
  trustDirectory: '/tmp/core/trust', workspaceRoot: '/tmp/hosted-core-issuer-abc123/sandbox-project',
  productEnvironment: {
    AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP: '{}',
    AUTH_DEPLOYMENT_ID: 'deployment_test',
    HOSTED_WORKSPACE_IDS: 'workspace_test',
  },
};
const production = {
  name: 'agent-teams-hosted',
  services: {
    'agent-teams-personal': {
      container_name: 'agent-teams-hosted-controller',
      environment: {
        AUTH_MODE: 'personal', NODE_ENV: 'production',
        HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET: '/run/agent-teams-orchestrator/orchestrator-lifecycle.sock',
        HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE: '/run/agent-teams-orchestrator/lifecycle-owner-admission.json',
      },
      depends_on: { 'agent-teams-lifecycle-trust-init': { condition: 'service_completed_successfully' } },
      networks: { hosted: {} },
      volumes: [
        { type: 'bind', target: '/data/.claude', source: '/old' },
        { type: 'bind', target: '/data/.claude/teams', source: '/old/teams' },
        { type: 'bind', target: '/run/agent-teams-orchestrator', source: '/old/run' },
        { type: 'volume', target: '/run/agent-teams-lifecycle-trust', source: 'trust' },
        { type: 'volume', target: '/data/.agent-teams', source: 'data' },
      ],
    },
    'caddy-personal': {
      depends_on: {
        'caddy-personal-volume-owner-init': { condition: 'service_completed_successfully' },
      },
      networks: { hosted: {}, 'hosted-ingress': {} },
      volumes: [
        { type: 'volume', source: 'caddy-data', target: '/data' },
        { type: 'volume', source: 'caddy-config', target: '/config' },
      ],
    },
    'caddy-personal-volume-owner-init': {
      network_mode: 'none', restart: 'no',
      volumes: [
        { type: 'bind', source: '/repo/docker/caddy/init-volume-ownership.sh',
          target: '/usr/local/bin/init-caddy-volume-ownership', read_only: true },
        { type: 'volume', source: 'caddy-data', target: '/data' },
        { type: 'volume', source: 'caddy-config', target: '/config' },
      ],
    },
    'agent-teams-lifecycle-trust-init': {},
  },
  volumes: { trust: {}, data: {}, 'caddy-data': {}, 'caddy-config': {}, unrelated: {} },
  networks: {
    hosted: { internal: true, name: 'agent-teams-hosted_hosted' },
    'hosted-ingress': { driver: 'bridge', ipam: {}, name: 'agent-teams-hosted_hosted-ingress' },
    unrelated: {},
  },
};

test('keeps production personal Caddy init and test-owned volumes', () => {
  const result = sandboxProductionCompose(production, sandbox, name);
  assert.deepEqual(Object.keys(result.services), [
    'agent-teams-personal', 'caddy-personal', 'caddy-personal-volume-owner-init',
  ]);
  assert.equal(result.services['agent-teams-personal'].container_name, `${name}-product`);
  assert.deepEqual(result.services['agent-teams-personal'].depends_on, {
    'caddy-personal': { condition: 'service_healthy' },
  });
  assert.deepEqual(result.services['caddy-personal'].depends_on, {
    'caddy-personal-volume-owner-init': { condition: 'service_completed_successfully' },
  });
  assert.deepEqual(result.services['caddy-personal-volume-owner-init'],
    production.services['caddy-personal-volume-owner-init']);
  assert.equal(result.services['agent-teams-personal'].volumes.find(v => v.target === '/run/agent-teams-lifecycle-trust').source, sandbox.trustDirectory);
  assert.equal(result.services['agent-teams-personal'].volumes.find(v => v.target === '/data/.agent-teams').source, 'data');
  assert.deepEqual(result.services['agent-teams-personal'].volumes.find(v => v.target === sandbox.workspaceRoot), {
    type: 'bind', source: sandbox.workspaceRoot, target: sandbox.workspaceRoot,
    read_only: false, bind: { create_host_path: false },
  });
  assert.equal(result.services['agent-teams-personal'].environment.HOSTED_OPENCODE_RUNTIME_MODE, 'official-v1.18.32');
  assert.deepEqual(Object.keys(result.volumes).sort(), ['caddy-config', 'caddy-data', 'data']);
  assert.deepEqual(Object.keys(result.networks), ['hosted', 'hosted-ingress']);
  assert.equal(result.volumes.data.name, `${name}_data`);
  assert.equal(result.volumes['caddy-data'].name, `${name}_caddy-data`);
  assert.equal(result.volumes['caddy-config'].name, `${name}_caddy-config`);
  assert.equal(result.networks.hosted.name, `${name}_hosted`);
  assert.deepEqual(result.networks['hosted-ingress'], {
    driver: 'bridge', ipam: {}, internal: false, name: `${name}_hosted-ingress`,
  });
  assert.deepEqual(Object.keys(result.services['agent-teams-personal'].networks), ['hosted']);
  assert.deepEqual(Object.keys(result.services['caddy-personal'].networks), ['hosted', 'hosted-ingress']);
  assert.equal(production.services['agent-teams-personal'].container_name, 'agent-teams-hosted-controller');
});

test('rejects Caddy init dependency or volume drift', () => {
  const missingInit = structuredClone(production);
  delete missingInit.services['caddy-personal-volume-owner-init'];
  assert.throws(() => sandboxProductionCompose(missingInit, sandbox, name), /compose-invalid/);
  const detachedVolume = structuredClone(production);
  detachedVolume.services['caddy-personal-volume-owner-init'].volumes
    .find(volume => volume.target === '/data').source = 'unrelated';
  assert.throws(() => sandboxProductionCompose(detachedVolume, sandbox, name),
    /caddy-init-contract-changed/);
  const externalVolume = structuredClone(production);
  externalVolume.volumes['caddy-data'].external = true;
  assert.throws(() => sandboxProductionCompose(externalVolume, sandbox, name),
    /topology-invalid/);
  const missingVolume = structuredClone(production);
  delete missingVolume.volumes['caddy-config'];
  assert.throws(() => sandboxProductionCompose(missingVolume, sandbox, name),
    /topology-invalid/);
  const externalIngress = structuredClone(production);
  externalIngress.networks['hosted-ingress'].external = true;
  assert.throws(() => sandboxProductionCompose(externalIngress, sandbox, name),
    /topology-invalid/);
});

test('keeps the public ingress scoped to Caddy and the test project', () => {
  const productOnIngress = structuredClone(production);
  productOnIngress.services['agent-teams-personal'].networks['hosted-ingress'] = {};
  assert.throws(() => sandboxProductionCompose(productOnIngress, sandbox, name),
    /topology-invalid/);
  const globalIngress = structuredClone(production);
  globalIngress.networks['hosted-ingress'].name = 'shared-ingress';
  assert.throws(() => sandboxProductionCompose(globalIngress, sandbox, name),
    /topology-invalid/);
  const fixedIngressSubnet = structuredClone(production);
  fixedIngressSubnet.networks['hosted-ingress'].ipam.config = [{ subnet: '172.30.253.0/28' }];
  assert.throws(() => sandboxProductionCompose(fixedIngressSubnet, sandbox, name),
    /topology-invalid/);
});

test('rejects drift in production owner admission contract', () => {
  const changed = structuredClone(production);
  changed.services['agent-teams-personal'].environment.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET = '/other';
  assert.throws(() => sandboxProductionCompose(changed, sandbox, name), /contract-changed/);
});
