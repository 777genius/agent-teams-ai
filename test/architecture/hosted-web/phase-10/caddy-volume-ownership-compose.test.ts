import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const compose = parse(readFileSync('docker/docker-compose.yml', 'utf8'));

describe('Caddy named-volume ownership bootstrap', () => {
  it.each([
    ['personal', 'caddy-personal', 'caddy-personal-volume-owner-init', 'caddy-personal'],
    ['keycloak', 'caddy', 'caddy-volume-owner-init', 'caddy'],
  ] as const)(
    'initializes only the %s Caddy volumes before UID 1000 starts',
    (profile, caddyName, initName, volumePrefix) => {
      const services = compose.services;
      const caddy = services[caddyName];
      const initializer = services[initName];

      expect(caddy.user).toBe('1000:1000');
      expect(caddy.profiles).toEqual([profile]);
      expect(initializer.profiles).toEqual([profile]);
      expect(caddy.depends_on[initName]).toMatchObject({
        condition: 'service_completed_successfully',
      });
      expect(initializer).toMatchObject({
        user: '0:0',
        read_only: true,
        cap_drop: ['ALL'],
        cap_add: ['CHOWN'],
        security_opt: ['no-new-privileges:true'],
        network_mode: 'none',
        restart: 'no',
        entrypoint: ['/bin/sh', '/usr/local/bin/init-caddy-volume-ownership'],
      });
      expect(initializer.volumes).toEqual([
        './caddy/init-volume-ownership.sh:/usr/local/bin/init-caddy-volume-ownership:ro',
        `${volumePrefix}-data:/data`,
        `${volumePrefix}-config:/config`,
      ]);
    }
  );
});
