import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../src/main/services/team/provisioning'
);

function source(name: string): string {
  return readFileSync(path.join(sourceRoot, name), 'utf8');
}

describe('project-directory lease production wiring', () => {
  it('keeps descriptor-bound provider spawn and restart boundaries wired', () => {
    expect(source('TeamProvisioningCreateDeterministicSpawnFlow.ts')).toContain(
      'applyProjectDirectoryLeaseAtProviderBoundary(request'
    );
    expect(source('TeamProvisioningLaunchDeterministicSpawnFlow.ts')).toContain(
      'applyProjectDirectoryLeaseAtProviderBoundary(syntheticRequest'
    );
    expect(source('TeamProvisioningAuthRetryRecovery.ts')).toContain(
      'applyProjectDirectoryLeaseAtProviderBoundaryWithLease('
    );
    expect(source('TeamProvisioningLeadRuntimeRestart.ts')).toContain(
      'applyProjectDirectoryLeaseAtProviderBoundaryWithLease('
    );
    expect(source('TeamProvisioningMemberLifecycle.ts')).toContain(
      'this.assertRunStillCurrentAndAlive(input.run, input.teamName);'
    );
  });
});
