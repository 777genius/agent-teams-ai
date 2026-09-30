import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../../src/main/standalone.ts'), 'utf8');

describe('standalone hosted coordination event ownership', () => {
  it('mounts one durable stream from the auth worker and exact auth deployment binding', () => {
    expect(source).toContain('createHostedCoordinationEventStream({');
    expect(source).toContain('storage: hostedAuthStorageBackend.coordinationEvents');
    expect(source).toContain('deploymentId: hostedAccessFeature.deploymentId');
    expect(source).toContain(
      'authorizer: createHostedCoordinationEventStreamAuthorizer(hostedAccessFeature.http)'
    );
    expect(source).toContain('hostedCoordinationEventRoutes: hostedCoordinationEventStream');
    expect(source.match(/createHostedCoordinationEventStream\(\{/g)).toHaveLength(1);
  });

  it('closes stream and hub before HTTP and storage shutdown', () => {
    const shutdown = source.slice(source.indexOf('async function shutdown'));
    const closeStream = shutdown.indexOf('hostedCoordinationEventStream?.close()');
    const stopHttp = shutdown.indexOf('httpServer.stop()');
    const disposeStorage = shutdown.indexOf('hostedAuthStorageBackend?.dispose()');

    expect(closeStream).toBeGreaterThan(-1);
    expect(stopHttp).toBeGreaterThan(closeStream);
    expect(disposeStorage).toBeGreaterThan(stopHttp);
    expect(shutdown).not.toMatch(/(?:Electron|TeamDataService|TeamProvisioningService)/);
  });
});
