import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  LIFECYCLE_RUN_STATUSES,
  type LifecycleExecutionBackendRegistryPort,
  TEAM_LIFECYCLE_DURABLE_COMMAND_DESCRIPTORS,
} from '@features/team-lifecycle';
import { createTeamLifecycleCommandFeature } from '@features/team-lifecycle/main';
import {
  createHostedLifecycleCommandFeature,
  HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS,
} from '@features/team-lifecycle/main/hosted';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ExecutionBackendRegistry } from '@features/team-runtime-control/core/application/backends';

const ROOT = resolve(import.meta.dirname, '../../../..');
const PRODUCT_PATHS = [
  'src/features/team-lifecycle/contracts/team-lifecycle-commands.ts',
  'src/features/team-lifecycle/contracts/index.ts',
  'src/features/team-lifecycle/core/domain/TeamLifecycle.ts',
  'src/features/team-lifecycle/core/domain/LifecycleRun.ts',
  'src/features/team-lifecycle/core/domain/LegacyRuntimeCutover.ts',
  'src/features/team-lifecycle/core/domain/index.ts',
  'src/features/team-lifecycle/core/application/ports/TeamLifecycleCommandPorts.ts',
  'src/features/team-lifecycle/core/application/LifecycleLaneCoordinator.ts',
  'src/features/team-lifecycle/core/application/PrepareProvisioning.ts',
  'src/features/team-lifecycle/core/application/LaunchTeam.ts',
  'src/features/team-lifecycle/core/application/GetProvisioningStatus.ts',
  'src/features/team-lifecycle/core/application/CancelProvisioning.ts',
  'src/features/team-lifecycle/core/application/StopTeam.ts',
  'src/features/team-lifecycle/core/application/RecoverTeamRun.ts',
  'src/features/team-lifecycle/core/application/index.ts',
  'src/features/team-lifecycle/contracts/hosted-lifecycle-commands.ts',
  'src/features/team-lifecycle/core/application/ports/HostedLifecycleCommandGatewayPort.ts',
  'src/features/team-lifecycle/core/application/ExecuteHostedLifecycleCommand.ts',
  'src/features/team-lifecycle/core/application/GetHostedLifecycleControlState.ts',
  'src/features/team-lifecycle/main/composition/createTeamLifecycleCommandFeature.ts',
  'src/features/team-lifecycle/main/composition/createHostedLifecycleCommandFeature.ts',
  'src/features/team-lifecycle/main/adapters/input/http/registerHostedLifecycleCommandHttp.ts',
  'src/features/team-lifecycle/main/adapters/output/orchestrator/OrchestratorLifecycleCommandClient.ts',
  'src/features/team-lifecycle/main/index.ts',
  'src/features/team-lifecycle/main/hosted.ts',
  'src/features/team-lifecycle/index.ts',
] as const;
const HOSTED_COMMAND_BOUNDARY_PATHS = [
  'src/features/team-lifecycle/contracts/hosted-lifecycle-commands.ts',
  'src/features/team-lifecycle/core/application/ports/HostedLifecycleCommandGatewayPort.ts',
  'src/features/team-lifecycle/core/application/ExecuteHostedLifecycleCommand.ts',
  'src/features/team-lifecycle/core/application/GetHostedLifecycleControlState.ts',
  'src/features/team-lifecycle/main/adapters/input/http/registerHostedLifecycleCommandHttp.ts',
  'src/features/team-lifecycle/main/adapters/output/orchestrator/OrchestratorLifecycleCommandClient.ts',
  'src/features/team-lifecycle/main/composition/createHostedLifecycleCommandFeature.ts',
  'src/features/team-lifecycle/main/hosted.ts',
  'src/main/composition/hosted/teamLifecycleCommandComposition.ts',
] as const;
const CORE_PATHS = PRODUCT_PATHS.filter((path) => path.includes('/core/'));
const FORBIDDEN_IMPORTS = [
  'electron',
  'fastify',
  'node:child_process',
  'node:fs',
  'node:path',
  '@main/',
  '@preload/',
  '@renderer/',
] as const;

describe('team lifecycle command architecture boundary', () => {
  it('keeps lifecycle core free of host paths, raw processes, transports, and platform APIs', () => {
    for (const relativePath of CORE_PATHS) {
      // Repository-owned fixed allowlist.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(
          imports.some((specifier) => specifier === forbidden || specifier.startsWith(forbidden)),
          `${relativePath} imports ${forbidden}`
        ).toBe(false);
      }
      expect(source, relativePath).not.toMatch(/\b(?:cwd|teamName|browserDto|rawPid|processId)\b/);
      expect(source, relativePath).not.toMatch(/\b(?:readFile|writeFile|readdir|spawn|kill)\s*\(/);
    }
  });

  it('does not re-plan or reconstruct an accepted runtime plan', () => {
    for (const relativePath of PRODUCT_PATHS) {
      // Repository-owned fixed allowlist.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(
        /\b(?:createCompositeRuntimePlan|decodeCompositeRuntimePlan|planTeamRuntimeLanes)\b/
      );
    }
  });

  it('keeps product symbols free of execution-packet naming', () => {
    for (const relativePath of PRODUCT_PATHS) {
      // Repository-owned fixed allowlist.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      const identifiers = source.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) ?? [];
      expect(
        identifiers.some(
          (identifier) =>
            identifier.startsWith('Phase') ||
            identifier.startsWith('P4') ||
            identifier.includes('MigrationPhase')
        ),
        relativePath
      ).toBe(false);
    }
  });

  it('publishes durable command descriptors and the main-process composition surface', () => {
    expect(typeof createTeamLifecycleCommandFeature).toBe('function');
    expect(typeof createHostedLifecycleCommandFeature).toBe('function');
    expect(TEAM_LIFECYCLE_DURABLE_COMMAND_DESCRIPTORS.map((item) => item.commandKind)).toEqual([
      'team_lifecycle.launch',
      'team_lifecycle.cancel',
      'team_lifecycle.stop',
      'team_lifecycle.recover',
    ]);
    expect(LIFECYCLE_RUN_STATUSES).toContain('operator_required');
    expectTypeOf<ExecutionBackendRegistry>().toExtend<LifecycleExecutionBackendRegistryPort>();
  });

  it('keeps the hosted command bridge ACL-only, opaque to browsers, and outside desktop runtime ownership', () => {
    const browserContract = readFileSync(
      resolve(ROOT, 'src/features/team-lifecycle/contracts/hosted-lifecycle-commands.ts'),
      'utf8'
    );
    expect(browserContract).not.toMatch(/\b(?:grantId|authorizationGeneration)\b/);
    expect(browserContract).toContain('readonly deploymentId: DeploymentId');
    expect(browserContract).toContain('readonly bootId: BootId');
    expect(browserContract).toContain('readonly availableActions: readonly');

    for (const relativePath of HOSTED_COMMAND_BOUNDARY_PATHS) {
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(
        /\b(?:TeamProvisioningService|createDesktopTeamFeatureComposition|createTeamLifecycleCommandFeature|terminal|child_process|spawn\s*\()\b/
      );
      expect(source, relativePath).not.toMatch(
        /\b(?:createCompositeRuntimePlan|decodeCompositeRuntimePlan|planTeamRuntimeLanes)\b/
      );
    }

    expect(
      HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS.map(({ method, path }) => `${method} ${path}`)
    ).toEqual([
      'POST /api/hosted/v1/team-lifecycle/control-state',
      'POST /api/hosted/v1/team-lifecycle/launch',
      'POST /api/hosted/v1/team-lifecycle/cancel',
      'POST /api/hosted/v1/team-lifecycle/stop',
      'POST /api/hosted/v1/team-lifecycle/recover',
    ]);
  });
});
