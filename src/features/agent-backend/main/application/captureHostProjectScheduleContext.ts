import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { parseHostTeamSelectionKey } from '../../contracts/teamSelection';

import { captureHostScheduleTarget, restoreHostScheduleTarget } from './captureHostScheduleTarget';

import type { BackendProjectContextSnapshot } from '../../contracts/projectContext';
import type { DesktopBackendFeature } from '../composition/DesktopBackendFeature';
import type { CapturedHostScheduleTarget } from './captureHostScheduleTarget';
import type { ScheduleFolderChange } from '@main/services/schedule/scheduleTarget';

const fixedProject =
  'The project of a schedule can not be changed. Create a new schedule for the other project';
const missingCopy = 'Launch the team in this project once before running its schedule';
const samePath = (left: string, right: string) => {
  const a = path.resolve(left),
    b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};
type ReadyProject = Extract<BackendProjectContextSnapshot['view'], { workContextId: string }>;
interface ResolvedProject {
  target: CapturedHostScheduleTarget;
  selection: string;
  projectPath: string;
}

/** Read-only admission; only prepare() may synchronize the already selected history. */
export async function captureHostProjectScheduleContext(options: {
  feature: DesktopBackendFeature;
  logical: CapturedHostScheduleTarget;
  projectPath: string;
  folderChange?: ScheduleFolderChange;
  runId?: string;
}) {
  const assertCurrent = () => {
    if (!options.logical.isCurrent())
      throw new Error('Original scheduled project owner is unavailable');
  };
  const read = async () => {
    assertCurrent();
    const result = await options.logical.invoke({
      operation: 'team.project-context.read',
      commandId: randomUUID(),
      payload: { projectPath: options.projectPath, scheduleAdmission: true },
    });
    assertCurrent();
    if (
      !result.ok ||
      !result.value ||
      !('kind' in result.value) ||
      result.value.kind !== 'team-project-context'
    )
      throw new Error('Scheduled project admission is unavailable');
    return result.value;
  };
  const initial = await read();
  if (initial.view.mode === 'shared') return undefined;
  if (initial.view.state === 'redirect')
    throw new Error('Schedule the logical team, not its project copy');
  if (
    options.folderChange?.cwd !== undefined &&
    options.folderChange.from !== undefined &&
    !samePath(options.folderChange.cwd, options.folderChange.from)
  )
    throw new Error(fixedProject);
  const selected = initial.view.state === 'ready' ? structuredClone(initial.view) : undefined;
  let verified: ResolvedProject | undefined;
  let preparation:
    | Promise<ResolvedProject & { rosterCommandId: string; sourceRevision: string }>
    | undefined;
  let preparationRevision: string | undefined;

  const verify = async (view: ReadyProject): Promise<ResolvedProject> => {
    assertCurrent();
    if (
      !selected ||
      view.executionTeamName !== selected.executionTeamName ||
      view.workContextId !== selected.workContextId ||
      view.projectPath !== selected.projectPath
    )
      throw new Error('Original scheduled project history changed');
    const handleId = parseHostTeamSelectionKey(view.executionTeamName);
    const snapshot = await options.feature.discoverBindings(options.logical.target.contextId, {
      isCurrent: options.logical.isCurrent,
    });
    assertCurrent();
    const binding = snapshot.bindings.find((row) => row.handle.handleId === handleId);
    const sameRelation = () => {
      if (!options.logical.isCurrent()) return false;
      const current = options.feature
        .listBindings(options.logical.target.contextId)
        .bindings.find((row) => row.handle.handleId === handleId);
      return (
        current?.ownerResourceRef === options.logical.target.ownerResourceRef &&
        current.projectContext?.logicalHandleId === options.logical.target.handleId &&
        current.projectContext.workContextId === view.workContextId &&
        current.projectContext.projectPath === view.projectPath
      );
    };
    if (snapshot.state !== 'ready' || !binding || !sameRelation())
      throw new Error('Scheduled project owner changed');
    const captured = await captureHostScheduleTarget(
      options.feature,
      options.logical.target.contextId,
      view.executionTeamName,
      { isCurrent: sameRelation }
    );
    if (
      verified &&
      (captured.handleId !== verified.target.target.handleId ||
        captured.ownerResourceRef !== verified.target.target.ownerResourceRef ||
        captured.teamResourceRef !== verified.target.target.teamResourceRef)
    )
      throw new Error('Original scheduled project binding changed');
    const target = await restoreHostScheduleTarget(
      options.feature,
      view.executionTeamName,
      captured,
      sameRelation
    );
    assertCurrent();
    verified = { target, selection: view.executionTeamName, projectPath: view.projectPath };
    return verified;
  };

  return {
    logical: options.logical,
    projectPath: selected?.projectPath ?? options.projectPath,
    async resolve(): Promise<ResolvedProject | { refused: string }> {
      const current = await read();
      if (!selected || current.view.mode !== 'per_project' || current.view.state !== 'ready')
        return { refused: missingCopy };
      return verify(current.view);
    },
    prepare(expectedRevision: string) {
      if (!options.runId) throw new Error('No scheduled project occurrence was admitted');
      if (preparationRevision !== undefined && expectedRevision !== preparationRevision)
        throw new Error('Original scheduled project definition changed');
      preparationRevision ??= expectedRevision;
      preparation ??= (async () => {
        const current = await read();
        if (!selected || current.view.mode !== 'per_project' || current.view.state !== 'ready')
          throw new Error(missingCopy);
        await verify(current.view);
        const result = await options.logical.invoke({
          operation: 'team.project-context.prepare',
          commandId: `${options.runId}:project`,
          payload: { projectPath: selected.projectPath, expectedRevision },
        });
        assertCurrent();
        if (
          !result.ok ||
          !result.value ||
          !('kind' in result.value) ||
          result.value.kind !== 'team-project-context' ||
          result.value.view.mode !== 'per_project' ||
          result.value.view.state !== 'ready'
        )
          throw new Error('Original scheduled project preparation awaits confirmation');
        const prepared = result.value.prepared;
        if (
          !prepared ||
          prepared.sourceRevision !== expectedRevision ||
          prepared.executionHandle.handleId !==
            parseHostTeamSelectionKey(selected.executionTeamName)
        )
          throw new Error('Original scheduled project preparation changed');
        const execution = await verify(result.value.view);
        return {
          ...execution,
          rosterCommandId: prepared.rosterCommandId,
          sourceRevision: prepared.sourceRevision,
        };
      })();
      return preparation;
    },
  };
}

export type CapturedHostProjectScheduleContext = NonNullable<
  Awaited<ReturnType<typeof captureHostProjectScheduleContext>>
>;
