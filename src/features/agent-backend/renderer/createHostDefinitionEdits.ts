import { HostTeamOperationError } from './createHostTeamMutations';
import { createHostTeamRoster } from './createHostTeamRoster';
import { readHostRosterConfiguration } from './readHostRosterConfiguration';

import type { BackendHandle } from '../contracts';
import type { AgentBackendApi } from '../contracts/operations';
import type { BackendRosterConfiguration, BackendSavedTeamSettings } from '../contracts/roster';
import type {
  EditableMemberSettings,
  MemberSettingsTarget,
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from '@features/team-provisioning/contracts/memberSettings';
import type { TeamConfig, TeamUpdateConfigRequest } from '@shared/types/team';

type Configuration = BackendRosterConfiguration;
type Settings = EditableMemberSettings;
interface Options {
  backend: AgentBackendApi;
  captureScope(): () => boolean;
  resolve(key: string, current: () => boolean): Promise<{ handle: BackendHandle }>;
  invalidateReads(handle: BackendHandle): void;
}
const active = (configuration: Configuration) =>
  configuration.members
    .filter((row) => row.role !== 'lead')
    .map((row) => ({ ...row.settings, name: row.name }));
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const configured = (
  member: Configuration['members'][number],
  configuration: Configuration
): Settings => {
  const source =
    member.role === 'lead'
      ? {
          ...member.settings,
          model: configuration.savedSettings?.model,
          effort: configuration.savedSettings?.effort,
          providerId: configuration.savedSettings?.providerId,
          providerBackendId: configuration.savedSettings?.providerBackendId,
          fastMode: configuration.savedSettings?.fastMode,
        }
      : member.settings;
  return {
    role: source.role ?? null,
    workflow: source.workflow ?? null,
    isolation: source.isolation ?? null,
    providerId: source.providerId ?? null,
    providerBackendId: source.providerBackendId ?? null,
    model: source.model ?? null,
    effort: source.effort ?? null,
    fastMode: source.fastMode ?? null,
    mcpPolicy: source.mcpPolicy ?? null,
  };
};
function refuse(code = 'invalid-definition-edit'): never {
  throw new HostTeamOperationError(code, 'not-dispatched');
}
function token(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) refuse('settings-unavailable');
  return value;
}
/** All edits retain one original full roster CAS; physical histories cannot author a definition. */
export function createHostDefinitionEdits(options: Options) {
  const saved = new Map<
    string,
    {
      signature: string;
      current(): boolean;
      handle?: BackendHandle;
      captured?: Promise<{
        handle: BackendHandle;
        configuration: Configuration;
        current(): boolean;
      }>;
      result?: UpdateMemberSettingsResult;
      committing?: Promise<UpdateMemberSettingsResult>;
    }
  >();
  // A terminal result needs only its exact replay identity, never the captured
  // owner/roster promise. Keep the 1024-entry cap for unresolved operations.
  const terminal = new Map<string, { signature: string; result: UpdateMemberSettingsResult }>();
  async function capture(
    key: string,
    current: () => boolean,
    retained?: { handle?: BackendHandle }
  ) {
    if (!current()) refuse('context-changed');
    const handle = { ...(retained?.handle ?? (await options.resolve(key, current)).handle) };
    if (retained) retained.handle = { ...handle };
    if (!current()) refuse('context-changed');
    const configuration = await readHostRosterConfiguration(options.backend, { ...handle });
    if (!current()) refuse('context-changed');
    return { handle, configuration, current };
  }
  async function commit(
    key: string,
    original: Awaited<ReturnType<typeof capture>>,
    commandId: string,
    members: ReturnType<typeof active>,
    savedSettings?: BackendSavedTeamSettings,
    memberSettingsRelaunch?: Parameters<
      ReturnType<typeof createHostTeamRoster>['replaceMembers']
    >[1]['memberSettingsRelaunch']
  ) {
    const roster = createHostTeamRoster({
      ...options,
      captureScope: () => original.current,
      resolve: async () => ({ handle: { ...original.handle } }),
    });
    await roster.replaceMembers(key, {
      command: { commandId, idempotencyKey: commandId },
      members,
      configuration: {
        expectedRevision: original.configuration.revision,
        ...(savedSettings ? { savedSettings } : {}),
      },
      ...(memberSettingsRelaunch ? { memberSettingsRelaunch } : {}),
    });
  }
  return {
    async updateConfig(key: string, raw: TeamUpdateConfigRequest): Promise<TeamConfig> {
      const updates = structuredClone(raw);
      if (
        !updates ||
        typeof updates !== 'object' ||
        Array.isArray(updates) ||
        Object.keys(updates).some(
          (field) => !['name', 'description', 'color', 'language', 'prompt'].includes(field)
        )
      )
        refuse();
      const original = await capture(key, options.captureScope()),
        savedSettings = original.configuration.savedSettings;
      if (!savedSettings) refuse('settings-unavailable');
      const next = { ...savedSettings };
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined && typeof value !== 'string') refuse();
        const field = key === 'name' ? 'displayName' : key;
        if (value === undefined) Reflect.deleteProperty(next, field);
        else Reflect.set(next, field, value);
      }
      await commit(key, original, crypto.randomUUID(), active(original.configuration), next);
      return {
        name: next.displayName ?? key,
        description: next.description,
        color: next.color,
        language: next.language,
        projectPath: next.cwd,
        members: original.configuration.members.map((row) => ({
          name: row.name,
          ...row.settings,
          agentType: row.role === 'lead' ? 'team-lead' : 'general-purpose',
        })),
      };
    },
    async updateMemberRole(key: string, name: string, role: string | undefined): Promise<void> {
      if (typeof name !== 'string' || !name || (role !== undefined && typeof role !== 'string'))
        refuse();
      const original = await capture(key, options.captureScope()),
        members = active(original.configuration);
      const selected = members.find((row) => row.name === name);
      if (!selected) refuse();
      if (role === undefined) delete selected.role;
      else selected.role = role;
      await commit(key, original, crypto.randomUUID(), members);
    },
    async getMemberSettingsTarget(raw: {
      teamName: string;
      memberName: string;
    }): Promise<MemberSettingsTarget | null> {
      const request = structuredClone(raw),
        { configuration } = await capture(request.teamName, options.captureScope());
      const member = configuration.members.find(
        (row) => row.name.toLowerCase() === request.memberName.toLowerCase()
      );
      if (!member) return null;
      return {
        name: member.name,
        agentType: member.role === 'lead' ? 'team-lead' : 'general-purpose',
        agentId: null,
        joinedAt: null,
        settings: configured(member, configuration),
        configuredSettingsFingerprint: token(member.settingsFingerprint),
      };
    },
    async updateMemberSettings(
      raw: UpdateMemberSettingsRequest
    ): Promise<UpdateMemberSettingsResult> {
      const request = structuredClone(raw);
      if (
        !request ||
        typeof request !== 'object' ||
        !request.commandId ||
        request.commandId.length > 240 ||
        /[\0\r\n]/.test(request.commandId) ||
        request.idempotencyKey !== request.commandId ||
        !['lead', 'member'].includes(request.targetKind)
      )
        refuse();
      const signature = JSON.stringify(request);
      const completed = terminal.get(request.commandId);
      if (completed) {
        if (completed.signature !== signature) refuse('intent-conflict');
        return { ...completed.result, replayed: true };
      }
      const existing = saved.get(request.commandId);
      if (existing && existing.signature !== signature) refuse('intent-conflict');
      // Reserve before any await: overlapping calls can never replace the captured owner or baseline.
      const intent: NonNullable<ReturnType<typeof saved.get>> = existing ?? {
        signature,
        current: options.captureScope(),
      };
      if (!existing) {
        if (saved.size >= 1024) {
          refuse('intent-limit');
        }
        saved.set(request.commandId, intent);
      }
      if (intent.result) return { ...intent.result, replayed: true };
      if (intent.committing) return intent.committing;
      intent.committing = (async () => {
        const captured = (intent.captured ??= Promise.resolve().then(() =>
          capture(request.teamName, intent.current, intent)
        ));
        let original: Awaited<ReturnType<typeof capture>>;
        try {
          original = await captured;
        } catch (error) {
          // Retry only a failed pre-dispatch capture, keeping its original scope and resolved owner.
          if (intent.captured === captured) delete intent.captured;
          throw error;
        }
        const configuration = original.configuration;
        const member = configuration.members.find((row) => row.name === request.memberName);
        const conflict = (actual: string | null): UpdateMemberSettingsResult => ({
          outcome: 'target_conflict',
          memberName: request.memberName,
          expectedFingerprint: request.expectedFingerprint,
          actualFingerprint: actual,
          reason: member ? 'target_changed' : 'member_not_found',
          replayed: !!existing,
        });
        if (!member) return conflict(null);
        const previousFingerprint = token(member.settingsFingerprint);
        if (
          member.role !== request.targetKind ||
          previousFingerprint !== request.expectedFingerprint
        )
          return conflict(previousFingerprint);
        const members = active(configuration),
          before = configured(member, configuration);
        const savedSettings = configuration.savedSettings
          ? { ...configuration.savedSettings }
          : undefined;
        let next = before;
        if (request.targetKind === 'lead') {
          if (
            !savedSettings ||
            !request.leadRuntime ||
            Object.keys(request.leadRuntime).sort().join(',') !== 'effort,model'
          )
            refuse();
          next = { ...before, ...request.leadRuntime };
          for (const key of ['model', 'effort'] as const) {
            if (request.leadRuntime[key] === null) delete savedSettings[key];
            else Reflect.set(savedSettings, key, request.leadRuntime[key]);
          }
        } else {
          if (
            !request.settings ||
            Object.keys(request.settings).sort().join(',') !== Object.keys(before).sort().join(',')
          )
            refuse();
          next = request.settings;
          const selected = members.find((row) => row.name === member.name)!;
          for (const [key, value] of Object.entries(next)) {
            if (value === undefined) refuse();
            if (value === null) Reflect.deleteProperty(selected, key);
            else Reflect.set(selected, key, value);
          }
        }
        const baseline = configuration.members.map((row) => ({
          memberName: row.name,
          expectedFingerprint: token(row.settingsFingerprint),
        }));
        const guard = request.relaunchGuard ?? {
          expectedTeamSettingsFingerprint: configuration.revision,
          baseline,
        };
        await commit(request.teamName, original, request.commandId, members, savedSettings, {
          ...guard,
          targetKind: request.targetKind,
          memberName: member.name,
          expectedFingerprint: previousFingerprint,
          model: next.model,
          effort: next.effort,
        });
        const response = await options.backend.invoke({
          handle: { ...original.handle },
          commandId: request.commandId,
          operation: 'team.roster.lookup',
          payload: {},
        });
        if (!original.current())
          throw new HostTeamOperationError('context-changed', 'unknown', request.commandId);
        if (
          !response.ok ||
          !response.value ||
          !('revision' in response.value) ||
          !('commandId' in response.value) ||
          response.value.commandId !== request.commandId
        )
          throw new HostTeamOperationError('hold', 'unknown', request.commandId);
        const current = await readHostRosterConfiguration(options.backend, original.handle);
        if (!original.current() || current.revision !== response.value.revision)
          throw new HostTeamOperationError('hold', 'unknown', request.commandId);
        const target = current.members.find((row) => row.memberId === member.memberId);
        if (!target) throw new HostTeamOperationError('hold', 'unknown', request.commandId);
        return {
          outcome: 'completed',
          effect: same(before, next) ? 'no_changes' : 'persisted_only',
          memberName: member.name,
          previousFingerprint,
          currentFingerprint: token(target.settingsFingerprint),
          replayed: !!existing,
        } satisfies UpdateMemberSettingsResult;
      })();
      try {
        intent.result = await intent.committing;
        // Free the heavy captured owner/configuration only after a terminal
        // outcome. Preserve exact same-command replay and conflict semantics.
        terminal.set(request.commandId, { signature, result: { ...intent.result } });
        saved.delete(request.commandId);
        return intent.result;
      } finally {
        delete intent.committing;
      }
    },
  };
}
