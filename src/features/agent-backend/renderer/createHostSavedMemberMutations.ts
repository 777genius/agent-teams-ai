import { createHostTeamRoster } from './createHostTeamRoster';
import { HostTeamOperationError } from './createHostTeamMutations';
import { readHostRosterConfiguration } from './readHostRosterConfiguration';
import type { BackendHandle } from '../contracts';
import type { AgentBackendApi } from '../contracts/operations';
import type { BackendRosterConfiguration } from '../contracts/roster';
import type { AddMemberRequest, TeamProvisioningMemberInput } from '@shared/types/team';

/** Existing single-member saved edits compile to the same complete roster CAS, receipt and uncertainty path. */
export function createHostSavedMemberMutations(options: {
  backend: AgentBackendApi;
  captureScope(): () => boolean;
  resolve(key: string, current: () => boolean): Promise<{ handle: BackendHandle }>;
  invalidateReads(handle: BackendHandle): void;
}) {
  async function change(
    key: string,
    transform: (configuration: BackendRosterConfiguration) => TeamProvisioningMemberInput[]
  ): Promise<void> {
    const current = options.captureScope(),
      commandId = crypto.randomUUID();
    if (!current())
      throw new HostTeamOperationError('context-changed', 'not-dispatched', commandId);
    const target = await options.resolve(key, current),
      handle = { ...target.handle };
    const configuration = await readHostRosterConfiguration(options.backend, handle);
    if (!current())
      throw new HostTeamOperationError('context-changed', 'not-dispatched', commandId);
    const members = transform(configuration);
    // Reuse exact original handle and fully captured replacement for both effect and original receipt lookup.
    const roster = createHostTeamRoster({
      ...options,
      captureScope: () => current,
      resolve: async () => ({ handle: { ...handle } }),
    });
    await roster.replaceMembers(key, {
      members,
      command: { commandId, idempotencyKey: commandId },
      configuration: { expectedRevision: configuration.revision },
    });
  }
  const active = (configuration: BackendRosterConfiguration): TeamProvisioningMemberInput[] =>
    configuration.members
      .filter((member) => member.role !== 'lead')
      .map((member) => ({ ...member.settings, name: member.name }));
  const normalized = (value: string) => value.trim().toLowerCase();
  function refuse(): never {
    throw new HostTeamOperationError('invalid-saved-member-edit', 'not-dispatched');
  }
  return {
    async addMember(key: string, raw: AddMemberRequest): Promise<void> {
      const request = structuredClone(raw);
      if (
        !request ||
        typeof request !== 'object' ||
        typeof request.name !== 'string' ||
        Object.keys(request).some(
          (field) =>
            ![
              'name',
              'role',
              'workflow',
              'isolation',
              'providerId',
              'providerBackendId',
              'model',
              'effort',
              'fastMode',
              'mcpPolicy',
            ].includes(field)
        )
      )
        refuse();
      return change(key, (configuration) => {
        if (
          [...configuration.members, ...configuration.removedMembers].some(
            (member) => normalized(member.name) === normalized(request.name)
          )
        )
          refuse();
        return [...active(configuration), request];
      });
    },
    async removeMember(key: string, name: string): Promise<void> {
      if (typeof name !== 'string' || !name.trim()) refuse();
      return change(key, (configuration) => {
        const selected = configuration.members.find(
          (member) => normalized(member.name) === normalized(name)
        );
        if (!selected || selected.role === 'lead') refuse();
        return active(configuration).filter((member) => member.name !== selected.name);
      });
    },
    async restoreMember(key: string, name: string): Promise<void> {
      if (typeof name !== 'string' || !name.trim()) refuse();
      return change(key, (configuration) => {
        const selected = configuration.removedMembers.find(
          (member) => normalized(member.name) === normalized(name)
        );
        if (
          !selected ||
          configuration.members.some((member) => normalized(member.name) === normalized(name))
        )
          refuse();
        // Owner roster replacement retains the removed memberId and strips old delivery/grants;
        // removedAt/agentId/joinedAt/native selectors never appear in this saved-settings DTO.
        return [...active(configuration), { ...selected.settings, name: selected.name }];
      });
    },
  };
}
