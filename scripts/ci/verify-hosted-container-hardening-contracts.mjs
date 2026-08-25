export const RESULT_FORMAT = 'hosted-container-hardening-verifier-result/v2';
export const COMPOSE_PATH = 'docker/docker-compose.yml';
export const PROFILES = Object.freeze(['personal', 'keycloak']);
export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/iu;
export const POSITIVE_DURATION_PATTERN = /^[1-9]\d*(?:ms|s|m|h)(?:\d+(?:ms|s|m|h))*$/u;

// prettier-ignore
export const PROFILE_SERVICES = Object.freeze({ personal: Object.freeze(['agent-teams-personal', 'agent-teams-lifecycle-trust-init', 'caddy-personal']), keycloak: Object.freeze(['agent-teams-keycloak', 'agent-teams-keycloak-secret-init', 'agent-teams-lifecycle-trust-init', 'caddy', 'keycloak', 'keycloak-postgres', 'keycloak-volume-init']) });
// prettier-ignore
export const LONG_RUNNING_SERVICES = new Set(['agent-teams-personal', 'agent-teams-keycloak', 'caddy', 'caddy-personal', 'keycloak', 'keycloak-postgres']);
// prettier-ignore
export const EXPECTED_USERS = Object.freeze({ 'agent-teams-personal': '1000:1000', 'agent-teams-keycloak': '1000:1000', 'agent-teams-keycloak-secret-init': '1000:1000', 'agent-teams-lifecycle-trust-init': '1000:1000', caddy: '1000:1000', 'caddy-personal': '1000:1000', keycloak: '1000:0', 'keycloak-postgres': '70:70', 'keycloak-volume-init': '1000:1000' });
// prettier-ignore
export const EXPECTED_DEPENDENCIES = Object.freeze({ 'agent-teams-personal': Object.freeze({ 'agent-teams-lifecycle-trust-init': 'service_completed_successfully', 'caddy-personal': 'service_healthy' }), 'agent-teams-keycloak': Object.freeze({ 'agent-teams-keycloak-secret-init': 'service_completed_successfully', 'agent-teams-lifecycle-trust-init': 'service_completed_successfully', caddy: 'service_healthy', keycloak: 'service_healthy', 'keycloak-volume-init': 'service_completed_successfully' }), keycloak: Object.freeze({ caddy: 'service_healthy', 'keycloak-postgres': 'service_healthy', 'keycloak-volume-init': 'service_completed_successfully' }), 'keycloak-volume-init': Object.freeze({ caddy: 'service_healthy' }) });
// prettier-ignore
export const APP_HEALTHCHECK = Object.freeze(['CMD', 'node', '-e', "fetch('http://127.0.0.1:3456/api/auth/status').then(r=>{if(!r.ok||r.headers.get('x-agent-teams-lifecycle-owner-readiness')!=='ready')process.exit(1)}).catch(()=>process.exit(1))"]);
// prettier-ignore
export const CADDY_HEALTHCHECK = Object.freeze(['CMD-SHELL', 'test -s /data/caddy/pki/authorities/local/root.crt && wget -q --spider http://127.0.0.1:2019/config/']);
export const POSTGRES_HEALTHCHECK = Object.freeze([
  'CMD-SHELL',
  'pg_isready -U keycloak -d keycloak',
]);
// prettier-ignore
export const EXPECTED_TMPFS = Object.freeze({ 'agent-teams-personal': Object.freeze(['/run/agent-teams:mode=0700,uid=1000,gid=1000', '/tmp:mode=1777']), 'agent-teams-keycloak': Object.freeze(['/run/agent-teams:mode=0700,uid=1000,gid=1000', '/tmp:mode=1777']), caddy: Object.freeze(['/tmp:mode=1777']), 'caddy-personal': Object.freeze(['/tmp:mode=1777']), keycloak: Object.freeze(['/opt/keycloak/data/import:mode=0700,uid=1000,gid=0', '/opt/keycloak/data/tmp:mode=0700,uid=1000,gid=0', '/run/keycloak:mode=0700,uid=1000,gid=0', '/tmp:mode=1777']), 'keycloak-postgres': Object.freeze(['/tmp:mode=1777', '/var/run/postgresql:mode=0775,uid=70,gid=70']), 'keycloak-volume-init': Object.freeze([]), 'agent-teams-keycloak-secret-init': Object.freeze([]), 'agent-teams-lifecycle-trust-init': Object.freeze([]) });
// prettier-ignore
export const DEFAULT_RENDER_ENVIRONMENT = Object.freeze({ AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP: '{"format":"agent-teams.team-lifecycle-read-bootstrap/v1"}', CLAUDE_DIR: '/tmp/agent-teams-hosted-config-claude', HOSTED_LIFECYCLE_ORCHESTRATOR_RUN_DIR: '/tmp/agent-teams-hosted-config-orchestrator', HOSTED_SECRETS_DIR: '/tmp/agent-teams-hosted-config-secrets', NODE_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`, KEYCLOAK_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`, POSTGRES_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`, CADDY_IMAGE_DIGEST: `sha256:${'d'.repeat(64)}` });

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function compareText(left, right) {
  return String(left).localeCompare(String(right));
}

export function sameValues(actual, expected) {
  if (!Array.isArray(actual)) return expected.length === 0;
  return (
    JSON.stringify([...actual].sort(compareText)) ===
    JSON.stringify([...expected].sort(compareText))
  );
}

export function sameSequence(actual, expected) {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

export function isPositive(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0;
}

export function isPositiveDuration(value) {
  return typeof value === 'string' && POSITIVE_DURATION_PATTERN.test(value);
}

export function resultFor(checkedServices, checkedProfiles, violations) {
  const uniqueViolations = [...new Set(violations)].sort(compareText);
  return {
    format: RESULT_FORMAT,
    status: uniqueViolations.length === 0 ? 'passed' : 'failed',
    summary: {
      checkedProfiles,
      checkedServices,
      violations: uniqueViolations.length,
    },
    violations: uniqueViolations,
  };
}
