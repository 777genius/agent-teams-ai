import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PRODUCT = 'agent-teams-personal';
const CADDY = 'caddy-personal';
const REQUIRED_PRODUCT_VOLUMES = new Set([
  '/data/.claude', '/data/.claude/teams', '/run/agent-teams-orchestrator',
  '/run/agent-teams-lifecycle-trust',
]);

export function composeProjectName() {
  return `at-core-live-${randomBytes(12).toString('hex')}`;
}

function bind(source, target, readOnly) {
  return { type: 'bind', source, target, read_only: readOnly, bind: { create_host_path: false } };
}

/** Keep the rendered production services, replacing only test-owned authority and workspace inputs. */
export function sandboxProductionCompose(rendered, sandbox, projectName) {
  if (!/^at-core-live-[0-9a-f]{24}$/.test(projectName) ||
      !rendered?.services?.[PRODUCT] || !rendered.services[CADDY]) {
    throw new Error('core-live-production-compose-invalid');
  }
  const product = structuredClone(rendered.services[PRODUCT]);
  const caddy = structuredClone(rendered.services[CADDY]);
  const targets = new Set(product.volumes?.map(volume => volume.target));
  if ([...REQUIRED_PRODUCT_VOLUMES].some(target => !targets.has(target)) ||
      product.environment?.AUTH_MODE !== 'personal' ||
      product.environment?.NODE_ENV !== 'production' ||
      product.environment?.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET !==
        '/run/agent-teams-orchestrator/orchestrator-lifecycle.sock' ||
      product.environment?.HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE !==
        '/run/agent-teams-orchestrator/lifecycle-owner-admission.json') {
    throw new Error('core-live-production-compose-contract-changed');
  }
  product.container_name = `${projectName}-product`;
  product.depends_on = { [CADDY]: { condition: 'service_healthy' } };
  const replacements = {
    '/data/.claude': bind(sandbox.claudeRoot, '/data/.claude', true),
    '/data/.claude/teams': bind(join(sandbox.claudeRoot, 'teams'), '/data/.claude/teams', false),
    '/run/agent-teams-orchestrator': bind(sandbox.runDirectory, '/run/agent-teams-orchestrator', true),
    '/run/agent-teams-lifecycle-trust': bind(sandbox.trustDirectory, '/run/agent-teams-lifecycle-trust', true),
  };
  product.volumes = product.volumes.map(volume => replacements[volume.target] ?? volume);
  if (!/^\/tmp\/hosted-core-issuer-[A-Za-z0-9_-]+\/sandbox-project$/.test(sandbox.workspaceRoot)) {
    throw new Error('core-live-sandbox-workspace-path-invalid');
  }
  product.volumes.push(bind(sandbox.workspaceRoot, sandbox.workspaceRoot, false));
  product.environment = {
    ...product.environment,
    ...sandbox.productEnvironment,
    HOSTED_OPENCODE_RUNTIME_MODE: 'official-v1.18.32',
  };
  const requiredEnvironment = Object.keys(sandbox.productEnvironment);
  if (requiredEnvironment.some(key => typeof product.environment[key] !== 'string' || !product.environment[key])) {
    throw new Error('core-live-issuer-environment-invalid');
  }
  const usedVolumes = new Set([...product.volumes, ...(caddy.volumes ?? [])]
    .filter(volume => volume.type === 'volume').map(volume => volume.source));
  const usedNetworks = new Set([
    ...Object.keys(product.networks ?? {}), ...Object.keys(caddy.networks ?? {}),
  ]);
  const volumes = Object.fromEntries(Object.entries(rendered.volumes ?? {})
    .filter(([name]) => usedVolumes.has(name))
    .map(([name, value]) => [name, { ...value, name: `${projectName}_${name}` }]));
  const networks = Object.fromEntries(Object.entries(rendered.networks ?? {})
    .filter(([name]) => usedNetworks.has(name))
    .map(([name, value]) => [name, { ...value, name: `${projectName}_${name}` }]));
  if (Object.keys(networks).length === 0 || Object.keys(volumes).length === 0) {
    throw new Error('core-live-production-compose-topology-invalid');
  }
  return {
    name: projectName,
    services: { [PRODUCT]: product, [CADDY]: caddy },
    volumes, networks,
  };
}

export async function writeSandboxCompose(path, rendered, sandbox, projectName) {
  const compose = sandboxProductionCompose(rendered, sandbox, projectName);
  await writeFile(path, `${JSON.stringify(compose, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return compose;
}

export const CORE_LIVE_PRODUCT_SERVICE = PRODUCT;
