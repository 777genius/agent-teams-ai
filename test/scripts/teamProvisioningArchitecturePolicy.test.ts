import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

interface ArchitectureRecord {
  path: string;
  contents: string;
}

interface ArchitectureModule {
  evaluateArchitectureRatchet(
    records: ArchitectureRecord[],
    baseline: { rules: Record<string, Record<string, number>> }
  ): { violations: Array<{ code: string; ruleName: string; path: string }> };
  isProvisioningProductionPath(filePath: string): boolean;
}

let architectureModule: ArchitectureModule;

beforeAll(async () => {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'scripts/ci/check-team-provisioning-architecture.mjs')
  ).href;
  architectureModule = (await import(moduleUrl)) as ArchitectureModule;
});

function emptyBaseline(): { rules: Record<string, Record<string, number>> } {
  return {
    rules: {
      facadeInheritance: {},
      serviceHostDeclaration: {},
      serviceHostCast: {},
      protectedAbstractDependency: {},
      createFromServiceFactory: {},
    },
  };
}

describe('Team Provisioning architecture ratchet', () => {
  it('scans production provisioning files and excludes tests', () => {
    expect(
      architectureModule.isProvisioningProductionPath(
        'src/main/services/team/provisioning/RuntimeQuery.ts'
      )
    ).toBe(true);
    expect(
      architectureModule.isProvisioningProductionPath(
        'src/main/services/team/provisioning/__tests__/RuntimeQuery.test.ts'
      )
    ).toBe(false);
  });

  it('rejects a new facade inheritance layer', () => {
    const result = architectureModule.evaluateArchitectureRatchet(
      [
        {
          path: 'src/main/services/team/provisioning/NewFacade.ts',
          contents:
            'export abstract class NewFacade extends TeamProvisioningCompatibilityFacade {}',
        },
      ],
      emptyBaseline()
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: 'architecture-debt-grew',
        ruleName: 'facadeInheritance',
      })
    );
  });

  it('rejects extending the legacy facade delegate base', () => {
    const result = architectureModule.evaluateArchitectureRatchet(
      [
        {
          path: 'src/main/services/team/provisioning/NewRuntimeState.ts',
          contents:
            'export abstract class NewRuntimeState extends TeamProvisioningServiceFacadeDelegates {}',
        },
      ],
      emptyBaseline()
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: 'architecture-debt-grew',
        ruleName: 'facadeInheritance',
      })
    );
  });

  it('rejects whole-service host casts and protected abstract dependency slots', () => {
    const result = architectureModule.evaluateArchitectureRatchet(
      [
        {
          path: 'src/main/services/team/provisioning/NewFlow.ts',
          contents: `
            export interface TeamProvisioningNewFlowServiceHost {}
            const host = service as unknown as RuntimeNewFlowServiceHost;
            abstract class NewFlow { protected abstract readonly store: object; }
          `,
        },
      ],
      emptyBaseline()
    );
    expect(result.violations.map((violation) => violation.ruleName)).toEqual(
      expect.arrayContaining([
        'serviceHostDeclaration',
        'serviceHostCast',
        'protectedAbstractDependency',
      ])
    );
  });

  it('allows frozen legacy debt at its exact cap', () => {
    const filePath = 'src/main/services/team/provisioning/LegacyFacade.ts';
    const baseline = emptyBaseline();
    baseline.rules.facadeInheritance[filePath] = 1;
    const result = architectureModule.evaluateArchitectureRatchet(
      [
        {
          path: filePath,
          contents:
            'export abstract class LegacyFacade extends TeamProvisioningCompatibilityFacade {}',
        },
      ],
      baseline
    );
    expect(result.violations).toEqual([]);
  });

  it('requires the baseline to ratchet when legacy debt is removed', () => {
    const filePath = 'src/main/services/team/provisioning/LegacyFacade.ts';
    const baseline = emptyBaseline();
    baseline.rules.facadeInheritance[filePath] = 1;
    const result = architectureModule.evaluateArchitectureRatchet(
      [{ path: filePath, contents: 'export class LegacyFacade {}' }],
      baseline
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: 'baseline-can-decrease',
        ruleName: 'facadeInheritance',
      })
    );
  });
});
