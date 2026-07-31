import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SERVICE_PATH = 'src/main/services/team/TeamDataService.ts';
const COMPOSITION_PATH = 'src/main/services/team/TeamDataServiceFeatureComposition.ts';
const TEAM_ENTRYPOINT_PATH = 'src/main/services/team/index.ts';
const RESPONSIBILITY_CONSTRUCTORS = [
  'TeamArtifactReconciliationCoordinator',
  'TeamMessagePersistenceCoordinator',
  'TeamTaskReadModelService',
  'TeamTaskMutationCoordinator',
  'TeamTaskStartCoordinator',
  'TeamTaskCommentNotificationCoordinator',
  'TeamViewReadModelService',
] as const;
const FORBIDDEN_COMPOSITION_IMPORT =
  /(?:agent-teams-controller|TeamProvisioningService|team-runtime-control|OpenCode|opencode|child_process|electron|fastify|timer)/i;

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test-owned paths.
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function constructorNames(contents: string): string[] {
  return [...contents.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]);
}

function importSpecifiers(contents: string): string[] {
  return [...contents.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

describe('TeamDataService internal feature composition boundary', () => {
  it('constructs exactly the seven admitted feature responsibilities outside the legacy service', () => {
    const serviceContents = source(SERVICE_PATH);
    const compositionContents = source(COMPOSITION_PATH);

    expect(constructorNames(compositionContents)).toEqual(RESPONSIBILITY_CONSTRUCTORS);
    expect(
      RESPONSIBILITY_CONSTRUCTORS.filter((name) =>
        new RegExp(`\\bnew\\s+${name}\\s*\\(`).test(serviceContents)
      )
    ).toEqual([]);
    expect(serviceContents.match(/\bnew\s+TeamDataServiceFeatureComposition\s*\(/g)).toHaveLength(
      1
    );
    const serviceLineCount = serviceContents.trimEnd().split(/\r?\n/).length;
    expect(serviceLineCount).toBeGreaterThanOrEqual(560);
    expect(serviceLineCount).toBeLessThanOrEqual(640);
    expect(serviceContents.match(/\bnew\s+TeamDataProcessCompatibilityService\s*\(/g)).toHaveLength(
      1
    );
    expect(
      serviceContents.match(/\bnew\s+TeamDataConfigurationCompatibilityService\s*\(/g)
    ).toHaveLength(1);
  });

  it('keeps mutable runtime collaborators late-bound through accessors', () => {
    const compositionContents = source(COMPOSITION_PATH);
    const serviceContents = source(SERVICE_PATH);

    expect(compositionContents).toContain('ports.getTaskBoardCommandFacade().createTask(command)');
    expect(compositionContents).toMatch(
      /ports\s*\.getMemberRuntimeAdvisoryService\(\)\s*\.getMemberAdvisories/
    );
    expect(compositionContents).not.toMatch(
      /(?:const|let|readonly)\s+\w+\s*=\s*ports\.(?:getTaskBoardCommandFacade|getMemberRuntimeAdvisoryService)\(\)/
    );
    expect(serviceContents).toContain(
      'getTaskBoardCommandFacade: () => this.taskBoardCommandFacade'
    );
    expect(serviceContents).toContain(
      'getMemberRuntimeAdvisoryService: () => this.memberRuntimeAdvisoryService'
    );
  });

  it('stays internal, policy-free, and unable to activate runtime lifecycle ownership', () => {
    const compositionContents = source(COMPOSITION_PATH);
    const entrypointContents = source(TEAM_ENTRYPOINT_PATH);

    expect(
      importSpecifiers(compositionContents).filter((path) =>
        FORBIDDEN_COMPOSITION_IMPORT.test(path)
      )
    ).toEqual([]);
    expect(compositionContents).not.toMatch(
      /\b(?:setInterval|setTimeout|clearInterval|clearTimeout|spawn|fork|createController)\s*\(/
    );
    expect(entrypointContents).not.toContain('TeamDataServiceFeatureComposition');
  });
});
