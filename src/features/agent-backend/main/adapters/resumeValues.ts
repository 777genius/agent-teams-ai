import { rosterRow as row, rosterText as text } from './rosterValues';

import type {
  BackendResumeChoice,
  BackendResumePreparation,
  BackendResumePrepareRequest,
} from '../../contracts/restorations';

export function resumeChoices(value: unknown): BackendResumeChoice[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64)
    throw new Error('Invalid Resume members');
  const members = value.map((value) => {
    const item = row(value, ['memberId', 'sourceGeneration', 'reference', 'commandId']);
    const reference = text(item.reference);
    if (!/^cp1-[a-f0-9]{64}$/.test(reference)) throw new Error('Invalid Resume reference');
    return {
      memberId: text(item.memberId),
      sourceGeneration: text(item.sourceGeneration),
      reference,
      commandId: text(item.commandId),
    };
  });
  if (
    new Set(members.map((member) => member.memberId)).size !== members.length ||
    new Set(members.map((member) => member.commandId)).size !== members.length
  )
    throw new Error('Invalid Resume members');
  return members;
}
export function parseResumePrepare(value: unknown): BackendResumePrepareRequest {
  const source = row(value, ['launchId', 'rosterRevision', 'resumeId', 'members']);
  return {
    launchId: text(source.launchId),
    rosterRevision: text(source.rosterRevision),
    resumeId: text(source.resumeId),
    members: resumeChoices(source.members),
  };
}
export function projectResumePreparation(value: unknown): BackendResumePreparation {
  const source = row(value);
  if (!Array.isArray(source.members)) throw new Error('Invalid Resume preparation');
  const choices = resumeChoices(
    source.members.map((value) => {
      const item = row(value);
      return {
        memberId: item.memberId,
        sourceGeneration: item.sourceGeneration,
        reference: item.reference,
        commandId: item.commandId,
      };
    })
  );
  return {
    resumeId: text(source.resumeId),
    rosterRevision: text(source.rosterRevision),
    members: source.members.map((value, index) => {
      const item = row(value);
      if (
        typeof item.requested !== 'boolean' ||
        (item.refused !== undefined &&
          (!item.requested || !['invalid', 'conflict', 'hold'].includes(String(item.refused))))
      )
        throw new Error('Invalid Resume state');
      return {
        ...choices[index]!,
        requested: item.requested,
        ...(item.refused === undefined
          ? {}
          : { refused: item.refused as 'invalid' | 'conflict' | 'hold' }),
      };
    }),
  };
}
