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
    'caddy-personal': { networks: { hosted: {} }, volumes: [{ type: 'volume', source: 'caddy', target: '/data' }] },
    'agent-teams-lifecycle-trust-init': {},
  },
  volumes: { trust: {}, data: {}, caddy: {}, unrelated: {} },
  networks: { hosted: {}, unrelated: {} },
};

test('uses production Product/Caddy services and replaces only sandbox authority bindings', () => {
  const result = sandboxProductionCompose(production, sandbox, name);
  assert.deepEqual(Object.keys(result.services), ['agent-teams-personal', 'caddy-personal']);
  assert.equal(result.services['agent-teams-personal'].container_name, `${name}-product`);
  assert.deepEqual(result.services['agent-teams-personal'].depends_on, {
    'caddy-personal': { condition: 'service_healthy' },
  });
  assert.equal(result.services['agent-teams-personal'].volumes.find(v => v.target === '/run/agent-teams-lifecycle-trust').source, sandbox.trustDirectory);
  assert.equal(result.services['agent-teams-personal'].volumes.find(v => v.target === '/data/.agent-teams').source, 'data');
  assert.deepEqual(result.services['agent-teams-personal'].volumes.find(v => v.target === sandbox.workspaceRoot), {
    type: 'bind', source: sandbox.workspaceRoot, target: sandbox.workspaceRoot,
    read_only: false, bind: { create_host_path: false },
  });
  assert.equal(result.services['agent-teams-personal'].environment.HOSTED_OPENCODE_RUNTIME_MODE, 'official-v1.18.32');
  assert.deepEqual(Object.keys(result.volumes).sort(), ['caddy', 'data']);
  assert.deepEqual(Object.keys(result.networks), ['hosted']);
  assert.equal(result.volumes.data.name, `${name}_data`);
  assert.equal(result.networks.hosted.name, `${name}_hosted`);
  assert.equal(production.services['agent-teams-personal'].container_name, 'agent-teams-hosted-controller');
});

test('rejects drift in production owner admission contract', () => {
  const changed = structuredClone(production);
  changed.services['agent-teams-personal'].environment.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET = '/other';
  assert.throws(() => sandboxProductionCompose(changed, sandbox, name), /contract-changed/);
});
