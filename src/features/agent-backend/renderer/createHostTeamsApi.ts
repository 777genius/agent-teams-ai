import { captureHostNotification } from '../contracts/hostNotification';
import { readBackendProcesses } from '../contracts/processes';
import { isHostTeamRunId } from '../contracts/teamRunSelection';

import { createHostLeadApi } from './createHostLeadApi';
import { createHostLogStatsApi } from './createHostLogStatsApi';
import { createHostMemberActions } from './createHostMemberActions';
import { createHostMemberSpawnStatuses } from './createHostMemberSpawnStatuses';
import { createHostMessageAttachmentRead } from './createHostMessageAttachmentRead';
import { createHostProcessControls } from './createHostProcessControls';
import { createHostProductLifecycleApi } from './createHostProductLifecycleApi';
import { createHostSavedMemberMutations } from './createHostSavedMemberMutations';
import { createHostTaskActivityApi } from './createHostTaskActivityApi';
import { createHostTaskAttachmentRead } from './createHostTaskAttachmentRead';
import { createHostTaskReads } from './createHostTaskReads';
import { createHostTeamChanges } from './createHostTeamChanges';
import { createHostTeamLaunchSubmission } from './createHostTeamLaunchSubmission';
import { createHostTeamLifecycle } from './createHostTeamLifecycle';
import { createHostTeamMutations, HostTeamOperationError } from './createHostTeamMutations';
import { createHostTeamProvisioning } from './createHostTeamProvisioning';
import { createHostTeamRoster } from './createHostTeamRoster';
import { createHostToolApprovals } from './createHostToolApprovals';
import {
  hasHostTeamDestination,
  hostTeamSelectionKey,
  isHostTeamSelectionKey,
} from './hostTeamRouting';
import { projectHostMemberAttachmentCapabilities } from './projectHostMemberAttachmentCapabilities';
import { projectHostSavedTeamRequest } from './projectHostSavedTeamRequest';
import { readHostRosterConfiguration } from './readHostRosterConfiguration';
import { createTeamCreationResultApi } from './readTeamCreationResult';
import { remapHostCrossTeamMessages } from './remapHostCrossTeamMessages';
import { TeamProductReadOrder } from './TeamProductReadOrder';
import {
  qualifyHostTaskReferenceTeam,
  storeHostTaskReferenceTeam,
  translateHostTaskReferences,
} from './translateHostTaskReferences';

import type { BackendConnectionSnapshot } from '../contracts/connections';
import type { AgentBackendApi } from '../contracts/operations';
import type { BackendRosterConfiguration } from '../contracts/roster';
import type { BackendTeamSnapshot } from '../contracts/teamSnapshot';
import type { HostActivityReadOptions } from './readHostActivityLogs';
import type { TeamsAPI } from '@shared/types/api';
import type { InboxMessage, TeamTaskWithKanban, TeamViewSnapshot } from '@shared/types/team';

export { hostTeamSelectionKey, isHostTeamSelectionKey } from './hostTeamRouting';

type Connection = BackendConnectionSnapshot['bindings'][number];
type CurrentScope = () => boolean;

function current(check: CurrentScope): void {
  if (!check()) throw new Error('Team context changed');
}
function assertMatchingConfiguration(
  snapshot: BackendTeamSnapshot,
  configuration: BackendRosterConfiguration
): void {
  if (
    snapshot.configurationRevision !== undefined &&
    snapshot.configurationRevision !== configuration.revision
  )
    throw new Error('Team configuration changed');
  if (
    configuration.members.length !== snapshot.members.length ||
    configuration.members.some(
      (member) =>
        !snapshot.members.some((row) => row.name === member.name && row.role === member.role)
    )
  )
    throw new Error('Team roster changed');
}
function remapSnapshot(
  snapshot: BackendTeamSnapshot,
  selection: string,
  bindings: Connection[] = []
): BackendTeamSnapshot {
  const mapTeam = (team?: string) =>
    qualifyHostTaskReferenceTeam(team, snapshot.teamName, selection, bindings);
  const refs = <T extends { taskRefs?: { teamName: string }[] }>(entry: T): T => ({
    ...entry,
    ...('text' in entry && typeof entry.text === 'string'
      ? { text: translateHostTaskReferences(entry.text, mapTeam) }
      : {}),
    ...('summary' in entry && typeof entry.summary === 'string'
      ? { summary: translateHostTaskReferences(entry.summary, mapTeam) }
      : {}),
    ...(entry.taskRefs
      ? {
          taskRefs: entry.taskRefs.map((ref) => ({
            ...ref,
            // Cross-team navigation needs a separately captured target. Never interpret a name as legacy authority.
            teamName: mapTeam(ref.teamName),
          })),
        }
      : {}),
  });
  return {
    ...snapshot,
    teamName: selection,
    kanbanState: { ...snapshot.kanbanState, teamName: selection },
    tasks: snapshot.tasks.map((task) => ({
      ...task,
      ...(task.description === undefined
        ? {}
        : { description: translateHostTaskReferences(task.description, mapTeam) }),
      ...(task.prompt === undefined
        ? {}
        : { prompt: translateHostTaskReferences(task.prompt, mapTeam) }),
      ...(task.promptTaskRefs
        ? { promptTaskRefs: refs({ taskRefs: task.promptTaskRefs }).taskRefs }
        : {}),
      ...(task.descriptionTaskRefs
        ? { descriptionTaskRefs: refs({ taskRefs: task.descriptionTaskRefs }).taskRefs }
        : {}),
      ...(task.comments ? { comments: task.comments.map(refs) } : {}),
      ...(task.sourceMessage
        ? {
            sourceMessage: {
              ...task.sourceMessage,
              text: translateHostTaskReferences(task.sourceMessage.text, mapTeam),
            },
          }
        : {}),
    })),
    messages: remapHostCrossTeamMessages(snapshot.messages, snapshot.teamName, selection, bindings),
  };
}
function view(
  snapshot: BackendTeamSnapshot,
  connection: Connection,
  alive?: boolean
): TeamViewSnapshot {
  return {
    teamName: snapshot.teamName,
    config: {
      name: connection.label,
      ...(snapshot.lifecycle?.deletedAt ? { deletedAt: snapshot.lifecycle.deletedAt } : {}),
      members: snapshot.members.map((member) => ({
        ...member,
        agentType: member.role === 'lead' ? 'team-lead' : 'general-purpose',
      })),
    },
    tasks: snapshot.tasks,
    members: snapshot.members.map((member) => ({
      ...member,
      runtimeOwner: 'captured-host',
      agentType: member.role === 'lead' ? 'team-lead' : 'general-purpose',
      taskCount: snapshot.tasks.filter(
        (task) => task.owner === member.name && task.status !== 'deleted'
      ).length,
      currentTaskId:
        snapshot.tasks.find((task) => task.owner === member.name && task.status === 'in_progress')
          ?.id ?? null,
    })),
    kanbanState: snapshot.kanbanState,
    // Team snapshots contain product records only; no native/process/session state is inferred.
    processes: snapshot.processes ?? [],
    ...(alive === undefined ? {} : { isAlive: alive }),
    warnings: [
      ...(alive === undefined
        ? ['Host product snapshot: runtime processes, sessions and readiness are not included.']
        : []),
      ...(snapshot.lifecycle?.cleanupPending
        ? ['Team cleanup is pending. Runtime resources may still be held.']
        : []),
    ],
  };
}

/** Decorates ordinary Team reads while keeping legacy and captured Host authority disjoint. */
export function createHostTeamsApi(
  legacy: TeamsAPI,
  backend: AgentBackendApi,
  captureScope: () => CurrentScope = () => () => true,
  readOrder = new TeamProductReadOrder()
): TeamsAPI {
  const lifecycle = createHostTeamLifecycle(backend);
  const approvals = createHostToolApprovals({ backend, captureScope, readOrder });
  const provisioning = createHostTeamProvisioning(backend, captureScope, readOrder);
  const getMemberSpawnStatuses = createHostMemberSpawnStatuses(backend, captureScope, readOrder);
  const changes = createHostTeamChanges({
    backend,
    captureScope,
    selectionKey: hostTeamSelectionKey,
    readOrder,
  });
  async function connections(check: CurrentScope): Promise<Connection[]> {
    const state = await backend.getConnections();
    current(check);
    if (state.state !== 'ready' && state.state !== 'unconfigured')
      throw new Error('Host teams unavailable');
    return state.bindings;
  }
  async function snapshot(
    connection: Connection,
    check: CurrentScope
  ): Promise<{ data: BackendTeamSnapshot; assertCurrent(): void }> {
    readOrder.capture(check);
    const readFence = readOrder.readFence(connection.handle.handleId);
    // Reads use a fresh transport correlation ID, never a mutation receipt or replay.
    const result = await backend.invoke({
      handle: connection.handle,
      commandId: crypto.randomUUID(),
      operation: 'team.snapshot',
      payload: {},
    });
    current(check);
    if (!result.ok) throw new Error(`Host team read ${result.code}`);
    if (!result.value || !('revision' in result.value) || !('kanbanState' in result.value))
      throw new Error('Invalid Host team snapshot');
    const value = result.value;
    readFence();
    readOrder.acceptSnapshot(connection.handle.handleId, value);
    return {
      data: value,
      assertCurrent: () => {
        current(check);
        readFence();
        readOrder.assertCurrent(connection.handle.handleId, value.feed);
      },
    };
  }
  async function resolveConnection(
    key: string,
    check: CurrentScope,
    captured?: Connection[]
  ): Promise<Connection> {
    const rows = captured ?? (await connections(check));
    current(check);
    const connection = rows.find(
      (binding) => hostTeamSelectionKey(binding.handle.handleId) === key
    );
    if (!connection) throw new Error('Host team unavailable');
    return connection;
  }
  async function selected(key: string, check: CurrentScope) {
    const bindings = await connections(check);
    const connection = await resolveConnection(key, check, bindings);
    const observed = await snapshot(connection, check);
    return {
      connection,
      snapshot: remapSnapshot(observed.data, key, bindings),
      canonicalTeamName: observed.data.teamName,
      remapTasks: (tasks: TeamTaskWithKanban[]) =>
        remapSnapshot({ ...observed.data, tasks }, key, bindings).tasks,
      assertCurrent: observed.assertCurrent,
    };
  }
  async function list() {
    const check = captureScope();
    const [oldTeams, bindings] = await Promise.all([legacy.list(), connections(check)]);
    const observed: (() => void)[] = [];
    const hostTeams = [];
    // Read one captured Team at a time to leave the finite Host control lane available.
    for (const binding of bindings) {
      const read = await snapshot(binding, check);
      const data = remapSnapshot(
        read.data,
        hostTeamSelectionKey(binding.handle.handleId),
        bindings
      );
      read.assertCurrent();
      let description = '',
        displayName = binding.label,
        color: string | undefined;
      try {
        const configuration = await readHostRosterConfiguration(backend, binding.handle);
        assertMatchingConfiguration(data, configuration);
        description = configuration.savedSettings?.description ?? '';
        displayName = configuration.savedSettings?.displayName ?? binding.label;
        color = configuration.savedSettings?.color;
      } catch {
        // Unavailable saved settings leave ordinary product records readable.
      }
      observed.push(read.assertCurrent);
      hostTeams.push({
        teamName: data.teamName,
        ...(data.lifecycle?.deletedAt ? { deletedAt: data.lifecycle.deletedAt } : {}),
        displayName,
        description,
        ...(color === undefined ? {} : { color }),
        memberCount: data.members.filter((member) => member.role === 'member').length,
        members: data.members,
        ...(data.members.find((member) => member.role === 'lead')
          ? {
              leadName: data.members.find((member) => member.role === 'lead')!.name,
            }
          : {}),
        taskCount: data.tasks.filter((task) => task.status !== 'deleted').length,
        lastActivity: data.messages.reduce<string | null>(
          (latest, message) =>
            latest === null || message.timestamp > latest ? message.timestamp : latest,
          null
        ),
      });
    }
    current(check);
    for (const assertCurrent of observed) assertCurrent();
    // Reserved keys cannot be treated as real legacy filesystem team names.
    return [...oldTeams.filter((team) => !isHostTeamSelectionKey(team.teamName)), ...hostTeams];
  }
  async function getAllTasks() {
    const check = captureScope();
    const [oldTasks, bindings] = await Promise.all([legacy.getAllTasks(), connections(check)]);
    const observed: (() => void)[] = [];
    const hostTasks = [];
    for (const binding of bindings) {
      const read = await snapshot(binding, check);
      const data = remapSnapshot(
        read.data,
        hostTeamSelectionKey(binding.handle.handleId),
        bindings
      );
      observed.push(read.assertCurrent);
      let displayName = binding.label;
      try {
        const configuration = await readHostRosterConfiguration(backend, binding.handle);
        assertMatchingConfiguration(data, configuration);
        displayName = configuration.savedSettings?.displayName ?? binding.label;
      } catch {
        // Product tasks remain readable while their saved presentation is unavailable.
      }
      hostTasks.push(
        data.tasks.map((task) => ({
          ...task,
          teamName: data.teamName,
          teamDisplayName: displayName,
        }))
      );
    }
    current(check);
    for (const assertCurrent of observed) assertCurrent();
    return [
      ...oldTasks.filter((task) => !isHostTeamSelectionKey(task.teamName)),
      ...hostTasks.flat(),
    ];
  }
  const reads = {
    ...createHostTaskReads(backend, (key) => selected(key, captureScope())),
    async getSavedRequest(key: string) {
      const check = captureScope();
      const connection = await resolveConnection(key, check);
      readOrder.capture(check);
      const readFence = readOrder.readFence(connection.handle.handleId);
      const configuration = await readHostRosterConfiguration(backend, connection.handle);
      current(check);
      readFence();
      return projectHostSavedTeamRequest(key, configuration);
    },
    async getData(key: string) {
      const check = captureScope();
      const { connection, snapshot, assertCurrent } = await selected(key, check);
      const state = await lifecycle.read(connection, check);
      current(check);
      assertCurrent();
      const processes = await backend.invoke({
        handle: connection.handle,
        commandId: crypto.randomUUID(),
        operation: 'process.list',
        payload: {},
      });
      current(check);
      assertCurrent();
      if (!processes.ok) throw new Error(`Host process read ${processes.code}`);
      const result = view(
        { ...snapshot, processes: readBackendProcesses(processes.value) },
        connection,
        state === null && snapshot.runtimeNeverLaunched && !snapshot.lifecycle?.cleanupPending
          ? false
          : state?.alive
      );
      try {
        const configuration = await readHostRosterConfiguration(backend, connection.handle);
        assertMatchingConfiguration(snapshot, configuration);
        const saved = projectHostSavedTeamRequest(key, configuration);
        const visibleNames = new Set(snapshot.members.map((member) => member.name.toLowerCase()));
        for (const member of configuration.removedMembers) {
          const name = member.name.toLowerCase();
          if (visibleNames.has(name)) throw new Error('Removed team member name conflict');
          visibleNames.add(name);
        }
        const configuredMembers = [
          ...configuration.members,
          ...configuration.removedMembers.map((member) => ({
            ...member,
            role: 'member' as const,
            settingsFingerprint: undefined,
          })),
        ];
        const settings = configuredMembers.map((member) => ({
          ...member.settings,
          name: member.name,
          configuredSettingsFingerprint: member.settingsFingerprint,
          ...(member.role === 'lead' && saved
            ? {
                cwd: saved.cwd,
                providerId: saved.providerId,
                model: saved.model,
                effort: saved.effort,
                fastMode: saved.fastMode,
                providerBackendId: saved.providerBackendId,
              }
            : {}),
        }));
        const withSettings = <T extends { name: string }>(member: T): T => {
          const configured = settings.find((selected) => selected.name === member.name)!;
          return {
            ...member,
            ...configured,
            selectedFastMode: configured.fastMode,
            configuredRuntimeSettings: {
              providerId: configured.providerId,
              providerBackendId: configured.providerBackendId,
              model: configured.model,
              effort: configured.effort,
              fastMode: configured.fastMode,
            },
          };
        };
        result.config = { ...result.config, members: result.config.members?.map(withSettings) };
        result.members = [
          ...result.members,
          ...configuration.removedMembers.map((member) => ({
            name: member.name,
            runtimeOwner: 'captured-host' as const,
            role: 'member',
            agentType: 'general-purpose',
            removedAt: Date.parse(member.removedAt),
            taskCount: snapshot.tasks.filter(
              (task) => task.owner === member.name && task.status !== 'deleted'
            ).length,
            currentTaskId: null,
          })),
        ].map(withSettings);
        result.members = projectHostMemberAttachmentCapabilities(
          result.members,
          configuration,
          state
        );
        if (saved) {
          result.config = {
            ...result.config,
            projectPath: saved.cwd,
            ...(saved.displayName === undefined ? {} : { name: saved.displayName }),
            ...(saved.description === undefined ? {} : { description: saved.description }),
            ...(saved.color === undefined ? {} : { color: saved.color }),
          };
        }
      } catch {
        // Product records remain readable; unavailable selected settings are not
        // reconstructed from a legacy file or current global defaults.
        result.warnings = [...(result.warnings ?? []), 'Saved launch settings are unavailable.'];
      }
      current(check);
      assertCurrent();
      if (state?.unknownMembers.length)
        result.warnings = [
          ...(result.warnings ?? []),
          'Some team members have unavailable runtime state.',
        ];
      return result;
    },
    async processAlive(key: string) {
      const check = captureScope();
      const connection = await resolveConnection(key, check);
      readOrder.capture(check);
      const readFence = readOrder.readFence(connection.handle.handleId);
      const state = await lifecycle.read(connection, check);
      readFence();
      if (!state) {
        const observed = await snapshot(connection, check);
        observed.assertCurrent();
        readFence();
        if (observed.data.runtimeNeverLaunched && !observed.data.lifecycle?.cleanupPending)
          return false;
      }
      if (!state || state.alive === undefined)
        throw new Error('Host team runtime state unavailable');
      return state.alive;
    },
    async stop(key: string) {
      const check = captureScope();
      const connection = await resolveConnection(key, check);
      readOrder.capture(check);
      readOrder.invalidateReads(connection.handle.handleId);
      try {
        await lifecycle.stop(connection, check);
      } finally {
        if (check()) readOrder.invalidateReads(connection.handle.handleId);
      }
    },
    async getMessagesPage(
      key: string,
      options?: { cursor?: string | null; limit?: number; groupChatId?: string }
    ) {
      const { snapshot, assertCurrent } = await selected(key, captureScope());
      assertCurrent();
      // A changed product revision invalidates older offsets instead of skipping/duplicating rows silently.
      const scope =
        options?.groupChatId === undefined
          ? snapshot.revision
          : `${snapshot.revision}.${options.groupChatId}`;
      const parts = options?.cursor?.split(':') ?? [scope, '0'];
      if (parts.length !== 2) throw new Error('Invalid Host messages cursor');
      const [revision, offsetText] = parts;
      const offset = Number(offsetText);
      if (revision !== scope || !Number.isSafeInteger(offset) || offset < 0)
        throw new Error('Host messages cursor expired');
      const limit = options?.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new Error('Invalid Host messages page');
      const unique = new Map<string, InboxMessage>();
      for (const message of snapshot.messages) {
        if (
          options?.groupChatId !== undefined &&
          (message.groupChatId !== options.groupChatId ||
            message.messageId !== message.groupMessageId)
        )
          continue;
        unique.set(message.messageId ?? JSON.stringify(message), message);
      }
      const messages = [...unique.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const end = Math.max(0, messages.length - offset);
      const start = Math.max(0, end - limit);
      return {
        messages: messages.slice(start, end),
        nextCursor: start > 0 ? `${scope}:${offset + limit}` : null,
        hasMore: start > 0,
        feedRevision: snapshot.revision,
      };
    },
  };
  const mutations = createHostTeamMutations({
    backend,
    captureScope,
    invalidateReads: (handle) => readOrder.invalidateReads(handle.handleId),
    async resolve(key, check, referenceTeams) {
      const bindings = await connections(check);
      const connection = await resolveConnection(key, check, bindings);
      if (referenceTeams?.some((team) => !storeHostTaskReferenceTeam(team, '', key, bindings)))
        throw new HostTeamOperationError('unsupported', 'not-dispatched');
      const read = await snapshot(connection, check);
      read.assertCurrent();
      return {
        handle: { ...connection.handle },
        teamName: read.data.teamName,
        referenceBindings: bindings,
      };
    },
  });
  const roster = createHostTeamRoster({
    backend,
    captureScope,
    resolve: (key, check) => {
      readOrder.capture(check);
      return resolveConnection(key, check);
    },
    invalidateReads: (handle) => readOrder.invalidateReads(handle.handleId),
  });
  const productLifecycleOptions = {
    backend,
    captureScope,
    resolve: (key: string, check: CurrentScope) => {
      readOrder.capture(check);
      return resolveConnection(key, check);
    },
    invalidateReads: (handle: import('../contracts').BackendHandle) =>
      readOrder.invalidateReads(handle.handleId),
  };
  const productLifecycle = createHostProductLifecycleApi(productLifecycleOptions);
  const savedMembers = createHostSavedMemberMutations(productLifecycleOptions);
  const attachmentOptions = {
    backend,
    captureScope,
    async resolve(key: string, check: CurrentScope) {
      const connection = await resolveConnection(key, check);
      readOrder.capture(check);
      const fence = readOrder.readFence(connection.handle.handleId);
      return {
        handle: connection.handle,
        assertCurrent: () => {
          current(check);
          fence();
        },
      };
    },
  };
  const getTaskAttachment = createHostTaskAttachmentRead(attachmentOptions);
  const getAttachments = createHostMessageAttachmentRead(attachmentOptions);
  const activityReadOptions: HostActivityReadOptions = {
    backend,
    captureScope,
    async resolve(key, check) {
      const connection = await resolveConnection(key, check);
      readOrder.capture(check);
      const fence = readOrder.readFence(connection.handle.handleId);
      return {
        handle: connection.handle,
        assertCurrent: () => {
          current(check);
          fence();
        },
      };
    },
  };
  const logStats = createHostLogStatsApi(activityReadOptions);
  const lead = createHostLeadApi(activityReadOptions);
  const taskActivity = createHostTaskActivityApi(activityReadOptions);
  const killProcess = createHostProcessControls({
    backend,
    captureScope,
    invalidateReads: (handleId) => readOrder.invalidateReads(handleId),
    async resolve(key, check) {
      const connection = await resolveConnection(key, check);
      return { handle: connection.handle, assertCurrent: () => current(check) };
    },
  });
  const memberActions = createHostMemberActions({
    backend,
    captureScope,
    resolve: async (key, check) => {
      const connection = await resolveConnection(key, check);
      return { handle: connection.handle, assertCurrent: () => current(check) };
    },
    invalidateReads: (handleId) => readOrder.invalidateReads(handleId),
  });
  const supported = {
    getMemberSpawnStatuses,
    ...memberActions,
    async showMessageNotification(raw: Parameters<TeamsAPI['showMessageNotification']>[0]) {
      const data = captureHostNotification(raw),
        check = captureScope();
      current(check);
      // Reuse the Desktop notification transport; Main validates the captured Host destination.
      await legacy.showMessageNotification.call(legacy, data);
      current(check);
    },
    killProcess,
    ...reads,
    ...mutations,
    ...roster,
    ...productLifecycle,
    ...savedMembers,
    ...logStats,
    ...lead,
    ...taskActivity,
    getTaskAttachment,
    getAttachments,
  };
  const launchTeam = createHostTeamLaunchSubmission({
    backend,
    captureScope,
    invalidateReads: (handleId, check) => {
      readOrder.capture(check);
      readOrder.invalidateReads(handleId);
    },
  });
  const creation = createTeamCreationResultApi(legacy);
  // contextBridge freezes its API properties; decorate a mutable copy while keeping the original receiver.
  return new Proxy(
    { ...legacy },
    {
      get(_target, property) {
        if (property === 'createTeam' || property === 'createConfig') return creation[property];
        if (property === 'updateToolApprovalSettings')
          return (...args: Parameters<TeamsAPI['updateToolApprovalSettings']>) =>
            isHostTeamSelectionKey(args[0])
              ? approvals.updateSettings(...args)
              : legacy.updateToolApprovalSettings(...args);
        if (property === 'readFileForToolApproval')
          return (...args: Parameters<TeamsAPI['readFileForToolApproval']>) => {
            const scope = args[1];
            if (
              scope &&
              (isHostTeamSelectionKey(scope.teamName) || approvals.isHostRequestId(scope.requestId))
            )
              return approvals.readPreview(args[0], scope);
            if (!scope && approvals.isPendingPreviewPath(args[0]))
              return Promise.reject(
                new HostTeamOperationError('captured-interaction-required', 'not-dispatched')
              );
            return legacy.readFileForToolApproval(args[0]);
          };
        if (property === 'onToolApprovalEvent')
          return (callback: Parameters<TeamsAPI['onToolApprovalEvent']>[0]) => {
            const stopHost = approvals.subscribe(callback);
            let stopLegacy: (() => void) | undefined;
            try {
              stopLegacy = legacy.onToolApprovalEvent?.call(legacy, (event, request) => {
                if (!isHostTeamSelectionKey(request.teamName)) callback(event, request);
              });
            } catch (error) {
              stopHost();
              throw error;
            }
            return () => {
              stopHost();
              stopLegacy?.();
            };
          };
        if (property === 'respondToToolApproval')
          return (...args: Parameters<TeamsAPI['respondToToolApproval']>) =>
            isHostTeamSelectionKey(args[0]) || approvals.isHostRequestId(args[2])
              ? approvals.respond(...args)
              : legacy.respondToToolApproval(...args);
        if (property === 'onProvisioningProgress')
          return (callback: Parameters<TeamsAPI['onProvisioningProgress']>[0]) => {
            const stopHost = changes.subscribeProgress(callback);
            let stopLegacy: (() => void) | undefined;
            try {
              stopLegacy = legacy.onProvisioningProgress?.call(legacy, (event, progress) => {
                if (!isHostTeamSelectionKey(progress.teamName) && !isHostTeamRunId(progress.runId))
                  callback(event, progress);
              });
            } catch (error) {
              stopHost();
              throw error;
            }
            return () => {
              stopHost();
              stopLegacy?.();
            };
          };
        if (property === 'onTeamChange')
          return (callback: Parameters<TeamsAPI['onTeamChange']>[0]) => {
            const stopHost = changes.subscribe(callback);
            let stopLegacy: (() => void) | undefined;
            try {
              stopLegacy = legacy.onTeamChange?.call(legacy, (event, change) => {
                if (!isHostTeamSelectionKey(change.teamName)) callback(event, change);
              });
            } catch (error) {
              stopHost();
              throw error;
            }
            return () => {
              stopHost();
              stopLegacy?.();
            };
          };
        if (property === 'list') return list;
        if (property === 'getAllTasks') return getAllTasks;
        if (property === 'aliveList')
          return async () => {
            const check = captureScope();
            const [legacyAlive, bindings] = await Promise.all([
              legacy.aliveList(),
              connections(check),
            ]);
            const state = [];
            for (const connection of bindings) {
              readOrder.capture(check);
              const assertCurrent = readOrder.readFence(connection.handle.handleId);
              const runtimeState = await lifecycle.read(connection, check);
              state.push({ connection, state: runtimeState, assertCurrent });
            }
            current(check);
            for (const entry of state) entry.assertCurrent();
            if (state.some((entry) => entry.state && entry.state.alive === undefined))
              throw new Error('Host team runtime state unavailable');
            return [
              ...legacyAlive.filter((name) => !isHostTeamSelectionKey(name)),
              ...state
                .filter((entry) => entry.state?.alive)
                .map((entry) => hostTeamSelectionKey(entry.connection.handle.handleId)),
            ];
          };
        const original = Reflect.get(legacy, property) as unknown;
        if (typeof original !== 'function') return original;
        return (...args: unknown[]) => {
          if (isHostTeamRunId(args[0])) {
            if (property === 'getProvisioningStatus')
              return provisioning.getProvisioningStatus(args[0]);
            if (property === 'cancelProvisioning') return provisioning.cancelProvisioning(args[0]);
          }
          if (!hasHostTeamDestination(property, args[0]))
            return Reflect.apply(original, legacy, args);
          if (property === 'launchTeam')
            return launchTeam(args[0] as Parameters<TeamsAPI['launchTeam']>[0]);
          if (property === 'showMessageNotification')
            return supported.showMessageNotification(
              args[0] as Parameters<TeamsAPI['showMessageNotification']>[0]
            );
          if (isHostTeamSelectionKey(args[0]) && Object.hasOwn(supported, property))
            return Reflect.apply(
              Reflect.get(supported, property) as (...args: unknown[]) => unknown,
              supported,
              args
            );
          return Promise.reject(new Error('This operation is not supported for Host teams'));
        };
      },
    }
  );
}
