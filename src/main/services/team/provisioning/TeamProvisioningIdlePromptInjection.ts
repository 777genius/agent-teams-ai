import type { LeadActivityState } from './TeamProvisioningLeadActivity';
import type { TeamCreateRequest, TeamTask } from '@shared/types';

export interface TeamProvisioningIdlePromptInjectionRun {
  teamName: string;
  request: TeamCreateRequest;
  effectiveMembers: TeamCreateRequest['members'];
  memberSpawnStatuses: ReadonlyMap<string, unknown>;
  child: { stdin?: { writable?: boolean } | null } | null | undefined;
  processKilled: boolean;
  cancelRequested: boolean;
  leadActivityState: LeadActivityState;
  leadRelayCapture: unknown;
  silentUserDmForward: unknown;
  pendingPostCompactReminder: boolean;
  postCompactReminderInFlight: boolean;
  suppressPostCompactReminderOutput: boolean;
  pendingGeminiPostLaunchHydration: boolean;
  geminiPostLaunchHydrationInFlight: boolean;
  geminiPostLaunchHydrationSent: boolean;
  suppressGeminiPostLaunchHydrationOutput: boolean;
}

export interface TeamProvisioningIdlePromptInjectionConfigMember {
  name?: string;
  role?: string | null;
}

export interface TeamProvisioningIdlePromptInjectionConfig {
  members?: TeamProvisioningIdlePromptInjectionConfigMember[];
}

export interface TeamProvisioningIdlePromptInjectionLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface TeamProvisioningIdlePromptInjectionPorts<
  TRun extends TeamProvisioningIdlePromptInjectionRun,
> {
  logger: TeamProvisioningIdlePromptInjectionLogger;
  readConfigForObservation(
    teamName: string
  ): Promise<TeamProvisioningIdlePromptInjectionConfig | null | undefined>;
  readTasks(teamName: string): Promise<TeamTask[]>;
  isLeadMember(member: TeamProvisioningIdlePromptInjectionConfigMember): boolean;
  buildPersistentLeadContext(options: {
    teamName: string;
    leadName: string;
    isSolo: boolean;
    members: TeamCreateRequest['members'];
    compact?: boolean;
  }): string;
  buildTaskBoardSnapshot(tasks: TeamTask[]): string;
  buildGeminiPostLaunchHydrationPrompt(
    run: TRun,
    leadName: string,
    members: TeamCreateRequest['members'],
    tasks: TeamTask[]
  ): string;
  getPromptSizeSummary(prompt: string): { chars: number; lines: number };
  writeLeadStdin(run: TRun, payload: string): Promise<void>;
  setLeadActivity(run: TRun, state: LeadActivityState): void;
  resetRuntimeToolActivity(run: TRun, memberName: string): void;
  getRunLeadName(run: TRun): string;
}

function clearPostCompactReminderState(run: TeamProvisioningIdlePromptInjectionRun): void {
  run.pendingPostCompactReminder = false;
  run.postCompactReminderInFlight = false;
  run.suppressPostCompactReminderOutput = false;
}

function buildUserPayload(message: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: message }],
    },
  });
}

function getLaunchLeadName(members: TeamCreateRequest['members']): string {
  return members.find((m) => m.role?.toLowerCase().includes('lead'))?.name || 'team-lead';
}

export async function injectPostCompactReminder<
  TRun extends TeamProvisioningIdlePromptInjectionRun,
>(run: TRun, ports: TeamProvisioningIdlePromptInjectionPorts<TRun>): Promise<void> {
  // Consume the pending flag immediately — strict one-shot policy.
  run.pendingPostCompactReminder = false;

  // Guard: process must be alive and writable.
  if (!run.child?.stdin?.writable || run.processKilled || run.cancelRequested) {
    ports.logger.warn(
      `[${run.teamName}] post-compact reminder skipped — process not writable or killed`
    );
    return;
  }

  // Guard: don't inject if another turn is actively processing (race with user send / inbox relay).
  if (run.leadActivityState !== 'idle') {
    ports.logger.info(
      `[${run.teamName}] post-compact reminder deferred — lead is ${run.leadActivityState}, not idle`
    );
    // Re-arm so it triggers on next idle.
    run.pendingPostCompactReminder = true;
    return;
  }

  // Guard: don't inject while a relay capture is in-flight.
  if (run.leadRelayCapture) {
    ports.logger.info(`[${run.teamName}] post-compact reminder deferred — relay capture in-flight`);
    run.pendingPostCompactReminder = true;
    return;
  }

  // Guard: don't inject while a silent DM forward is in progress.
  if (run.silentUserDmForward) {
    ports.logger.info(
      `[${run.teamName}] post-compact reminder deferred — silent DM forward in progress`
    );
    run.pendingPostCompactReminder = true;
    return;
  }

  // Read current team config for up-to-date members (may have changed since launch).
  let currentMembers: TeamCreateRequest['members'] = run.request.members;
  let leadName = 'team-lead';
  try {
    const config = await ports.readConfigForObservation(run.teamName);
    if (config?.members) {
      const configLead = config.members.find((m) => ports.isLeadMember(m));
      leadName = configLead?.name?.trim() || 'team-lead';
      // Convert config members (excluding lead) to TeamCreateRequest member format.
      const configTeammates = config.members
        .filter((m) => !ports.isLeadMember(m) && m?.name)
        .map((m) => ({
          name: m.name!,
          role: m.role ?? undefined,
        }));
      // When config.members only has the lead (pre-created config without
      // TeamCreate), fall back to run.request.members for the teammate list.
      if (configTeammates.length > 0) {
        currentMembers = configTeammates;
      }
    } else {
      leadName = getLaunchLeadName(run.request.members);
    }
  } catch {
    // Fallback to launch-time members if config is unavailable.
    leadName = getLaunchLeadName(run.request.members);
    ports.logger.warn(
      `[${run.teamName}] post-compact reminder: config unavailable, using launch-time members`
    );
  }
  const isSolo = currentMembers.length === 0;

  // Build persistent lead context.
  const persistentContext = ports.buildPersistentLeadContext({
    teamName: run.teamName,
    leadName,
    isSolo,
    members: currentMembers,
    compact: true,
  });

  // Best-effort: fetch fresh task board snapshot.
  let taskBoardBlock = '';
  try {
    const tasks = await ports.readTasks(run.teamName);
    taskBoardBlock = ports.buildTaskBoardSnapshot(tasks);
  } catch {
    // If tasks can't be read, inject without the snapshot.
    ports.logger.warn(`[${run.teamName}] post-compact reminder: task board snapshot unavailable`);
  }

  // Re-check guards after async work.
  if (!run.child?.stdin?.writable || run.processKilled || run.cancelRequested) {
    ports.logger.warn(
      `[${run.teamName}] post-compact reminder aborted — process state changed during preparation`
    );
    return;
  }
  if (run.leadActivityState !== 'idle') {
    ports.logger.info(
      `[${run.teamName}] post-compact reminder deferred — lead activity changed to ${run.leadActivityState as string}`
    );
    // Re-arm so it triggers on next idle.
    run.pendingPostCompactReminder = true;
    return;
  }

  const message = [
    `Apply these standing rules and current team state before responding:`,
    ``,
    `You are "${leadName}", the team lead of team "${run.teamName}".`,
    `You are running in a non-interactive CLI session. Do not ask questions.`,
    `CRITICAL: Execute ALL steps directly yourself in sequence. Do NOT delegate any step to a sub-agent via the Agent tool. The ONLY valid use of the Agent tool is spawning individual teammates.`,
    ``,
    persistentContext,
    taskBoardBlock.trim() ? `\n${taskBoardBlock}` : '',
    ``,
    `Do NOT start new work or execute tasks in this turn. Reply with one concise user-facing team status line about board readiness and teammate availability. Only report board readiness and teammate availability.`,
  ]
    .filter(Boolean)
    .join('\n');

  const payload = buildUserPayload(message);

  run.postCompactReminderInFlight = true;
  run.suppressPostCompactReminderOutput = true;
  ports.setLeadActivity(run, 'active');

  try {
    await ports.writeLeadStdin(run, payload);
    ports.logger.info(`[${run.teamName}] post-compact reminder injected`);
  } catch (error) {
    // Strict drop-after-attempt — do not re-arm.
    clearPostCompactReminderState(run);
    ports.resetRuntimeToolActivity(run, ports.getRunLeadName(run));
    ports.setLeadActivity(run, 'idle');
    ports.logger.warn(
      `[${run.teamName}] post-compact reminder injection failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function injectGeminiPostLaunchHydration<
  TRun extends TeamProvisioningIdlePromptInjectionRun,
>(run: TRun, ports: TeamProvisioningIdlePromptInjectionPorts<TRun>): Promise<void> {
  run.pendingGeminiPostLaunchHydration = false;

  if (
    run.geminiPostLaunchHydrationSent ||
    !run.child?.stdin?.writable ||
    run.processKilled ||
    run.cancelRequested
  ) {
    ports.logger.warn(
      `[${run.teamName}] Gemini post-launch hydration skipped — process not writable, killed, or already sent`
    );
    return;
  }

  if (run.leadActivityState !== 'idle') {
    ports.logger.info(
      `[${run.teamName}] Gemini post-launch hydration deferred — lead is ${run.leadActivityState}, not idle`
    );
    run.pendingGeminiPostLaunchHydration = true;
    return;
  }

  if (run.leadRelayCapture) {
    ports.logger.info(
      `[${run.teamName}] Gemini post-launch hydration deferred — relay capture in-flight`
    );
    run.pendingGeminiPostLaunchHydration = true;
    return;
  }

  if (run.silentUserDmForward) {
    ports.logger.info(
      `[${run.teamName}] Gemini post-launch hydration deferred — silent DM forward in progress`
    );
    run.pendingGeminiPostLaunchHydration = true;
    return;
  }

  let currentMembers: TeamCreateRequest['members'] = run.effectiveMembers;
  let leadName = getLaunchLeadName(run.effectiveMembers);
  try {
    const config = await ports.readConfigForObservation(run.teamName);
    if (config?.members) {
      const configLead = config.members.find((m) => ports.isLeadMember(m));
      leadName = configLead?.name?.trim() || leadName;
      const configTeammates = config.members
        .filter((m) => !ports.isLeadMember(m) && m?.name)
        .map((m) => ({
          name: m.name!,
          role: m.role ?? undefined,
        }));
      if (configTeammates.length > 0) {
        const launchMembersByName = new Map(
          run.effectiveMembers.map((member) => [member.name, member] as const)
        );
        currentMembers = configTeammates.map((member) => ({
          ...launchMembersByName.get(member.name),
          ...member,
        }));
      }
    }
  } catch {
    ports.logger.warn(
      `[${run.teamName}] Gemini post-launch hydration: config unavailable, using launch-time members`
    );
  }

  let tasks: TeamTask[] = [];
  try {
    tasks = await ports.readTasks(run.teamName);
  } catch {
    ports.logger.warn(
      `[${run.teamName}] Gemini post-launch hydration: task board snapshot unavailable`
    );
  }

  if (
    run.geminiPostLaunchHydrationSent ||
    !run.child?.stdin?.writable ||
    run.processKilled ||
    run.cancelRequested
  ) {
    ports.logger.warn(
      `[${run.teamName}] Gemini post-launch hydration aborted — process state changed during preparation`
    );
    return;
  }
  if (run.leadActivityState !== 'idle') {
    ports.logger.info(
      `[${run.teamName}] Gemini post-launch hydration deferred — lead activity changed to ${run.leadActivityState as string}`
    );
    run.pendingGeminiPostLaunchHydration = true;
    return;
  }

  const message = ports.buildGeminiPostLaunchHydrationPrompt(run, leadName, currentMembers, tasks);
  const promptSize = ports.getPromptSizeSummary(message);
  ports.logger.info(
    `[${run.teamName}] Gemini post-launch hydration prepared (${promptSize.chars} chars / ${promptSize.lines} lines)`
  );

  const payload = buildUserPayload(message);

  run.geminiPostLaunchHydrationInFlight = true;
  run.geminiPostLaunchHydrationSent = true;
  run.suppressGeminiPostLaunchHydrationOutput = true;
  ports.setLeadActivity(run, 'active');

  try {
    await ports.writeLeadStdin(run, payload);
    ports.logger.info(`[${run.teamName}] Gemini post-launch hydration injected`);
  } catch (error) {
    run.geminiPostLaunchHydrationInFlight = false;
    run.geminiPostLaunchHydrationSent = false;
    run.suppressGeminiPostLaunchHydrationOutput = false;
    ports.resetRuntimeToolActivity(run, ports.getRunLeadName(run));
    ports.setLeadActivity(run, 'idle');
    ports.logger.warn(
      `[${run.teamName}] Gemini post-launch hydration injection failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
