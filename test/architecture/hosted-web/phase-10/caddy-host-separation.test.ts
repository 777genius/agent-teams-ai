import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const keycloak = readFileSync('docker/caddy/Caddyfile', 'utf8');
const personal = readFileSync('docker/caddy/Caddyfile.personal', 'utf8');
const e2e = readFileSync('docker/e2e/Caddyfile', 'utf8');

function siteLabels(source: string): string[] {
  return source
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !/^\s/u.test(line) && line.endsWith(' {'));
}

function siteBlock(source: string, label: string): string {
  const start = source.indexOf(label);
  if (start < 0) throw new Error(`missing Caddy site label: ${label}`);
  let depth = 0;
  const selected: string[] = [];
  for (const line of source.slice(start).split(/\r?\n/u)) {
    selected.push(line);
    const syntax = line.replace(/\{\$[^}]+\}/gu, '');
    depth += (syntax.match(/\{/gu) ?? []).length;
    depth -= (syntax.match(/\}/gu) ?? []).length;
    if (depth === 0) return selected.join('\n');
  }
  throw new Error(`unterminated Caddy site block: ${label}`);
}

describe('hosted Caddy SNI and listener separation', () => {
  it.each([
    ['personal', personal],
    ['keycloak', keycloak],
    ['bounded E2E fixture', e2e],
  ])('enables strict SNI admission in the %s configuration', (_name, source) => {
    expect(source).toMatch(/^\{\s+servers\s+\{\s+strict_sni_host on\s+\}\s+\}/u);
    expect(source.match(/\bstrict_sni_host\s+on\b/gu)).toHaveLength(1);
  });

  it('keeps the Personal application on its one exact HTTPS host and listener', () => {
    const label = '{$HOSTED_DOMAIN:agent-teams.localhost}:{$HOSTED_HTTPS_PORT:443} {';
    expect(siteLabels(personal)).toEqual([label]);
    expect(siteBlock(personal, label)).toContain('reverse_proxy agent-teams-personal:3456');
    expect(personal).not.toContain('KEYCLOAK_DOMAIN');
  });

  it('keeps Keycloak and the application on distinct exact hosts at the same HTTPS listener', () => {
    const applicationLabel = '{$HOSTED_DOMAIN:agent-teams.localhost}:{$HOSTED_HTTPS_PORT:443} {';
    const identityLabel =
      '{$KEYCLOAK_DOMAIN:auth.agent-teams.localhost}:{$HOSTED_HTTPS_PORT:443} {';
    expect(siteLabels(keycloak)).toEqual([applicationLabel, identityLabel]);

    const application = siteBlock(keycloak, applicationLabel);
    const identity = siteBlock(keycloak, identityLabel);
    expect(application).toContain('reverse_proxy agent-teams-keycloak:3456');
    expect(application).not.toContain('reverse_proxy keycloak:8080');
    expect(identity).toContain('reverse_proxy keycloak:8080');
    expect(identity).not.toContain('reverse_proxy agent-teams-keycloak:3456');
  });

  it('limits the bounded E2E backchannel listener to the synthetic OIDC host', () => {
    const applicationLabel = '{$HOSTED_DOMAIN}:{$HOSTED_HTTPS_PORT} {';
    const identityLabel =
      '{$OIDC_DOMAIN}:{$HOSTED_HTTPS_PORT}, {$OIDC_DOMAIN}:{$OIDC_BACKCHANNEL_PORT} {';
    expect(siteLabels(e2e)).toEqual([applicationLabel, identityLabel]);
    expect(siteBlock(e2e, applicationLabel)).toContain('reverse_proxy hosted-controller:3456');
    expect(siteBlock(e2e, applicationLabel)).not.toContain('OIDC_BACKCHANNEL_PORT');
    expect(siteBlock(e2e, identityLabel)).toContain('reverse_proxy synthetic-oidc:8080');
  });
});
