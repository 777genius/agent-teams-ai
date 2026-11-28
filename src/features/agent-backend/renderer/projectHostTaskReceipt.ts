import {
  qualifyHostTaskReferenceTeam,
  translateHostTaskReferences,
} from './translateHostTaskReferences';

import type { BackendConnectionSnapshot } from '../contracts/connections';
import type { BackendCommandReceipt } from '../contracts/operations';
import type { TaskRef } from '@shared/types/team';

export interface HostTaskProjection {
  key: string;
  teamName: string;
  referenceBindings?: BackendConnectionSnapshot['bindings'];
}
/** Reapply the original captured reference projection after either execution or lookup. */
export function projectHostTaskReceipt(
  raw: BackendCommandReceipt,
  target: HostTaskProjection
): BackendCommandReceipt {
  const receipt = structuredClone(raw);
  const key = target.key;
  const qualify = (source: TaskRef[] | undefined) =>
    source?.map((ref) => ({
      ...ref,
      teamName: qualifyHostTaskReferenceTeam(
        ref.teamName,
        target.teamName,
        key,
        target.referenceBindings
      ),
    }));
  if (receipt.task) {
    const task = { ...receipt.task };
    const toSelection = (team?: string) =>
      qualifyHostTaskReferenceTeam(team, target.teamName, key, target.referenceBindings);
    if (task.description !== undefined)
      task.description = translateHostTaskReferences(task.description, toSelection);
    if (task.descriptionTaskRefs) task.descriptionTaskRefs = qualify(task.descriptionTaskRefs);
    if (task.prompt !== undefined)
      task.prompt = translateHostTaskReferences(task.prompt, toSelection);
    if (task.promptTaskRefs) task.promptTaskRefs = qualify(task.promptTaskRefs);
    if (task.comments)
      task.comments = task.comments.map((comment) => {
        return {
          ...comment,
          ...(comment.text === undefined
            ? {}
            : { text: translateHostTaskReferences(comment.text, toSelection) }),
          ...(comment.taskRefs ? { taskRefs: qualify(comment.taskRefs) } : {}),
        };
      });
    receipt.task = task;
  }
  if (receipt.comment) {
    const comment = { ...receipt.comment };
    if (comment.taskRefs) comment.taskRefs = qualify(comment.taskRefs);
    if (comment.text !== undefined)
      comment.text = translateHostTaskReferences(comment.text, (team) =>
        qualifyHostTaskReferenceTeam(team, target.teamName, key, target.referenceBindings)
      );
    receipt.comment = comment;
  }
  return receipt;
}
