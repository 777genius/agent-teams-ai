import { useStore } from '@renderer/store';
import { isTeamProvisioningActive, selectTeamDataForName } from '@renderer/store/slices/teamSlice';

import { createDesktopTaskInteraction } from '../../components/team/createDesktopTaskInteraction';

import { createTeamTaskDetailTransport } from './createTeamTaskDetailTransport';

import type { CreateTaskInteractionController } from '@features/team-task-board';
import type { CreateTaskRequest } from '@shared/types';

type DesktopCreateSession = CreateTaskInteractionController<CreateTaskRequest>;

interface SessionEntry {
  readonly contextId: string;
  readonly scope: { key: string; authorityEpoch: string };
  readonly interaction: DesktopCreateSession;
}

interface PendingNotification {
  readonly contextId: string;
  readonly teamName: string;
  readonly request: CreateTaskRequest;
}

const sessions = new Map<string, SessionEntry>();
const pendingNotifications = new Map<string, PendingNotification>();
const notification = createTeamTaskDetailTransport();
let authorityEpoch = 0;
let unsubscribeStore: (() => void) | null = null;

function sessionKey(contextId: string, teamName: string): string {
  return JSON.stringify([contextId, teamName, authorityEpoch]);
}

function contextAvailable(contextId: string): boolean {
  const state = useStore.getState();
  return state.activeContextId === contextId && !state.isContextSwitching;
}

function deliverNotification(intentKey: string, pending: PendingNotification): void {
  if (!contextAvailable(pending.contextId)) return;
  // Mark the local output consumed before awaiting its best-effort delivery.
  pendingNotifications.delete(intentKey);
  const state = useStore.getState();
  const team = selectTeamDataForName(state, pending.teamName);
  const { owner, prompt, startImmediately, subject } = pending.request;
  if (
    !prompt ||
    !owner ||
    startImmediately === false ||
    !team?.isAlive ||
    isTeamProvisioningActive(state, pending.teamName)
  )
    return;
  const message = `New task assigned to ${owner}: "${subject}". Instructions:\n${prompt}`;
  void notification.notifyTaskLead(pending.teamName, message).catch(() => undefined);
}

function syncSessionsWithContext(): void {
  for (const { contextId, scope, interaction } of sessions.values()) {
    const available = contextAvailable(contextId);
    if (interaction.getSnapshot().availability.available !== available) {
      interaction.setAvailability(scope, { supported: true, available });
    }
  }
  for (const [intentKey, pending] of pendingNotifications) {
    deliverNotification(intentKey, pending);
  }
}

function ensureStoreSubscription(): void {
  unsubscribeStore ??= useStore.subscribe(syncSessionsWithContext);
}

/** Desktop composition owns a session beyond either Detail or Graph view lifetime. */
export function getDesktopCreateTaskInteraction(
  teamName: string,
  contextId: string
): DesktopCreateSession {
  ensureStoreSubscription();
  const key = sessionKey(contextId, teamName);
  const existing = sessions.get(key);
  if (existing) return existing.interaction;

  const scope = { key, authorityEpoch: String(authorityEpoch) };

  const interaction = createDesktopTaskInteraction(scope, {
    teamName,
    readAvailability: () => ({ supported: true, available: contextAvailable(contextId) }),
    createTask: (name, request) => {
      if (!contextAvailable(contextId)) throw new Error('desktop_create_context_unavailable');
      return useStore.getState().createTeamTask(name, request);
    },
    refreshCreatedTask: async (name, taskId) => {
      if (!contextAvailable(contextId)) throw new Error('desktop_create_context_unavailable');
      let foundInAuthoritativeRead = false;
      await useStore.getState().refreshTeamData(name, {
        requireFreshRead: true,
        onFreshSnapshot: (snapshot) => {
          foundInAuthoritativeRead = snapshot.tasks.some((task) => task.id === taskId);
        },
      });
      if (!contextAvailable(contextId)) throw new Error('desktop_create_context_unavailable');
      if (!foundInAuthoritativeRead) {
        throw new Error('desktop_created_task_refresh_unconfirmed');
      }
    },
    onConfirmed: (intentId, request) => {
      if (!request.prompt || !request.owner || request.startImmediately === false) return;
      const intentKey = JSON.stringify([key, intentId]);
      const pending = { contextId, teamName, request };
      pendingNotifications.set(intentKey, pending);
      deliverNotification(intentKey, pending);
    },
  });
  sessions.set(key, { contextId, scope, interaction });
  return interaction;
}

/** Call only on a confirmed Desktop authority reset, never on a view unmount or context switch. */
export function resetDesktopCreateTaskSessions(): void {
  for (const { interaction } of sessions.values()) interaction.dispose();
  sessions.clear();
  pendingNotifications.clear();
  unsubscribeStore?.();
  unsubscribeStore = null;
  authorityEpoch += 1;
}
