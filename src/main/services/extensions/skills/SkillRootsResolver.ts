import * as path from 'node:path';

import { getHomeDir } from '@main/utils/pathDecoder';
import { SKILL_ROOT_DEFINITIONS } from '@shared/utils/skillRoots';

import type { SkillRootKind, SkillScope } from '@shared/types/extensions';

export interface ResolvedSkillRoot {
  scope: SkillScope;
  rootKind: SkillRootKind;
  projectRoot: string | null;
  rootPath: string;
}

const USER_ROOTS: { rootKind: SkillRootKind; segments: string[] }[] = SKILL_ROOT_DEFINITIONS.map(
  (definition) => ({
    rootKind: definition.rootKind,
    segments: [...definition.segments],
  })
);

export class SkillRootsResolver {
  resolve(projectPath?: string): ResolvedSkillRoot[] {
    const roots: ResolvedSkillRoot[] = [];
    const homeDir = getHomeDir();

    for (const def of USER_ROOTS) {
      roots.push({
        scope: 'user',
        rootKind: def.rootKind,
        projectRoot: null,
        rootPath: path.join(homeDir, ...def.segments),
      });
    }

    if (projectPath) {
      for (const def of USER_ROOTS) {
        roots.push({
          scope: 'project',
          rootKind: def.rootKind,
          projectRoot: projectPath,
          rootPath: path.join(projectPath, ...def.segments),
        });
      }
    }

    return roots;
  }
}
