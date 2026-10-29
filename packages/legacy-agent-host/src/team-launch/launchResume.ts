import { z } from 'zod';
import { runtimeDigest } from '../runtime/identity.js';
import { TeamLaunchError } from './contracts.js';
import type { TeamLaunchRecord } from './contracts.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\0'));
const choice = z
  .object({
    memberId: id,
    sourceGeneration: id,
    reference: z.string().regex(/^cp1-[a-f0-9]{64}$/),
    commandId: id,
  })
  .strict();
export const resumePreparationSchema = z
  .object({
    launchId: id,
    rosterRevision: id,
    resumeId: id,
    members: z.array(choice).min(1).max(64),
  })
  .strict();
export type ResumePreparationRequest = z.infer<typeof resumePreparationSchema>;
export type ResumeChoice = ResumePreparationRequest['members'][number];
export type ResumeVerifier = (members: ResumeChoice[]) => void;
export type ResumeRefusal = {
  resumeId: string;
  commandId: string;
  code: 'invalid' | 'conflict' | 'hold';
};
export interface ResumePreparation {
  resumeId: string;
  rosterRevision: string;
  members: (z.infer<typeof choice> & {
    requested: boolean;
    refused?: 'invalid' | 'conflict' | 'hold';
  })[];
}
export interface ResumeJournal {
  read(): TeamLaunchRecord;
  write(record: TeamLaunchRecord): void;
  authorized<T>(action: () => T): T;
}
const choices = (members: ResumePreparation['members']) =>
  members.map(({ requested: _requested, refused: _refused, ...member }) => member);
const fingerprint = (
  input: Pick<ResumePreparationRequest, 'resumeId' | 'rosterRevision' | 'members'>
) => runtimeDigest(input);

export function validateResumePreparations(record: TeamLaunchRecord): void {
  try {
    const commands = new Set<string>(),
      ids = new Set<string>();
    for (const group of record.resumePreparations ?? []) {
      const input = resumePreparationSchema.parse({
        launchId: record.definition.launchId,
        resumeId: group.resumeId,
        rosterRevision: group.rosterRevision,
        members: choices(group.members),
      });
      if (new Set(group.members.map((row) => row.memberId)).size !== group.members.length)
        throw new Error();
      if (
        ids.has(group.resumeId) ||
        group.fingerprint !==
          fingerprint({
            resumeId: input.resumeId,
            rosterRevision: input.rosterRevision,
            members: input.members,
          })
      )
        throw new Error();
      ids.add(group.resumeId);
      for (const member of group.members) {
        if (
          commands.has(member.commandId) ||
          typeof member.requested !== 'boolean' ||
          (member.refused !== undefined &&
            (!member.requested || !['invalid', 'conflict', 'hold'].includes(member.refused)))
        )
          throw new Error();
        commands.add(member.commandId);
        const selected = record.restorations?.find((row) => row.commandId === member.commandId);
        if (
          selected &&
          (!member.requested ||
            member.refused ||
            selected.member.memberId !== member.memberId ||
            selected.member.restore?.reference !== member.reference ||
            selected.member.restore.sourceBinding.generation !== member.sourceGeneration)
        )
          throw new Error();
      }
    }
    for (const selected of record.restorations ?? []) commands.add(selected.commandId);
    if (commands.size > 64) throw new Error();
  } catch {
    throw new TeamLaunchError('hold', 'resume-journal-corrupt');
  }
}

export function prepareResume(
  journal: ResumeJournal,
  raw: unknown,
  verify: (members: ResumePreparationRequest['members']) => void
): ResumePreparation {
  const input = resumePreparationSchema.parse(raw);
  const immutable = {
    resumeId: input.resumeId,
    rosterRevision: input.rosterRevision,
    members: input.members,
  };
  const digest = fingerprint(immutable);
  const original = journal.authorized(() =>
    journal.read().resumePreparations?.find((row) => row.resumeId === input.resumeId)
  );
  if (original) {
    if (original.fingerprint !== digest) throw new TeamLaunchError('conflict', 'resume-command');
    return structuredClone({
      resumeId: original.resumeId,
      rosterRevision: original.rosterRevision,
      members: original.members,
    });
  }
  verify(input.members); // Synchronous Runtime fences, outside Team's publication fence; no SDK/await.
  return journal.authorized(() => {
    const record = journal.read(),
      expected = record.definition.members.filter((row) => !row.skipped);
    const ids = new Set(input.members.map((row) => row.memberId)),
      commands = new Set(input.members.map((row) => row.commandId));
    if (
      record.definition.launchId !== input.launchId ||
      record.definition.rosterRevision !== input.rosterRevision ||
      ids.size !== input.members.length ||
      commands.size !== input.members.length ||
      expected.length !== input.members.length ||
      expected.some(
        (row) =>
          !row.binding ||
          input.members.find((item) => item.memberId === row.memberId)?.sourceGeneration !==
            row.binding.generation
      )
    )
      throw new TeamLaunchError('conflict', 'resume-source');
    const previous = record.resumePreparations ?? [];
    if (
      previous.some((group) =>
        group.members.some(
          (row) =>
            !row.refused &&
            !record.restorations?.some((selected) => selected.commandId === row.commandId)
        )
      )
    )
      throw new TeamLaunchError('hold', 'resume-pending');
    const existing = new Set([
      ...(record.restorations ?? []).map((row) => row.commandId),
      ...previous.flatMap((group) => group.members.map((row) => row.commandId)),
    ]);
    if (
      input.members.some((row) => existing.has(row.commandId)) ||
      existing.size + input.members.length > 64
    )
      throw new TeamLaunchError('conflict', 'resume-capacity');
    const group = {
      ...immutable,
      members: input.members.map((row) => ({ ...row, requested: false })),
      fingerprint: digest,
    };
    record.resumePreparations = [...previous, group];
    journal.write(record);
    return structuredClone({
      resumeId: group.resumeId,
      rosterRevision: group.rosterRevision,
      members: group.members,
    });
  });
}

export function requestResumeMember(
  journal: ResumeJournal,
  resumeId: string | undefined,
  input: ResumePreparationRequest['members'][number]
): void {
  input = choice.parse(input);
  journal.authorized(() => {
    const record = journal.read(),
      groups = record.resumePreparations ?? [];
    if (resumeId === undefined) {
      if (
        groups.some((group) =>
          group.members.some(
            (row) =>
              row.commandId === input.commandId ||
              (row.memberId === input.memberId && row.sourceGeneration === input.sourceGeneration)
          )
        )
      )
        throw new TeamLaunchError('invalid', 'resume-id-required');
      return; // Existing unprepared technical restore contract.
    }
    const member = groups
      .find((group) => group.resumeId === resumeId)
      ?.members.find((row) => row.memberId === input.memberId);
    if (!member || runtimeDigest(choices([member])[0]) !== runtimeDigest(input))
      throw new TeamLaunchError('conflict', 'resume-member');
    if (member.requested)
      throw new TeamLaunchError(
        'hold',
        member.refused ? 'resume-refused' : 'resume-request-unknown'
      );
    if (
      record.definition.members.find((row) => row.memberId === input.memberId)?.binding
        ?.generation !== input.sourceGeneration
    )
      throw new TeamLaunchError('conflict', 'resume-source');
    member.requested = true;
    journal.write(record); // Durable dispatch fact before the caller's first await.
  });
}

export function refuseResumeMember(
  journal: ResumeJournal,
  resumeId: string,
  commandId: string,
  code: 'invalid' | 'conflict' | 'hold',
  proveReleasedSource: () => boolean
): void {
  if (!proveReleasedSource()) return;
  journal.authorized(() => {
    const record = journal.read(),
      member = record.resumePreparations
        ?.find((group) => group.resumeId === resumeId)
        ?.members.find((row) => row.commandId === commandId);
    if (
      !member?.requested ||
      member.refused ||
      record.restorations?.some((row) => row.commandId === commandId) ||
      record.definition.members.find((row) => row.memberId === member.memberId)?.binding
        ?.generation !== member.sourceGeneration
    )
      return;
    member.refused = code;
    journal.write(record);
  });
}
