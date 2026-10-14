import type { ElectronAPI } from '@shared/types/api';
import type { TeamCreateRequest, TeamProvisioningProgress } from '@shared/types/team';

/** Renderer adapter for the existing full-team scenario. The host driver must
 * first verify its owned Electron PID/CDP listener and isolated TEST profile.
 * This module does not launch Electron or establish that host ownership proof.
 * Importing it never submits work. All mutations are explicit and single-shot.
 */
export function electronTeamPort(api: ElectronAPI, teamName: string, projectPath: string) {
  if (!/^test-opencode-[a-zA-Z0-9-]+$/.test(teamName)) throw new Error('TEST team required');
  if (!projectPath || !/(?:^|[\\/])TEST-[^\\/]+(?:[\\/]|$)/.test(projectPath)) {
    throw new Error('TEST project required; host must also verify its opt-in marker');
  }
  const progress: TeamProvisioningProgress[] = [];
  let runId: string | undefined;
  let submitted = false;
  let createBoundary: 'not_submitted' | 'project_registration' | 'team_create' | 'created' =
    'not_submitted';
  let relaunchAttempted = false;
  let launchPending = false;
  const pendingProgress: TeamProvisioningProgress[] = [];
  const unsubscribe = api.teams.onProvisioningProgress((_event, value) => {
    if (value.teamName !== teamName) return;
    if (launchPending) pendingProgress.push(value);
    else if (!runId || value.runId === runId) progress.push(value);
  });
  const tasks = new Set<string>();
  let disposed = false;
  const check = () => {
    if (disposed) throw new Error('renderer port disposed');
  };
  const selectedTask = (id: string) => {
    check();
    if (!tasks.has(id)) throw new Error('task is not owned by this TEST scenario');
  };
  return {
    progress,
    async getStartupStatus() {
      check();
      if (!api.startup) throw new Error('Packaged startup API required');
      return api.startup.getStatus();
    },
    async getStartupCleanupState() {
      check();
      return (await api.startup.getOpenCodeCleanupStatus()).state;
    },
    async createTeam(request: TeamCreateRequest) {
      check();
      if (
        submitted ||
        request.teamName !== teamName ||
        request.cwd !== projectPath ||
        request.providerId !== 'opencode'
      )
        throw new Error('single owned OpenCode launch required');
      // Never repeat an uncertain createTeam after an IPC timeout.
      submitted = true;
      createBoundary = 'project_registration';
      await api.config.addCustomProjectPath(projectPath);
      createBoundary = 'team_create';
      const result = await api.teams.createTeam(request);
      runId = result.runId;
      createBoundary = 'created';
      return result;
    },
    async getSafeLaunchFailure() {
      check();
      const codes = [
        'workspace_trust_required',
        'transport_rejected',
        'stdin_missing',
        'provider_quota',
        'provider_auth',
        'opencode_runtime_readiness_timeout',
        'process_readiness_timeout',
        'opencode_protocol',
        'model_no_bootstrap',
        'process_exited',
        'unknown',
      ];
      if (createBoundary !== 'team_create') return { boundary: createBoundary };
      try {
        const diagnostics = await api.teams.getLaunchFailureDiagnostics(teamName, runId);
        return {
          boundary: createBoundary,
          classification:
            codes.find((code) => code === diagnostics.classification?.code) ?? 'unknown',
          bootstrapSubmitted: diagnostics.bootstrapTransportBreadcrumb?.bootstrapSubmitted === true,
          submitRejected: diagnostics.bootstrapTransportBreadcrumb?.submitRejected === true,
        };
      } catch {
        return { boundary: createBoundary, diagnosticsUnavailable: true };
      }
    },
    async createTask(request: Parameters<ElectronAPI['teams']['createTask']>[1]) {
      check();
      if (!runId) throw new Error('owned team launch required');
      const result = await api.teams.createTask(teamName, request);
      tasks.add(result.id);
      return result;
    },
    async startTask(id: string) {
      selectedTask(id);
      return api.teams.startTask(teamName, id);
    },
    async getTask(id: string) {
      selectedTask(id);
      return api.teams.getTask(teamName, id);
    },
    async getTaskLogStream(id: string) {
      selectedTask(id);
      return api.teams.getTaskLogStream(teamName, id);
    },
    async updateTaskOwner(id: string, owner: string | null) {
      selectedTask(id);
      return api.teams.updateTaskOwner(teamName, id, owner);
    },
    async getProvisioningStatus() {
      check();
      if (!runId) throw new Error('owned launch required');
      return api.teams.getProvisioningStatus(runId);
    },
    async getRuntime() {
      check();
      return api.teams.getTeamAgentRuntime(teamName);
    },
    async getData() {
      check();
      const data = await api.teams.getData(teamName);
      // Persisted tasks remain within this same private TEST team after restart.
      for (const task of data.tasks) tasks.add(task.id);
      return data;
    },
    async getMessagesPage(request: Parameters<ElectronAPI['teams']['getMessagesPage']>[1]) {
      check();
      return api.teams.getMessagesPage(teamName, request);
    },
    async sendMessage(request: Parameters<ElectronAPI['teams']['sendMessage']>[1]) {
      check();
      return api.teams.sendMessage(teamName, request);
    },
    async stop() {
      check();
      if (submitted) await api.teams.stop(teamName);
    },
    async processAlive() {
      check();
      return api.teams.processAlive(teamName);
    },
    async launchTeam(request: Parameters<ElectronAPI['teams']['launchTeam']>[0]) {
      check();
      if (
        relaunchAttempted ||
        request.teamName !== teamName ||
        request.cwd !== projectPath ||
        request.providerId !== 'opencode'
      )
        throw new Error('same owned team relaunch required');
      relaunchAttempted = true;
      // A confirmed TEST app restart creates a fresh renderer adapter. Recover
      // the stopped team's persisted run identity through the normal API.
      if (!runId) {
        const retained = await api.teams.getTeamAgentRuntime(teamName);
        if (!retained.runId || (await api.teams.processAlive(teamName))) {
          throw new Error('retained stopped TEST run required');
        }
        runId = retained.runId;
      }
      const previous = runId;
      submitted = true;
      launchPending = true;
      progress.length = 0;
      const result = await api.teams.launchTeam(request);
      if (result.runId === previous) throw new Error('fresh run identity required');
      runId = result.runId;
      progress.push(...pendingProgress.filter((value) => value.runId === runId));
      pendingProgress.length = 0;
      launchPending = false;
      return result;
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        unsubscribe();
      }
    },
  };
}
