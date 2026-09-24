import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const compose = parse(readFileSync('docker/docker-compose.yml', 'utf8'));

describe('hosted Product OpenCode writable HOME', () => {
  it.each(['agent-teams-personal', 'agent-teams-keycloak'])(
    'uses only private tmpfs for %s runtime home',
    (serviceName) => {
      const service = compose.services[serviceName];
      expect(service.user).toBe('1000:1000');
      expect(service.read_only).toBe(true);
      expect(service.environment.HOME).toBeUndefined();
      expect(service.tmpfs).toContain('/home/node:mode=0700,uid=1000,gid=1000');
    }
  );
});
