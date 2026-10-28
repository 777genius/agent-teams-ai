import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { SkillRootsResolver } from '@main/services/extensions/skills/SkillRootsResolver';

import type { ExtensionSelection, ManagementSession } from '../../contracts';

type AuthoringRoot = NonNullable<ManagementSession['authoringRoots']>[number];
export interface KnownAuthoringProject {
  id: string;
  path: string;
}
export async function canonicalExtensionPath(candidate: string): Promise<string> {
  if (!path.isAbsolute(candidate)) throw new Error('An extension root must be an absolute path.');
  try {
    return await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return path.join(await canonicalExtensionPath(parent), path.basename(candidate));
  }
}
const rootId = (value: string) =>
  `skill-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
const contains = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};

/** Launch input already belongs to the existing runtime owner; these are admission keys only. */
export async function projectSkillAdmissionResources(projectPath?: string): Promise<string[]> {
  if (!projectPath || !path.isAbsolute(projectPath)) return [];
  return Promise.all(
    new SkillRootsResolver()
      .resolve(projectPath)
      .filter((root) => root.scope === 'project')
      .map((root) => canonicalExtensionPath(root.rootPath))
  );
}

/** Project selectors are resolved against the host's existing project inventory. */
export async function captureAuthoringRoots(
  profiles: readonly { client: string; configRoot: string }[],
  selection: ExtensionSelection,
  knownProjects: () => Promise<readonly KnownAuthoringProject[]>
) {
  const resolver = new SkillRootsResolver();
  const roots = new Map<string, AuthoringRoot>();
  const add = async (candidate: string, scope: 'user' | 'project', targetId?: string) => {
    const physical = await canonicalExtensionPath(candidate);
    const existing = roots.get(physical);
    roots.set(physical, {
      id: rootId(physical),
      path: physical,
      scope,
      ...(existing?.targetId || targetId ? { targetId: existing?.targetId || targetId } : {}),
    });
  };
  for (const profile of profiles)
    await add(path.join(profile.configRoot, 'skills'), 'user', profile.client);
  for (const root of resolver.resolve()) await add(root.rootPath, 'user');
  let project: KnownAuthoringProject | undefined;
  if (
    selection.authoringProject ||
    (selection.authoringRootId &&
      ![...roots.values()].some((root) => root.id === selection.authoringRootId))
  ) {
    const known = await knownProjects();
    for (const candidate of known) {
      const physical = await canonicalExtensionPath(candidate.path);
      if (
        selection.authoringProject === candidate.id ||
        selection.authoringProject === candidate.path ||
        selection.authoringProject === physical
      ) {
        project = { ...candidate, path: physical };
        break;
      }
      if (selection.authoringRootId) {
        for (const root of resolver.resolve(physical).filter((item) => item.scope === 'project')) {
          if (rootId(await canonicalExtensionPath(root.rootPath)) === selection.authoringRootId) {
            project = { ...candidate, path: physical };
            break;
          }
        }
      }
      if (project) break;
    }
    if (!project)
      throw new Error(
        'Open this project in Agent Teams before editing or restoring its local Skills.'
      );
    for (const root of resolver.resolve(project.path).filter((item) => item.scope === 'project')) {
      await add(root.rootPath, 'project');
    }
  }
  const authoringRoots = [...roots.values()].sort((left, right) => left.id.localeCompare(right.id));
  return {
    authoringRoots,
    async locateLocalSkill(skillPath: string) {
      const physical = await canonicalExtensionPath(skillPath);
      const root = authoringRoots.find((candidate) => path.dirname(physical) === candidate.path);
      if (!root)
        throw new Error(
          'The Skill is outside the captured authoring roots. Open its project first.'
        );
      return {
        rootId: root.id,
        skillName: path.basename(physical),
        async overlapsManagedPath(candidate: string) {
          const managed = await canonicalExtensionPath(candidate);
          return contains(physical, managed) || contains(managed, physical);
        },
      };
    },
  };
}
